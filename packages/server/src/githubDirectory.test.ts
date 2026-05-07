import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MeetingState } from '@tcq/shared';
import {
  searchUsers,
  resolvePresenterFromDirectory,
  warmDirectoryForUser,
  setFetchForTesting,
  resetDirectoryForTesting,
} from './githubDirectory.js';
import type { SessionUser } from './session.js';

/**
 * Build a SessionUser-shaped object inline. Keep tests close to the
 * production type without bringing in the toSessionUser helper, which
 * resolves admin status from env vars and would couple test ordering.
 */
function makeSession(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    ghid: 1,
    ghUsername: 'searcher',
    name: 'Searcher',
    organisation: '',
    isAdmin: false,
    accessToken: 'token-searcher',
    ...overrides,
  };
}

/**
 * Minimal MeetingState fixture. We only consume `users` from the meeting
 * inside the directory module, so the rest can be left as defaults.
 */
function makeMeeting(users: Record<string, { ghid: number; ghUsername: string; name: string }>): MeetingState {
  return {
    id: 'm1',
    createdAt: new Date().toISOString(),
    participantIds: [],
    users: Object.fromEntries(
      Object.entries(users).map(([key, u]) => [key, { ...u, organisation: '' }]),
    ) as MeetingState['users'],
    chairIds: [],
    agenda: [],
    queue: { entries: {}, orderedIds: [], closed: false },
    current: { topicSpeakers: [] },
    operational: { lastConnectionTime: '', maxConcurrent: 0, version: 0 },
  };
}

/** Build a minimal Response-like object the module's fetch hook can return. */
function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Build a GraphQL response for the OrgMembers query. Mirrors the shape
 * the production code expects: a single page (hasNextPage=false) of
 * member nodes.
 */
function graphqlMembersResponse(
  members: Array<{
    databaseId: number;
    login: string;
    name?: string | null;
    company?: string | null;
    avatarUrl: string;
  }>,
) {
  return jsonResponse({
    data: {
      organization: {
        membersWithRole: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: members.map((m) => ({
            databaseId: m.databaseId,
            login: m.login,
            name: m.name ?? null,
            company: m.company ?? null,
            avatarUrl: m.avatarUrl,
          })),
        },
      },
    },
  });
}

/**
 * Mirror of the directory's match check: returns true when `q` matches
 * `login`, `name`, or `organisation` by exact / prefix / substring /
 * subsequence (case-insensitive). Tests use this to assert "every result
 * scores against the query" without coupling to specific match-class
 * weights or to whether a particular hit was substring vs subsequence.
 */
function matchesQuery(q: string, login: string, name: string, organisation: string): boolean {
  const ql = q.toLowerCase();
  const fields = [login.toLowerCase(), name.toLowerCase(), organisation.toLowerCase()];
  for (const f of fields) {
    if (f.length === 0) continue;
    if (f === ql || f.startsWith(ql) || f.includes(ql)) return true;
    let i = 0;
    for (let j = 0; j < f.length && i < ql.length; j++) if (f[j] === ql[i]) i++;
    if (i === ql.length) return true;
  }
  return false;
}

/**
 * Inspect a GraphQL POST body and route based on the `org` variable so a
 * single fetch hook can answer multiple orgs in one test.
 */
async function readGraphqlOrg(init: RequestInit | undefined): Promise<string | undefined> {
  if (!init?.body) return undefined;
  try {
    const parsed = JSON.parse(init.body as string) as { variables?: { org?: string } };
    return parsed.variables?.org;
  } catch {
    return undefined;
  }
}

