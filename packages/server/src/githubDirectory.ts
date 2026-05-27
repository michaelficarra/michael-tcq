/**
 * GitHub user directory backing the username autocomplete dropdown.
 *
 * Holds two server-wide caches:
 *   - `orgMembers`: org login → set of *public* members of that org,
 *     each enriched with display name and company so autocomplete and
 *     agenda import can resolve real-world names that diverge from the
 *     GitHub login. Filled in two steps: REST `GET /orgs/{org}/public_members`
 *     enumerates the public membership (no `read:org` scope needed),
 *     then a batched GraphQL query against `user(login: ...)` fetches
 *     name + company for up to 100 logins per round-trip. Concealed
 *     members are intentionally not surfaced — we don't request
 *     `read:org` and so cannot read them.
 *   - `userOrgs`: searcher account id → list of org logins the user is *publicly* a
 *     member of. Filled by calling `GET /user/orgs` with that user's
 *     OAuth token; without `read:org` this endpoint returns only the
 *     user's public memberships. Acts as the ACL when answering
 *     autocomplete requests — a searcher can only see members of orgs
 *     they themselves are a public member of.
 *
 * The cache lives only in process memory. On every container restart each
 * instance pays one refresh per active user; that's acceptable for
 * autocomplete and avoids the persistence and security weight of writing
 * cached membership to Firestore.
 *
 * `searchUsers` answers autocomplete requests in three tiers:
 *   1. Users in the same meeting as the searcher (the meeting's `users`
 *      map). Fuzzy match.
 *   2. Public members of orgs the searcher publicly belongs to. Fuzzy match.
 *   3. Global GitHub user search via `/search/users`, only called if the
 *      first two tiers produced fewer than `limit` matches. Capped at
 *      `limit` results so even when every result overlaps with tiers 1/2
 *      after dedup the dropdown can still be filled.
 *
 * Tokens revoked or expired by the user are detected centrally in
 * `githubFetchAs` / `githubGraphqlAs`: any 401 clears the searcher's
 * `accessToken` so we don't keep retrying with a known-bad credential,
 * and the request silently degrades (returns `null`).
 */

import type { MeetingState, User, UserKey } from '@tcq/shared';
import { DEV_USERS, asUserKey } from '@tcq/shared';
import type { SessionUser } from './session.js';
import { isGitHubConfigured } from './auth/githubUser.js';
import { warning, info, serialiseError } from './logger.js';

/** Compact user record returned by autocomplete and stored in the caches. */
export interface DirectoryUser {
  /** GitHub login. Doubles as the dedup/identity key (lowercased) within the
   *  directory and as the value the client submits for chair/presenter entry. */
  login: string;
  name: string;
  /**
   * GitHub `company` field if known. Searched against alongside login and
   * name. Empty string when unknown (tiers 2 and 3 don't include it on the
   * data the GitHub list/search endpoints return).
   */
  organisation: string;
  avatarUrl: string;
  /** Source tier — used by the client to render an optional "in this meeting" / "org" badge. */
  badge?: 'meeting' | 'org';
}

interface OrgMembersCacheEntry {
  fetchedAt: number;
  /** Members keyed by lowercased login. */
  members: Map<string, DirectoryUser>;
}

interface UserOrgsCacheEntry {
  fetchedAt: number;
  orgs: string[];
}

/** Directory state — module-scoped so it's shared across all requests. */
const orgMembers = new Map<string, OrgMembersCacheEntry>();
/** Keyed by the searcher's account id (lowercased GitHub login). */
const userOrgs = new Map<string, UserOrgsCacheEntry>();

/**
 * Coalesces concurrent refresh attempts: while one request is already
 * fetching org X (or the org list for user Y), other requests touching the
 * same key just await the same Promise rather than firing a duplicate API
 * call. Cleared when the underlying fetch settles.
 */
const inflightOrgRefresh = new Map<string, Promise<void>>();
const inflightUserOrgsRefresh = new Map<string, Promise<void>>();

