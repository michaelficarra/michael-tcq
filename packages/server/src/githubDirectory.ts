/**
 * GitHub user directory backing the username autocomplete dropdown.
 *
 * Holds two server-wide caches:
 *   - `orgMembers`: org login → set of members (public + concealed) of that
 *     org. Filled by calling `GET /orgs/{org}/members` with the OAuth token
 *     of any logged-in user who is themselves a member of the org.
 *   - `userOrgs`: user ghid → list of org logins they belong to. Filled by
 *     calling `GET /user/orgs` with that user's OAuth token. Acts as the
 *     ACL when answering autocomplete requests — a searcher can only see
 *     members of orgs they themselves belong to.
 *
 * The cache lives only in process memory. On Cloud Run cold starts each
 * instance pays one refresh per active user; that's acceptable for
 * autocomplete and avoids the persistence and security weight of writing
 * cached membership to Firestore.
 *
 * `searchUsers` answers autocomplete requests in three tiers:
 *   1. Users in the same meeting as the searcher (the meeting's `users`
 *      map). Fuzzy match.
 *   2. Members of orgs the searcher belongs to. Fuzzy match.
 *   3. Global GitHub user search via `/search/users`, only called if the
 *      first two tiers produced fewer than `limit` matches. Capped at
 *      `limit` results so even when every result overlaps with tiers 1/2
 *      after dedup the dropdown can still be filled.
 *
 * Tokens revoked or expired by the user are detected centrally in
 * `githubFetchAs`: any 401 clears the searcher's `accessToken` so we don't
 * keep retrying with a known-bad credential, and the request silently
 * degrades (returns `null`).
 */

import type { MeetingState, User, UserKey } from '@tcq/shared';
import { DEV_USERS, asUserKey } from '@tcq/shared';
import type { SessionUser } from './session.js';
import { isOAuthConfigured } from './mockAuth.js';
import { warning, info, serialiseError } from './logger.js';

/** Compact user record returned by autocomplete and stored in the caches. */
export interface DirectoryUser {
  ghid: number;
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
  members: Map<number, DirectoryUser>;
}

interface UserOrgsCacheEntry {
  fetchedAt: number;
  orgs: string[];
}

/** Directory state — module-scoped so it's shared across all requests. */
const orgMembers = new Map<string, OrgMembersCacheEntry>();
const userOrgs = new Map<number, UserOrgsCacheEntry>();

/**
 * Coalesces concurrent refresh attempts: while one request is already
 * fetching org X (or the org list for user Y), other requests touching the
 * same key just await the same Promise rather than firing a duplicate API
 * call. Cleared when the underlying fetch settles.
 */
const inflightOrgRefresh = new Map<string, Promise<void>>();
const inflightUserOrgsRefresh = new Map<number, Promise<void>>();

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
    warning('github_fetch_failed', { url, error: serialiseError(err), ghUsername: session.ghUsername });
    return null;
  }
  if (res.status === 401) {
    info('github_token_revoked', { ghUsername: session.ghUsername });
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
    warning('github_graphql_failed', { error: serialiseError(err), ghUsername: session.ghUsername });
    return null;
  }
  if (res.status === 401) {
    info('github_token_revoked', { ghUsername: session.ghUsername });
    delete session.accessToken;
    return null;
  }
  if (!res.ok) {
    warning('github_graphql_failed', { status: res.status, ghUsername: session.ghUsername });
    return null;
  }
  const body = (await res.json()) as { data?: T; errors?: unknown };
  if (body.errors) {
    warning('github_graphql_errors', { errors: body.errors, ghUsername: session.ghUsername });
    return null;
  }
  return body.data ?? null;
}

// -- Cache refresh -------------------------------------------------------

function isFresh(fetchedAt: number): boolean {
  return Date.now() - fetchedAt < CACHE_TTL_MS;
}