describe('githubDirectory', () => {
  let restoreFetch: () => void = () => {};
  // Wrap real OAuth-on so the searchUsers function takes the real-mode branch
  // rather than the mock-auth seed-list branch.
  const originalClientId = process.env.GITHUB_CLIENT_ID;

  beforeEach(() => {
    process.env.GITHUB_CLIENT_ID = 'test-client-id';
    resetDirectoryForTesting();
  });

  afterEach(() => {
    restoreFetch();
    if (originalClientId === undefined) delete process.env.GITHUB_CLIENT_ID;
    else process.env.GITHUB_CLIENT_ID = originalClientId;
  });

  describe('warmDirectoryForUser', () => {
    it('fetches the user orgs then each org members via GraphQL', async () => {
      const restCalls: string[] = [];
      const graphqlOrgs: string[] = [];
      restoreFetch = setFetchForTesting(async (url, init) => {
        if (url === 'https://api.github.com/graphql') {
          const org = await readGraphqlOrg(init);
          if (org) graphqlOrgs.push(org);
          if (org === 'tc39') {
            return graphqlMembersResponse([{ databaseId: 10, login: 'alice', avatarUrl: 'a.png' }]);
          }
          if (org === 'wintercg') {
            return graphqlMembersResponse([{ databaseId: 20, login: 'bob', avatarUrl: 'b.png' }]);
          }
          throw new Error(`unexpected GraphQL org: ${org}`);
        }
        restCalls.push(url);
        if (url.endsWith('/user/orgs?per_page=100')) {
          return jsonResponse([{ login: 'tc39' }, { login: 'wintercg' }]);
        }
        throw new Error(`unexpected url: ${url}`);
      });

      await warmDirectoryForUser(makeSession());

      // The org list comes first via REST, the per-org member queries via GraphQL.
      expect(restCalls[0]).toContain('/user/orgs');
      expect(graphqlOrgs.sort()).toEqual(['tc39', 'wintercg']);
    });

    it('drops the access token on a 401 from /user/orgs and stops further calls', async () => {
      const session = makeSession();
      restoreFetch = setFetchForTesting(async (url) => {
        if (url.endsWith('/user/orgs?per_page=100')) {
          return jsonResponse({ message: 'Bad credentials' }, { status: 401 });
        }
        throw new Error(`unexpected url after 401: ${url}`);
      });

      await warmDirectoryForUser(session);
      // Token cleared in place — next request behaves as if unauthenticated.
      expect(session.accessToken).toBeUndefined();
    });

    it('does nothing when the session has no access token', async () => {
      const fetchMock = vi.fn();
      restoreFetch = setFetchForTesting(fetchMock as never);
      await warmDirectoryForUser(makeSession({ accessToken: undefined }));
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('searchUsers', () => {
    /** Wires up a complete cache for a searcher in tc39 + wintercg. */
    async function seedCacheFor(session: SessionUser) {
      restoreFetch = setFetchForTesting(async (url, init) => {
        if (url === 'https://api.github.com/graphql') {
          const org = await readGraphqlOrg(init);
          if (org === 'tc39') {
            return graphqlMembersResponse([
              { databaseId: 100, login: 'alice', name: 'Alice Anderson', company: 'Acme', avatarUrl: 'a.png' },
              { databaseId: 101, login: 'allison', name: 'Allison Brown', company: 'Bumble', avatarUrl: 'b.png' },
            ]);
          }
          if (org === 'wintercg') {
            return graphqlMembersResponse([
              { databaseId: 200, login: 'wendy', name: 'Wendy', company: 'Wing', avatarUrl: 'w.png' },
            ]);
          }
          throw new Error(`unexpected GraphQL org: ${org}`);
        }
        if (url.endsWith('/user/orgs?per_page=100')) {
          return jsonResponse([{ login: 'tc39' }, { login: 'wintercg' }]);
        }
        throw new Error(`unexpected url: ${url}`);
      });
      await warmDirectoryForUser(session);
    }

    it('synthesises tier-1 avatar URLs from the login (works for mock-auth ghids)', async () => {
      const session = makeSession();
      // No org cache — searcher has no orgs, so tier 2 returns nothing.
      restoreFetch = setFetchForTesting(async (url) => {
        if (url.endsWith('/user/orgs?per_page=100')) return jsonResponse([]);
        if (url.includes('/search/users')) return jsonResponse({ items: [] });
        throw new Error(`unexpected: ${url}`);
      });

      // A meeting user with a hashed ghid (the shape mock-auth produces) —
      // the avatar URL must be derived from the login, not the fake ghid,
      // otherwise github.com/avatars/u/{fakeId} 404s.
      const meeting = makeMeeting({
        admin: { ghid: 9999999, ghUsername: 'admin', name: 'Admin' },
      });
      const results = await searchUsers(session, 'adm', meeting, 5);
      expect(results).toHaveLength(1);
      expect(results[0].avatarUrl).toBe('https://github.com/admin.png?size=80');
    });

    it('returns meeting users (tier 1) before org members (tier 2)', async () => {
      const session = makeSession();
      await seedCacheFor(session);

      const meeting = makeMeeting({
        alice: { ghid: 999, ghUsername: 'alice', name: 'Alice In Meeting' },
      });
      const results = await searchUsers(session, 'al', meeting, 5);

      // The meeting copy of alice (ghid 999, badge 'meeting') wins over the
      // org copy (ghid 100, badge 'org') because tier 1 takes precedence.
      // Allison should still appear from tier 2.
      expect(results.map((r) => r.login)).toEqual(['alice', 'allison']);
      expect(results[0].badge).toBe('meeting');
      expect(results[1].badge).toBe('org');
    });

    it('only consults cached members of orgs the searcher belongs to (ACL)', async () => {
      // Searcher belongs to no orgs — but tc39 cache exists from a prior user.
      // The search must NOT surface tc39 members to this searcher.
      const seeder = makeSession({ ghid: 99, ghUsername: 'seeder' });
      await seedCacheFor(seeder);

      // The actual searcher has a separate session with no orgs in cache.
      const searcher = makeSession({ ghid: 1, ghUsername: 'searcher', accessToken: 'tok2' });
      // Stub fetch to *only* answer the searcher's own /user/orgs (returning
      // an empty list) and refuse anything else — proves no other call happens
      // because the org member candidates are filtered to the empty set.
      let userOrgsCalled = false;
      restoreFetch = setFetchForTesting(async (url) => {
        if (url.endsWith('/user/orgs?per_page=100')) {
          userOrgsCalled = true;
          return jsonResponse([]);
        }
        // q=al in:login → tier-3 search. Returns empty so result list stays empty.
        if (url.includes('/search/users')) {
          return jsonResponse({ items: [] });
        }
        throw new Error(`unexpected url: ${url}`);
      });

      const results = await searchUsers(searcher, 'al', undefined, 5);
      expect(results).toEqual([]);
      // The lazy-warm should have triggered the user-orgs lookup.
      // It runs in the background (not awaited inside searchUsers) so we
      // give the microtask queue a tick to settle.
      await new Promise((r) => setTimeout(r, 10));
      expect(userOrgsCalled).toBe(true);
    });

    it('falls through to tier 3 (/search/users) when tiers 1+2 produce fewer than limit', async () => {
      const session = makeSession();
      await seedCacheFor(session);

      restoreFetch = setFetchForTesting(async (url) => {
        if (url.includes('/search/users')) {
          return jsonResponse({
            items: [
              // Overlap with tier 2 — must be deduped out so the dropdown can
              // still fill from the next tier-3 hit.
              { id: 100, login: 'alice', avatar_url: 'a.png' },
              { id: 300, login: 'allen', avatar_url: 'al.png' },
            ],
          });
        }
        throw new Error(`unexpected url after warm: ${url}`);
      });

      const results = await searchUsers(session, 'al', undefined, 3);
      // tier 2: alice (100), allison (101) → 2 hits, less than limit 3.
      // tier 3 returns alice (dup) + allen → only allen survives dedup.
      expect(results.map((r) => r.login)).toEqual(['alice', 'allison', 'allen']);
    });

    it('skips tier 3 when tiers 1+2 already meet the limit', async () => {
      const session = makeSession();
      await seedCacheFor(session);

      let searchCalled = false;
      restoreFetch = setFetchForTesting(async (url) => {
        if (url.includes('/search/users')) {
          searchCalled = true;
          return jsonResponse({ items: [] });
        }
        throw new Error(`unexpected: ${url}`);
      });

      const results = await searchUsers(session, 'al', undefined, 1);
      expect(results.map((r) => r.login)).toEqual(['alice']);
      expect(searchCalled).toBe(false);
    });

    it('drops the access token and returns empty when /search/users returns 401', async () => {
      const session = makeSession();
      await seedCacheFor(session);
      // Above warmed the cache — verify token was set, then make the next
      // search call return 401 and confirm the token gets cleared.
      expect(session.accessToken).toBe('token-searcher');

      restoreFetch = setFetchForTesting(async (url) => {
        if (url.includes('/search/users')) {
          return jsonResponse({ message: 'Bad credentials' }, { status: 401 });
        }
        throw new Error(`unexpected: ${url}`);
      });

      // Use a query that won't match cached members so tier 3 must run.
      const results = await searchUsers(session, 'zzz', undefined, 5);
      expect(results).toEqual([]);
      expect(session.accessToken).toBeUndefined();
    });

    it('matches case-insensitively across query and stored login/name', async () => {
      const session = makeSession();
      // Seed an org cache containing mixed-case logins and names.
      restoreFetch = setFetchForTesting(async (url, init) => {
        if (url === 'https://api.github.com/graphql') {
          const org = await readGraphqlOrg(init);
          if (org === 'tc39') {
            return graphqlMembersResponse([
              { databaseId: 1, login: 'AliceSmith', avatarUrl: 'a.png' },
              { databaseId: 2, login: 'bob-jones', avatarUrl: 'b.png' },
            ]);
          }
          throw new Error(`unexpected: ${org}`);
        }
        if (url.endsWith('/user/orgs?per_page=100')) {
          return jsonResponse([{ login: 'tc39' }]);
        }
        throw new Error(`unexpected: ${url}`);
      });
      await warmDirectoryForUser(session);

      // Stub /search/users so tier 3 doesn't crash on a fall-through.
      restoreFetch = setFetchForTesting(async (url) => {
        if (url.includes('/search/users')) return jsonResponse({ items: [] });
        throw new Error(`unexpected: ${url}`);
      });

      // Uppercase query against lowercase storage.
      const upperToLower = await searchUsers(session, 'BOB', undefined, 5);
      expect(upperToLower.map((r) => r.login)).toEqual(['bob-jones']);

      // Lowercase query against mixed-case storage.
      const lowerToMixed = await searchUsers(session, 'alice', undefined, 5);
      expect(lowerToMixed.map((r) => r.login)).toEqual(['AliceSmith']);
    });

    it('matches a space-separated query against a camel-case login', async () => {
      // Real-world case: a typist enters "Samina Husein" but the GitHub
      // login is "SaminaHusein" (no space). The matcher must strip
      // whitespace from both sides so the query still hits — otherwise
      // the space character has no counterpart in the login and even
      // subsequence matching fails.
      const session = makeSession();
      restoreFetch = setFetchForTesting(async (url, init) => {
        if (url === 'https://api.github.com/graphql') {
          const org = await readGraphqlOrg(init);
          if (org === 'tc39') {
            return graphqlMembersResponse([
              { databaseId: 1, login: 'SaminaHusein', name: 'Samina Husein', avatarUrl: 's.png' },
            ]);
          }
          throw new Error(`unexpected: ${org}`);
        }
        if (url.endsWith('/user/orgs?per_page=100')) {
          return jsonResponse([{ login: 'tc39' }]);
        }
        throw new Error(`unexpected: ${url}`);
      });
      await warmDirectoryForUser(session);

      restoreFetch = setFetchForTesting(async (url) => {
        if (url.includes('/search/users')) return jsonResponse({ items: [] });
        throw new Error(`unexpected: ${url}`);
      });

      // Title-cased query with an internal space — the form a user is
      // most likely to type when they know the display name.
      const titled = await searchUsers(session, 'Samina Husein', undefined, 5);
      expect(titled.map((r) => r.login)).toEqual(['SaminaHusein']);

      // Lowercase + space — both axes of normalisation working together.
      const lower = await searchUsers(session, 'samina husein', undefined, 5);
      expect(lower.map((r) => r.login)).toEqual(['SaminaHusein']);

      // Regression guard: the no-space form must keep working.
      const collapsed = await searchUsers(session, 'saminahusein', undefined, 5);
      expect(collapsed.map((r) => r.login)).toEqual(['SaminaHusein']);
    });

    it('matches across diacritics in either direction', async () => {
      // Diacritic-insensitive matching: NFD-decompose and strip
      // combining marks on both sides so "José" ↔ "Jose" and
      // "Jurgen" ↔ "Jürgen" are equivalent. Covers the case where the
      // typist can't easily produce the accent, *and* the case where
      // the typed query has the accent but the stored field doesn't.
      const session = makeSession();
      restoreFetch = setFetchForTesting(async (url, init) => {
        if (url === 'https://api.github.com/graphql') {
          const org = await readGraphqlOrg(init);
          if (org === 'tc39') {
            return graphqlMembersResponse([
              { databaseId: 1, login: 'joseperez', name: 'José Pérez', avatarUrl: 'j.png' },
              { databaseId: 2, login: 'jurgenschmidt', name: 'Jurgen Schmidt', avatarUrl: 's.png' },
            ]);
          }
          throw new Error(`unexpected: ${org}`);
        }
        if (url.endsWith('/user/orgs?per_page=100')) {
          return jsonResponse([{ login: 'tc39' }]);
        }
        throw new Error(`unexpected: ${url}`);
      });
      await warmDirectoryForUser(session);

      restoreFetch = setFetchForTesting(async (url) => {
        if (url.includes('/search/users')) return jsonResponse({ items: [] });
        throw new Error(`unexpected: ${url}`);
      });

      // Stored name has accents; typed query has none.
      const ascii = await searchUsers(session, 'Jose Perez', undefined, 5);
      expect(ascii.map((r) => r.login)).toEqual(['joseperez']);

      // Typed query has accent; stored name does not.
      const accented = await searchUsers(session, 'Jürgen', undefined, 5);
      expect(accented.map((r) => r.login)).toEqual(['jurgenschmidt']);

      // Both sides accented (round-trip).
      const both = await searchUsers(session, 'José', undefined, 5);
      expect(both.map((r) => r.login)).toEqual(['joseperez']);
    });

    it('ranks prefix matches above fuzzy (subsequence) matches within a tier', async () => {
      const session = makeSession();
      // Org cache contains:
      //   - alice (login prefix "al")
      //   - kallai (login subsequence "al" — k(a)l(l)ai)
      // Both match the query "al" in the login field, but alice is a
      // prefix match while kallai is only a subsequence; alice must rank
      // first in the same tier.
      restoreFetch = setFetchForTesting(async (url, init) => {
        if (url === 'https://api.github.com/graphql') {
          const org = await readGraphqlOrg(init);
          if (org === 'tc39') {
            return graphqlMembersResponse([
              { databaseId: 1, login: 'kallai', avatarUrl: 'k.png' },
              { databaseId: 2, login: 'alice', avatarUrl: 'a.png' },
            ]);
          }
          throw new Error(`unexpected: ${org}`);
        }
        if (url.endsWith('/user/orgs?per_page=100')) {
          return jsonResponse([{ login: 'tc39' }]);
        }
        throw new Error(`unexpected: ${url}`);
      });
      await warmDirectoryForUser(session);

      restoreFetch = setFetchForTesting(async (url) => {
        if (url.includes('/search/users')) return jsonResponse({ items: [] });
        throw new Error(`unexpected: ${url}`);
      });

      const results = await searchUsers(session, 'al', undefined, 5);
      expect(results.map((r) => r.login)).toEqual(['alice', 'kallai']);
    });

    it('ranks any prefix match above any non-prefix match across fields', async () => {
      const session = makeSession();
      // Two candidates:
      //   - "kappa": login is only a subsequence match for "ali" and the
      //     name "Alice" is an exact prefix match.
      //   - "alibaba": login is a prefix match for "ali"; name has no match.
      // The login-prefix candidate (alibaba) should still beat the
      // name-prefix candidate (kappa) because login outweighs name within
      // a class, but BOTH must beat any subsequence-only candidate.
      restoreFetch = setFetchForTesting(async (url, init) => {
        if (url === 'https://api.github.com/graphql') {
          const org = await readGraphqlOrg(init);
          if (org === 'tc39') {
            return graphqlMembersResponse([
              // login subsequence for "ali" (a-li-ne), name prefix "ali"
              { databaseId: 1, login: 'aline', name: 'Alibaba', avatarUrl: 'a.png' },
              // login prefix for "ali"
              { databaseId: 2, login: 'alibaba', name: 'Zed', avatarUrl: 'b.png' },
              // pure subsequence (no prefix anywhere)
              { databaseId: 3, login: 'xalix', name: 'Xander', avatarUrl: 'c.png' },
            ]);
          }
          throw new Error(`unexpected: ${org}`);
        }
        if (url.endsWith('/user/orgs?per_page=100')) {
          return jsonResponse([{ login: 'tc39' }]);
        }
        throw new Error(`unexpected: ${url}`);
      });
      await warmDirectoryForUser(session);

      restoreFetch = setFetchForTesting(async (url) => {
        if (url.includes('/search/users')) return jsonResponse({ items: [] });
        throw new Error(`unexpected: ${url}`);
      });

      const results = await searchUsers(session, 'ali', undefined, 5);
      // alibaba (login prefix, weight 3) > aline (name prefix, weight 2) >
      // xalix (login subsequence — different class entirely).
      expect(results.map((r) => r.login)).toEqual(['alibaba', 'aline', 'xalix']);
    });

    it('matches against the GitHub `company` field on cached org members', async () => {
      const session = makeSession();
      await seedCacheFor(session);

      restoreFetch = setFetchForTesting(async (url) => {
        if (url.includes('/search/users')) return jsonResponse({ items: [] });
        throw new Error(`unexpected: ${url}`);
      });

      // 'acme' isn't in any login or display name in the seed; the only
      // way it surfaces a result is via the company field on alice.
      const results = await searchUsers(session, 'acme', undefined, 5);
      expect(results.map((r) => r.login)).toContain('alice');
    });

    it('excludes unresolved presenter placeholders (ghid 0) from results', async () => {
      // Agenda import stores presenters whose names didn't bind to a real
      // GitHub user as placeholder rows in meeting.users with ghid: 0.
      // Those placeholders must not surface in autocomplete — they have
      // no real identity to bind to.
      const session = makeSession();
      await seedCacheFor(session);

      restoreFetch = setFetchForTesting(async (url) => {
        if (url.includes('/search/users')) return jsonResponse({ items: [] });
        throw new Error(`unexpected: ${url}`);
      });

      // The meeting holds:
      //   - bob: a normally-resolved meeting user (ghid > 0).
      //   - 'alice anderson': an unresolved placeholder created by agenda
      //     import. Same login (lowercased) as the real org-cached alice
      //     (ghid 100); without the filter, login dedup in mergeTiered
      //     would have the placeholder shadow the real user.
      //   - 'unknown person': an unresolved placeholder with no real
      //     counterpart in any tier — should simply not appear at all.
      const meeting = makeMeeting({
        bob: { ghid: 7, ghUsername: 'bob', name: 'Bob Smith' },
        'alice anderson': { ghid: 0, ghUsername: 'alice anderson', name: 'alice anderson' },
        'unknown person': { ghid: 0, ghUsername: 'unknown person', name: 'unknown person' },
      });

      // Query 'alice' — the placeholder must be filtered out so the real
      // tier-2 alice (ghid 100, badge 'org') is what comes back.
      const aliceResults = await searchUsers(session, 'alice', meeting, 5);
      expect(aliceResults.map((r) => ({ login: r.login, ghid: r.ghid, badge: r.badge }))).toEqual([
        { login: 'alice', ghid: 100, badge: 'org' },
      ]);

      // Query 'unknown' — the placeholder is the only thing that would
      // match; with the filter, no result.
      const unknownResults = await searchUsers(session, 'unknown', meeting, 5);
      expect(unknownResults).toEqual([]);

      // Resolved meeting users still come through normally.
      const bobResults = await searchUsers(session, 'bob', meeting, 5);
      expect(bobResults.map((r) => r.login)).toEqual(['bob']);
    });

    it('skips the empty-query tier-3 call (GitHub rejects q=)', async () => {
      const session = makeSession();
      await seedCacheFor(session);

      let searchCalled = false;
      restoreFetch = setFetchForTesting(async (url) => {
        if (url.includes('/search/users')) {
          searchCalled = true;
          return jsonResponse({ items: [] });
        }
        throw new Error(`unexpected: ${url}`);
      });

      const results = await searchUsers(session, '', undefined, 100);
      // All cached org members come back; no upstream search.
      expect(searchCalled).toBe(false);
      expect(results.map((r) => r.login).sort()).toEqual(['alice', 'allison', 'wendy']);
    });
  });

  describe('mock-auth mode', () => {
    beforeEach(() => {
      delete process.env.GITHUB_CLIENT_ID;
    });

    it('returns matches from the static seed list with no network calls', async () => {
      const fetchMock = vi.fn();
      restoreFetch = setFetchForTesting(fetchMock as never);

      const session = makeSession({ accessToken: undefined });
      const results = await searchUsers(session, 'mike', undefined, 5);

      expect(fetchMock).not.toHaveBeenCalled();
      // Anyone whose login, name, or organisation matches "mike" by
      // exact / prefix / substring / subsequence shows up. We don't pin
      // the exact set because the seed regenerates from the live tc39
      // org — just assert each result actually scores against the query.
      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect(matchesQuery('mike', r.login, r.name, r.organisation)).toBe(true);
      }
    });
  });

  describe('resolvePresenterFromDirectory', () => {
    /**
     * Seed an OAuth-mode org cache for the searcher with two tc39 members:
     *   - alice / Alice Anderson / Acme
     *   - allison / Allison Brown / Bumble
     * so a query like "Alice Anderson" has exactly one tier-2 match while
     * "al" has two.
     */
    async function seedOAuthCache(session: SessionUser) {
      restoreFetch = setFetchForTesting(async (url, init) => {
        if (url === 'https://api.github.com/graphql') {
          const org = await readGraphqlOrg(init);
          if (org === 'tc39') {
            return graphqlMembersResponse([
              { databaseId: 100, login: 'alice', name: 'Alice Anderson', company: 'Acme', avatarUrl: 'a.png' },
              { databaseId: 101, login: 'allison', name: 'Allison Brown', company: 'Bumble', avatarUrl: 'b.png' },
            ]);
          }
          throw new Error(`unexpected GraphQL org: ${org}`);
        }
        if (url.endsWith('/user/orgs?per_page=100')) {
          return jsonResponse([{ login: 'tc39' }]);
        }
        throw new Error(`unexpected url: ${url}`);
      });
      await warmDirectoryForUser(session);
    }

    /**
     * After warming the cache, swap to a fetch hook that fails any
     * `/search/users` call. The resolver must never invoke tier 3, so any
     * call to that URL is a regression.
     */
    function forbidTier3() {
      restoreFetch = setFetchForTesting(async (url) => {
        if (url.includes('/search/users')) {
          throw new Error('tier 3 (/search/users) must not be invoked by the resolver');
        }
        throw new Error(`unexpected url: ${url}`);
      });
    }

    it('returns the sole tier-1 match', async () => {
      const session = makeSession();
      await seedOAuthCache(session);
      forbidTier3();

      const meeting = makeMeeting({
        bob: { ghid: 7, ghUsername: 'bob', name: 'Bob Smith' },
      });
      const hit = resolvePresenterFromDirectory(session, 'Bob Smith', meeting);
      expect(hit).not.toBeNull();
      expect(hit?.login).toBe('bob');
      expect(hit?.badge).toBe('meeting');
    });

    it('returns the sole tier-2 match', async () => {
      const session = makeSession();
      await seedOAuthCache(session);
      forbidTier3();

      // "Alice Anderson" only matches Alice — Allison shares the prefix "al"
      // but not the full display name.
      const hit = resolvePresenterFromDirectory(session, 'Alice Anderson', undefined);
      expect(hit).not.toBeNull();
      expect(hit?.login).toBe('alice');
      expect(hit?.badge).toBe('org');
    });

    it('returns null when zero candidates match', async () => {
      const session = makeSession();
      await seedOAuthCache(session);
      forbidTier3();

      const hit = resolvePresenterFromDirectory(session, 'nonexistent-presenter', undefined);
      expect(hit).toBeNull();
    });

    it('returns null when more than one candidate matches', async () => {
      const session = makeSession();
      await seedOAuthCache(session);
      forbidTier3();

      // Both alice and allison match "al" by login prefix → ambiguous.
      const hit = resolvePresenterFromDirectory(session, 'al', undefined);
      expect(hit).toBeNull();
    });

    it('counts a tier-1 + tier-2 overlap on the same user as one match', async () => {
      const session = makeSession();
      await seedOAuthCache(session);
      forbidTier3();

      // Tier 1: meeting copy of alice (ghid 100, same as the org cache).
      // Tier 2: org copy of alice (ghid 100). mergeTiered dedupes by ghid,
      // so the resolver still sees exactly one match — and it should resolve.
      // We use a query precise enough that allison (the other org member
      // matching "al") doesn't match.
      const meeting = makeMeeting({
        alice: { ghid: 100, ghUsername: 'alice', name: 'Alice Anderson' },
      });
      const hit = resolvePresenterFromDirectory(session, 'Alice Anderson', meeting);
      expect(hit).not.toBeNull();
      expect(hit?.login).toBe('alice');
      // Tier 1 wins on overlap.
      expect(hit?.badge).toBe('meeting');
    });

    it('returns null for empty or whitespace-only queries', async () => {
      const session = makeSession();
      await seedOAuthCache(session);
      forbidTier3();

      expect(resolvePresenterFromDirectory(session, '', undefined)).toBeNull();
      expect(resolvePresenterFromDirectory(session, '   ', undefined)).toBeNull();
    });

    describe('mock-auth mode', () => {
      beforeEach(() => {
        delete process.env.GITHUB_CLIENT_ID;
      });

      it('resolves uniquely against the DEV_USERS seed list with no network calls', async () => {
        const fetchMock = vi.fn();
        restoreFetch = setFetchForTesting(fetchMock as never);

        // "Daniel Ehrenberg" is exactly one DEV_USERS entry (login littledan).
        const session = makeSession({ accessToken: undefined });
        const hit = resolvePresenterFromDirectory(session, 'Daniel Ehrenberg', undefined);

        expect(fetchMock).not.toHaveBeenCalled();
        expect(hit).not.toBeNull();
        expect(hit?.login).toBe('littledan');
      });

      it('returns null when DEV_USERS produces multiple matches', async () => {
        const fetchMock = vi.fn();
        restoreFetch = setFetchForTesting(fetchMock as never);

        // "Daniel" matches at least Daniel Rosenwasser, Daniel Veditz, and
        // Daniel Ehrenberg — 3 hits, far more than 1.
        const session = makeSession({ accessToken: undefined });
        const hit = resolvePresenterFromDirectory(session, 'Daniel', undefined);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(hit).toBeNull();
      });
    });
  });
});