/** TTL for both caches — re-fetched on the next request after this elapses. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 h

/** Soft cap on members fetched per org. 100/page × 10 pages = 1000. */
const MAX_ORG_PAGES = 10;

/** Default dropdown size when callers don't pass a `limit`. */
export const DEFAULT_AUTOCOMPLETE_LIMIT = 10;

// -- Test seam -----------------------------------------------------------
//
// Vitest replaces `globalThis.fetch` per-test in many places; expose a
// settable hook so unit tests can install a deterministic stand-in for the
// fetch used by *this* module without having to monkey-patch globals.
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: FetchLike = (input, init) => fetch(input, init);

/** Replace the fetch implementation. Returns a restorer. */
export function setFetchForTesting(impl: FetchLike): () => void {
  const previous = fetchImpl;
  fetchImpl = impl;
  return () => {
    fetchImpl = previous;
  };
}

/** Reset all module state. Tests only. */
export function resetDirectoryForTesting(): void {
  orgMembers.clear();
  userOrgs.clear();
  inflightOrgRefresh.clear();
  inflightUserOrgsRefresh.clear();
}

// -- Token-aware fetch ---------------------------------------------------

/**
 * Call a GitHub API endpoint as the given session user. On 401 (token
 * revoked, expired, or app uninstalled), clear `session.accessToken` so we
 * don't retry the next request with a known-bad credential, log the event,
 * and return `null`. Callers treat `null` as "no data; degrade silently".
 */
async function githubFetchAs(session: SessionUser, url: string): Promise<Response | null> {
  if (!session.accessToken) return null;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        Accept: 'application/vnd.github+json',
      },
    });
  } catch (err) {
    warning('github_fetch_failed', { url, error: serialiseError(err), account: session.accountId });
    return null;
  }
  if (res.status === 401) {
    info('github_token_revoked', { account: session.accountId });
    // Mutate in place — the caller still holds the same SessionUser
    // reference because Express session reads are reference-stable per
    // request, and the next persistence write (express-session
    // resave-on-touch / our explicit res.json paths) will flush the
    // cleared token to the store.
    delete session.accessToken;
    return null;
  }
  return res;
}

/**
 * POST a GraphQL query to GitHub on the user's behalf. Same revocation
 * handling as `githubFetchAs`. Returns the parsed `data` payload on
 * success, `null` on auth/network failure or a GraphQL `errors` response.
 */