/**
 * GraphQL query for paginated org membership. Returns members with role
 * (both public and concealed when the caller is a member) and folds in
 * `name` and `company` per node, which the REST `/orgs/{org}/members`
 * endpoint does not expose. Saves us N follow-up `/users/{login}` calls
 * for the display name and company-match data.
 */
const ORG_MEMBERS_QUERY = `
query OrgMembers($org: String!, $cursor: String) {
  organization(login: $org) {
    membersWithRole(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        databaseId
        login
        name
        company
        avatarUrl(size: 80)
      }
    }
  }
}
`;

interface OrgMembersConnection {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: Array<{
    databaseId: number | null;
    login: string;
    name: string | null;
    company: string | null;
    avatarUrl: string;
  }>;
}

interface OrgMembersGraphqlResponse {
  organization: { membersWithRole: OrgMembersConnection } | null;
}

/**
 * Refresh the membership of one org if stale. Uses the GraphQL API to
 * fetch login + databaseId + name + company + avatarUrl in one query per
 * page (versus REST, which only returns login/id/avatar_url and would
 * require N follow-up `/users/{login}` calls to get name and company).
 * The GraphQL endpoint returns concealed members too when the caller is a
 * member of the org. Coalesces concurrent refreshes via `inflightOrgRefresh`.
 */
async function refreshOrgMembers(session: SessionUser, org: string): Promise<void> {
  const existing = orgMembers.get(org);
  if (existing && isFresh(existing.fetchedAt)) return;

  const inflight = inflightOrgRefresh.get(org);
  if (inflight) return inflight;

  const refresh: Promise<void> = (async () => {
    const members = new Map<number, DirectoryUser>();
    let cursor: string | null = null;
    for (let page = 0; page < MAX_ORG_PAGES; page++) {
      const data: OrgMembersGraphqlResponse | null = await githubGraphqlAs<OrgMembersGraphqlResponse>(
        session,
        ORG_MEMBERS_QUERY,
        { org, cursor },
      );
      // null means auth or network failure — preserve any previously cached
      // entry rather than replacing it with an empty set.
      if (!data) return;
      const conn: OrgMembersConnection | undefined = data.organization?.membersWithRole;
      if (!conn) return; // org doesn't exist or is hidden — leave cache as-is
      for (const node of conn.nodes) {
        // databaseId is nullable in the schema only because GitHub no
        // longer guarantees it for ghost users. In practice it's always
        // populated for real org members; skip the rare null.
        if (node.databaseId == null) continue;
        members.set(node.databaseId, {
          ghid: node.databaseId,
          login: node.login,
          name: node.name?.trim() || node.login,
          organisation: node.company?.trim() ?? '',
          avatarUrl: node.avatarUrl,
        });
      }
      if (!conn.pageInfo.hasNextPage) break;
      cursor = conn.pageInfo.endCursor;
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
  const existing = userOrgs.get(session.ghid);
  if (existing && isFresh(existing.fetchedAt)) return;

  const inflight = inflightUserOrgsRefresh.get(session.ghid);
  if (inflight) return inflight;

  const refresh = (async () => {
    // Single page is fine — the limit on user/orgs is rarely above one page.
    const res = await githubFetchAs(session, 'https://api.github.com/user/orgs?per_page=100');
    if (!res || !res.ok) {
      if (res) warning('github_user_orgs_fetch_failed', { ghUsername: session.ghUsername, status: res.status });
      return;
    }
    const data = (await res.json()) as Array<{ login: string }>;
    userOrgs.set(session.ghid, {
      fetchedAt: Date.now(),
      orgs: data.map((o) => o.login),
    });
  })().finally(() => {
    inflightUserOrgsRefresh.delete(session.ghid);
  });

  inflightUserOrgsRefresh.set(session.ghid, refresh);
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
  const orgs = userOrgs.get(session.ghid)?.orgs ?? [];
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
 * Comparisons are case-insensitive *and* whitespace-insensitive: both the
 * query and each field are lowercased and have all whitespace stripped
 * before scoring. This lets a typist enter a real-world display name like
 * "Samina Husein" and still match the camel-case login "SaminaHusein" —
 * stripping both sides also preserves the exact-match boost when the
 * query happens to mirror the stored name verbatim. Tuned for the
 * prefix-style typing pattern in autocomplete dropdowns rather than
 * full-text search.
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

/** Lowercase and strip all whitespace so spaces in typed names don't
 * block matches against camel-case logins (e.g. "Samina Husein" vs
 * "SaminaHusein"). Applied to both sides of every comparison. */
function normaliseForMatch(s: string): string {
  return s.toLowerCase().replaceAll(/\s+/g, '');
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
    out.push({
      ghid: user.ghid,
      login: user.ghUsername,
      name: user.name,
      // Meeting-state User objects carry the company string from when the
      // user was first resolved against GitHub — preserve it so the search
      // can match queries like "google".
      organisation: user.organisation,
      avatarUrl: avatarUrlForLogin(user.ghUsername),
      badge: 'meeting',
    });
  }
  return out;
}

function orgMemberCandidates(searcherGhid: number): DirectoryUser[] {
  const orgs = userOrgs.get(searcherGhid)?.orgs ?? [];
  if (orgs.length === 0) return [];
  // Dedupe across orgs: a user in multiple of the searcher's orgs should
  // only appear once in the candidate pool.
  const byGhid = new Map<number, DirectoryUser>();
  for (const org of orgs) {
    const entry = orgMembers.get(org);
    if (!entry) continue;
    for (const member of entry.members.values()) {
      if (!byGhid.has(member.ghid)) byGhid.set(member.ghid, { ...member, badge: 'org' });
    }
  }
  return [...byGhid.values()];
}

/**
 * Synthesise the avatar URL from a GitHub login. `github.com/{login}.png`
 * is a public redirect to the user's canonical avatar — works for any
 * valid login regardless of how the meeting-state ghid was derived. This
 * matters in mock-auth mode, where the meeting-user ghid is a hash of the
 * username rather than the real GitHub numeric id, so a ghid-based URL
 * (`avatars.githubusercontent.com/u/{ghid}`) would 404.
 */
function avatarUrlForLogin(login: string): string {
  return `https://github.com/${encodeURIComponent(login)}.png?size=80`;
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
  const data = (await res.json()) as { items?: Array<{ id: number; login: string; avatar_url: string }> };
  if (!data.items) return [];
  return data.items.map((item) => ({
    ghid: item.id,
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
  const tier2Candidates = isOAuthConfigured()
    ? orgMemberCandidates(session.ghid)
    : DEV_USERS.map<DirectoryUser>((u) => ({
        ghid: u.ghid,
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
  if (!isOAuthConfigured()) {
    return searchUsersLocal(session, query, meeting, limit);
  }

  // Stale caches → kick off a refresh in the background, but answer this
  // request from whatever we have right now. The next request after the
  // refresh settles will see the fresh data.
  const userOrgsEntry = userOrgs.get(session.ghid);
  if (!userOrgsEntry || !isFresh(userOrgsEntry.fetchedAt)) {
    warmDirectoryForUser(session).catch((err) => {
      warning('directory_lazy_warm_failed', { error: serialiseError(err), ghUsername: session.ghUsername });
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
 * Concatenate tiers in order, dedupe by ghid AND by lowercase login
 * (first tier wins), truncate to `limit`. The login fallback matters when
 * a meeting-state user record predates an org-cache refresh and the same
 * login ends up with two differing ghids — the dropdown should still show
 * one row, with tier 1's record (the locally-known one) winning.
 */
function mergeTiered(tiers: DirectoryUser[][], limit: number): DirectoryUser[] {
  const seenGhid = new Set<number>();
  const seenLogin = new Set<string>();
  const out: DirectoryUser[] = [];
  for (const tier of tiers) {
    for (const user of tier) {
      const lLogin = user.login.toLowerCase();
      if (seenGhid.has(user.ghid) || seenLogin.has(lLogin)) continue;
      seenGhid.add(user.ghid);
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