async function githubGraphqlAs<T>(
  session: SessionUser,
  query: string,
  variables: Record<string, unknown>,
): Promise<T | null> {
  if (!session.accessToken) return null;
  let res: Response;
  try {
    res = await fetchImpl('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/vnd.github+json',
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (err) {
    warning('github_graphql_failed', { error: serialiseError(err), account: session.accountId });
    return null;
  }
  if (res.status === 401) {
    info('github_token_revoked', { account: session.accountId });
    delete session.accessToken;
    return null;
  }
  if (!res.ok) {
    warning('github_graphql_failed', { status: res.status, account: session.accountId });
    return null;
  }
  const body = (await res.json()) as { data?: T; errors?: unknown };
  if (body.errors) {
    warning('github_graphql_errors', { errors: body.errors, account: session.accountId });
    return null;
  }
  return body.data ?? null;
}

// -- Cache refresh -------------------------------------------------------

function isFresh(fetchedAt: number): boolean {
  return Date.now() - fetchedAt < CACHE_TTL_MS;
}

/**
 * Shape of one entry in the `/orgs/{org}/public_members` REST response.
 * The endpoint returns the standard `SimpleUser` object; the directory
 * only needs id, login, and avatar_url here. Display name and company are
 * filled in by a follow-up GraphQL enrichment query.
 */
interface PublicMemberRest {
  id: number;
  login: string;
  avatar_url: string;
}

/** Per-login enrichment result from the batched GraphQL `user(login: ...)` query. */
interface EnrichedUserNode {
  databaseId: number | null;
  login: string;
  name: string | null;
  company: string | null;
}

/**
 * Maximum logins enriched in one GraphQL request. The alias pattern below
 * generates one field per login; GitHub's GraphQL API caps total node count
 * per request well above this, and keeping the batch at 100 keeps each
 * request a similar shape to a single REST page.
 */
const ENRICH_BATCH_SIZE = 100;

/**
 * GitHub usernames are 1–39 characters of alphanumerics-or-hyphen (no
 * leading or trailing hyphen, no consecutive hyphens). The character set
 * is what matters for safe interpolation into a GraphQL string literal —
 * the regex below is intentionally a permissive superset (allowing
 * leading/consecutive hyphens) because the only goal here is to keep the
 * GraphQL syntactically valid. Anything failing the regex is skipped
 * silently; the public_members data we already have for that user stays.
 */
const SAFE_LOGIN_FOR_GRAPHQL = /^[A-Za-z0-9-]{1,39}$/;

/**
 * Enrich a list of GitHub logins with display name + company via one or
 * more batched GraphQL queries. Each request looks like:
 *
 *   query { u0: user(login: "alice") { databaseId login name company }
 *           u1: user(login: "bob")   { databaseId login name company } ... }
 *
 * which fetches up to `ENRICH_BATCH_SIZE` users in a single HTTP round-trip.
 * Returns a Map keyed by lowercased login; missing entries (404s, deleted
 * users, validation failures) are simply absent and the caller falls back
 * to the basic info it already had.
 */
async function enrichLoginsWithNameAndCompany(
  session: SessionUser,
  logins: string[],
): Promise<Map<string, EnrichedUserNode>> {
  const out = new Map<string, EnrichedUserNode>();
  for (let i = 0; i < logins.length; i += ENRICH_BATCH_SIZE) {
    const batch = logins.slice(i, i + ENRICH_BATCH_SIZE).filter((l) => SAFE_LOGIN_FOR_GRAPHQL.test(l));
    if (batch.length === 0) continue;
    const aliases = batch
      .map((login, idx) => `u${idx}: user(login: "${login}") { databaseId login name company }`)
      .join('\n  ');
    const query = `query { ${aliases} }`;
    // No variables — the aliases above are statically generated and the
    // login values are character-set-validated, so direct interpolation
    // is safe and avoids the need for dynamic variable declarations.
    const data = await githubGraphqlAs<Record<string, EnrichedUserNode | null>>(session, query, {});
    if (!data) continue; // network / auth / GraphQL-errors failure — keep what we have
    for (const node of Object.values(data)) {
      if (node) out.set(node.login.toLowerCase(), node);
    }
  }
  return out;
}

/**
 * Refresh the public membership of one org if stale.
 *
 * Step 1: REST `GET /orgs/{org}/public_members` paginated with
 *   `?per_page=100&page=N`. Yields login + numeric id + avatar URL for
 *   each public member. Stops when a page comes back shorter than
 *   `per_page` (the canonical "no more pages" signal for GitHub's
 *   offset-paginated list endpoints) or when we hit `MAX_ORG_PAGES`.
 *
 * Step 2: batched GraphQL enrichment via `user(login: ...)` aliases —
 *   ~one HTTP round-trip per 100 members — to fill in display name and
 *   company. These would otherwise require an N+1 set of REST
 *   `/users/{login}` calls.
 *
 * Coalesces concurrent refreshes for the same org via `inflightOrgRefresh`.
 */
async function refreshOrgMembers(session: SessionUser, org: string): Promise<void> {
  const existing = orgMembers.get(org);
  if (existing && isFresh(existing.fetchedAt)) return;

  const inflight = inflightOrgRefresh.get(org);
  if (inflight) return inflight;

  const refresh: Promise<void> = (async () => {
    // Step 1: enumerate the org's public members.
    const basic: PublicMemberRest[] = [];
    const PER_PAGE = 100;
    for (let page = 1; page <= MAX_ORG_PAGES; page++) {
      const res = await githubFetchAs(
        session,
        `https://api.github.com/orgs/${encodeURIComponent(org)}/public_members?per_page=${PER_PAGE}&page=${page}`,
      );
      // null means auth or network failure — preserve any previously cached
      // entry rather than replacing it with an empty set.
      if (!res) return;
      // 404 means the org doesn't exist (or has no public-members listing
      // at all). Leave any previously cached entry untouched.
      if (res.status === 404) return;
      if (!res.ok) {
        warning('github_org_members_fetch_failed', {
          org,
          status: res.status,
          account: session.accountId,
        });
        return;
      }
      const data = (await res.json()) as PublicMemberRest[];
      basic.push(...data);
      // Short page → last page. The `data.length === 0` case is the
      // empty-org degenerate path (no public members at all) and also
      // exits cleanly here.
      if (data.length < PER_PAGE) break;
    }

    // Step 2: enrich each member with display name + company in batches.
    const enriched = await enrichLoginsWithNameAndCompany(
      session,
      basic.map((m) => m.login),
    );

    const members = new Map<string, DirectoryUser>();
    for (const m of basic) {
      const e = enriched.get(m.login.toLowerCase());
      members.set(m.login.toLowerCase(), {
        login: m.login,
        // `||` (not `??`) so a whitespace-only `name` from GitHub also
        // falls through to the login — same defensive shape used by
        // `fetchGitHubUser`.
        name: e?.name?.trim() || m.login,
        organisation: e?.company?.trim() ?? '',
        // Use the URL the REST API hands back directly — same as tier 3 does
        // for `/search/users` results. No size suffix; the CSS sizes it.
        avatarUrl: m.avatar_url,
      });
    }
    orgMembers.set(org, { fetchedAt: Date.now(), members });
  })().finally(() => {
    inflightOrgRefresh.delete(org);
  });

  inflightOrgRefresh.set(org, refresh);
  return refresh;
}

/**
 * Refresh the org list for a single user if stale. Coalesces concurrent
 * refreshes via `inflightUserOrgsRefresh`.
 */
async function refreshUserOrgs(session: SessionUser): Promise<void> {
  const existing = userOrgs.get(session.accountId);
  if (existing && isFresh(existing.fetchedAt)) return;

  const inflight = inflightUserOrgsRefresh.get(session.accountId);
  if (inflight) return inflight;

  const refresh = (async () => {
    // Single page is fine — the limit on user/orgs is rarely above one page.
    // Without `read:org` this endpoint returns only the user's *public*
    // org memberships, which is exactly the ACL we want for the
    // reduced-permission directory (a searcher can see members of orgs
    // they publicly belong to, and only those).
    const res = await githubFetchAs(session, 'https://api.github.com/user/orgs?per_page=100');
    if (!res || !res.ok) {
      if (res) warning('github_user_orgs_fetch_failed', { account: session.accountId, status: res.status });
      return;
    }
    const data = (await res.json()) as Array<{ login: string }>;
    userOrgs.set(session.accountId, {
      fetchedAt: Date.now(),
      orgs: data.map((o) => o.login),
    });
  })().finally(() => {
    inflightUserOrgsRefresh.delete(session.accountId);
  });

  inflightUserOrgsRefresh.set(session.accountId, refresh);
  return refresh;
}

/**
 * Fire-and-forget directory warm for a freshly-logged-in user. Called from
 * the OAuth callback after the session is established. Caller does not
 * await — the redirect lands immediately and this fills the cache in the
 * background. Errors are logged inside the helpers; this function never
 * throws.
 */
export async function warmDirectoryForUser(session: SessionUser): Promise<void> {
  if (!session.accessToken) return;
  await refreshUserOrgs(session);
  const orgs = userOrgs.get(session.accountId)?.orgs ?? [];
  // Refresh org members in parallel — each org is independent and the
  // GitHub primary rate limit (5000/hr/user) is generous.
  await Promise.all(orgs.map((org) => refreshOrgMembers(session, org)));
}

// -- Fuzzy matching ------------------------------------------------------

/**
 * Score a candidate against a normalised query. Higher is better; 0 means
 * no match. The score has two ranks: a *match-class* bucket (exact >
 * prefix > substring > subsequence) that dominates ordering, and within
 * a class a *field weight* (login > name > organisation) that breaks
 * ties. The buckets are spaced so a prefix match in any field always
 * outranks a substring match in any field, and a substring match in any
 * field always outranks a subsequence ("fuzzy") match in any field.
 *
 * Example: typing "al" puts a candidate whose login starts with "al"
 * above a candidate whose login only matches as a subsequence (e.g.
 * `kallai`), even when the latter would otherwise have scored points
 * elsewhere.
 *
 * Comparisons are case-insensitive, whitespace-insensitive, *and*
 * diacritic-insensitive: both the query and each field are lowercased,
 * have all whitespace stripped, and have diacritics removed before
 * scoring. This lets a typist enter a real-world display name like
 * "Samina Husein" and match the camel-case login "SaminaHusein", or
 * type "Jose" and match a stored name "José". Stripping both sides
 * also preserves the exact-match boost when the query happens to
 * mirror the stored name verbatim. Tuned for the prefix-style typing
 * pattern in autocomplete dropdowns rather than full-text search.
 */
const MATCH_CLASS_EXACT = 10000;
const MATCH_CLASS_PREFIX = 1000;
const MATCH_CLASS_SUBSTRING = 100;
const MATCH_CLASS_SUBSEQUENCE = 10;
// Field weights stay strictly less than the gap between adjacent match
// classes (1000 - 100 = 900) so a higher class always beats any field
// boost from a lower class.
const FIELD_WEIGHT_LOGIN = 3;
const FIELD_WEIGHT_NAME = 2;
const FIELD_WEIGHT_ORG = 1;

function scoreField(query: string, field: string, fieldWeight: number): number {
  if (field.length === 0) return 0;
  if (field === query) return MATCH_CLASS_EXACT + fieldWeight;
  if (field.startsWith(query)) return MATCH_CLASS_PREFIX + fieldWeight;
  if (field.includes(query)) return MATCH_CLASS_SUBSTRING + fieldWeight;
  if (subsequenceMatch(query, field)) return MATCH_CLASS_SUBSEQUENCE + fieldWeight;
  return 0;
}

function scoreMatch(query: string, login: string, name: string, organisation: string): number {
  const q = normaliseForMatch(query);
  if (q.length === 0) return 1; // empty query → everyone matches equally
  return Math.max(
    scoreField(q, normaliseForMatch(login), FIELD_WEIGHT_LOGIN),
    scoreField(q, normaliseForMatch(name), FIELD_WEIGHT_NAME),
    scoreField(q, normaliseForMatch(organisation), FIELD_WEIGHT_ORG),
  );
}

/**
 * Normalise a string for fuzzy matching: NFD-decompose, strip
 * diacritics, lowercase, then drop whitespace. Applied to both sides of
 * every comparison so that "José Pérez", "Jose Perez", and "joseperez"
 * all collapse to the same key.
 *
 * The diacritic step uses Unicode Normalization Form D (UAX #15) to
 * split precomposed letters like "é" into "e" + combining acute, then
 * strips characters with the Unicode `Diacritic` binary property
 * (UAX #44). UTS #10 §11 ("Searching and Matching") describes the
 * theoretically correct mechanism — primary-strength UCA comparison
 * via `Intl.Collator({ sensitivity: 'base' })` — but ECMAScript
 * exposes no UCA-aware substring search (no `usearch`), so it is
 * unusable for our prefix/substring/subsequence pipeline. NFD plus
 * `\p{Diacritic}` is the closest standards-grounded approximation that
 * yields a plain string the existing matcher can run on directly.
 *
 * Known limits: doesn't apply locale-specific equivalences like ß↔ss,
 * Æ↔AE, or Turkish ı↔i — those would need full collation tailoring.
 */
function normaliseForMatch(s: string): string {
  return s
    .normalize('NFD')
    .replaceAll(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replaceAll(/\s+/g, '');
}

/** Return true iff every character of `q` appears in `s` in order. */
function subsequenceMatch(q: string, s: string): boolean {
  let i = 0;
  for (let j = 0; j < s.length && i < q.length; j++) {
    if (s[j] === q[i]) i++;
  }
  return i === q.length;
}

/** Return the top-N matches from a candidate list sorted by score desc, ties by login asc. */
function rankMatches(query: string, candidates: DirectoryUser[], limit: number): DirectoryUser[] {
  const scored: Array<{ user: DirectoryUser; score: number }> = [];
  for (const user of candidates) {
    const score = scoreMatch(query, user.login, user.name, user.organisation);
    if (score > 0) scored.push({ user, score });
  }
  scored.sort((a, b) => b.score - a.score || a.user.login.localeCompare(b.user.login));
  return scored.slice(0, limit).map((s) => s.user);
}

// -- Tier collection -----------------------------------------------------

function meetingUserCandidates(meeting: MeetingState | undefined): DirectoryUser[] {
  if (!meeting) return [];
  const out: DirectoryUser[] = [];
  for (const user of Object.values(meeting.users) as User[]) {
    // Only GitHub accounts are autocomplete candidates here (chair/presenter
    // entry is by GitHub handle); skip users from other providers.
    if (user.provider !== 'github') continue;
    // Skip unresolved presenter placeholders. These are written into
    // meeting.users by agenda import when a free-text presenter name
    // doesn't bind to a real GitHub user (see resolvePresenterFromDirectory),
    // and they exist solely so the agenda item can render the name. They
    // have no real identity to autocomplete onto, and including them here
    // would also let them shadow real tier-2 matches via the login dedup
    // in mergeTiered when the agenda is re-imported. A placeholder is the
    // only kind of resolved GitHub user with an empty `avatarUrl`.
    if (user.avatarUrl === '') continue;
    out.push({
      login: user.handle ?? user.accountId,
      name: user.name,
      // Meeting-state User objects carry the company string from when the
      // user was first resolved against GitHub — preserve it so the search
      // can match queries like "google".
      organisation: user.organisation,
      avatarUrl: user.avatarUrl,
      badge: 'meeting',
    });
  }
  return out;
}

function orgMemberCandidates(searcherAccountId: string): DirectoryUser[] {
  const orgs = userOrgs.get(searcherAccountId)?.orgs ?? [];
  if (orgs.length === 0) return [];
  // Dedupe across orgs: a user in multiple of the searcher's orgs should
  // only appear once in the candidate pool. Keyed by lowercased login.
  const byLogin = new Map<string, DirectoryUser>();
  for (const org of orgs) {
    const entry = orgMembers.get(org);
    if (!entry) continue;
    for (const member of entry.members.values()) {
      const k = member.login.toLowerCase();
      if (!byLogin.has(k)) byLogin.set(k, { ...member, badge: 'org' });
    }
  }
  return [...byLogin.values()];
}

// -- Tier 3: global GitHub user search -----------------------------------

async function tier3Search(session: SessionUser, query: string, limit: number): Promise<DirectoryUser[]> {
  if (!session.accessToken) return [];
  // `+in:login` biases the upstream search toward login matches, which is
  // what the dropdown needs. `per_page` is `limit`, not `limit - already`,
  // because tier-3 hits may overlap with tiers 1/2 and get deduped — asking
  // for `limit` lets the dropdown still fill if every hit overlaps.
  const url = `https://api.github.com/search/users?q=${encodeURIComponent(`${query} in:login`)}&per_page=${limit}&page=1`;
  const res = await githubFetchAs(session, url);
  if (!res || !res.ok) return [];
  const data = (await res.json()) as { items?: Array<{ login: string; avatar_url: string }> };
  if (!data.items) return [];
  return data.items.map((item) => ({
    login: item.login,
    // Search results don't include display name or company; degrade to
    // login for the name and leave organisation blank.
    name: item.login,
    organisation: '',
    avatarUrl: item.avatar_url,
  }));
}

// -- Public entry points -------------------------------------------------

/**
 * Tier-1 + tier-2 ranking only. Synchronous — neither candidate source
 * touches the network. Shared by `searchUsers` (which may then escalate
 * to tier 3) and by the agenda-import resolver (which intentionally
 * stops here). Does **not** trigger the background cache refresh; that
 * side-effect is autocomplete-only.
 */
export function searchUsersLocal(
  session: SessionUser,
  query: string,
  meeting: MeetingState | undefined,
  limit: number,
): DirectoryUser[] {
  const tier1 = rankMatches(query, meetingUserCandidates(meeting), limit);

  // Mock-auth mode: tier 2 is backed by the static seed list (acts as
  // the single "org" in dev). In OAuth mode, tier 2 comes from the
  // searcher's org-membership cache.
  const tier2Candidates = isGitHubConfigured()
    ? orgMemberCandidates(session.accountId)
    : DEV_USERS.map<DirectoryUser>((u) => ({
        login: u.login,
        name: u.name,
        organisation: u.organisation ?? '',
        avatarUrl: u.avatarUrl,
        badge: 'org',
      }));
  const tier2 = rankMatches(query, tier2Candidates, limit);

  return mergeTiered([tier1, tier2], limit);
}

/**
 * Answer one autocomplete request. Returns up to `limit` deduped users in
 * tier order: meeting users → org members → global search. Never throws.
 * Background-refreshes any stale caches without blocking the response.
 */
export async function searchUsers(
  session: SessionUser,
  query: string,
  meeting: MeetingState | undefined,
  limit: number = DEFAULT_AUTOCOMPLETE_LIMIT,
): Promise<DirectoryUser[]> {
  // Mock-auth mode: no GitHub calls at all. Tier 3 is skipped entirely.
  if (!isGitHubConfigured()) {
    return searchUsersLocal(session, query, meeting, limit);
  }

  // Stale caches → kick off a refresh in the background, but answer this
  // request from whatever we have right now. The next request after the
  // refresh settles will see the fresh data.
  const userOrgsEntry = userOrgs.get(session.accountId);
  if (!userOrgsEntry || !isFresh(userOrgsEntry.fetchedAt)) {
    warmDirectoryForUser(session).catch((err) => {
      warning('directory_lazy_warm_failed', { error: serialiseError(err), account: session.accountId });
    });
  }

  const preTier3 = searchUsersLocal(session, query, meeting, limit);

  // Skip tier 3 if tiers 1+2 alone (after dedup) already fill the dropdown.
  if (preTier3.length >= limit) return preTier3;

  // Skip tier 3 for empty queries — `/search/users?q=` is rejected by
  // GitHub, and there's no useful "everyone" fallback to surface anyway.
  if (query.trim().length === 0) return preTier3;

  const tier3 = await tier3Search(session, query, limit);
  return mergeTiered([preTier3, tier3], limit);
}

/**
 * Used by agenda import to bind a free-text presenter name to a real
 * user when — and only when — the directory has exactly one tier-1+2
 * match. Tier 3 (global GitHub search) is intentionally skipped: we
 * only auto-bind to people the importer has reason to know.
 */
export function resolvePresenterFromDirectory(
  session: SessionUser,
  query: string,
  meeting: MeetingState | undefined,
): DirectoryUser | null {
  const trimmed = query.trim();
  if (trimmed.length === 0) return null;
  // Ask for two so we can distinguish "exactly one match" from "more than one".
  const results = searchUsersLocal(session, trimmed, meeting, 2);
  return results.length === 1 ? results[0] : null;
}

/**
 * Concatenate tiers in order, dedupe by lowercase login (first tier wins),
 * truncate to `limit`. Login is the identity key throughout the directory,
 * so the same person appearing in multiple tiers (meeting + org + global
 * search) collapses to one row, with the earliest (most locally-known)
 * tier's record winning.
 */
function mergeTiered(tiers: DirectoryUser[][], limit: number): DirectoryUser[] {
  const seenLogin = new Set<string>();
  const out: DirectoryUser[] = [];
  for (const tier of tiers) {
    for (const user of tier) {
      const lLogin = user.login.toLowerCase();
      if (seenLogin.has(lLogin)) continue;
      seenLogin.add(lLogin);
      out.push(user);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

// Re-export so other modules that build UserKey-typed values from a login
// string don't need their own import of asUserKey.
export { asUserKey };
export type { UserKey };
