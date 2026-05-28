import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { MeetingState, User } from '@tcq/shared';
import { userKey } from '@tcq/shared';
import { orcidProvider } from './orcid.js';
import { isOrcidId, normaliseOrcidId, gravatarUrl, orcidUser } from './orcidUser.js';
import { setOrcidFetchForTesting, resetOrcidApiForTesting } from '../orcidApi.js';
import type { SessionUser } from '../session.js';

/** Build a SessionUser inline; the ORCID directory ignores most fields (no
 *  per-user token cache), so a minimal object suffices. */
function makeSession(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    provider: 'orcid',
    accountId: '0000-0000-0000-0001',
    handle: undefined,
    name: 'Searcher',
    organisation: '',
    avatarUrl: '',
    isAdmin: false,
    ...overrides,
  };
}

/** Minimal MeetingState fixture keyed by canonical user key. */
function makeMeeting(users: User[]): MeetingState {
  return {
    id: 'm1',
    createdAt: new Date().toISOString(),
    participantIds: [],
    users: Object.fromEntries(users.map((u) => [userKey(u), u])) as MeetingState['users'],
    chairIds: [],
    agenda: [],
    queue: { entries: {}, orderedIds: [], closed: false },
    current: { topicSpeakers: [] },
    operational: { lastConnectionTime: '', maxConcurrent: 0, version: 0 },
  };
}

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function tokenResponse(token = 'read-public-token'): Response {
  return jsonResponse({ access_token: token, token_type: 'bearer', scope: '/read-public', expires_in: 631_138_518 });
}

describe('orcidUser helpers', () => {
  describe('isOrcidId / normaliseOrcidId', () => {
    it('accepts a bare iD and an orcid.org URL, uppercasing the X checksum', () => {
      expect(isOrcidId('0000-0002-1825-0097')).toBe(true);
      expect(isOrcidId('https://orcid.org/0000-0002-1694-233x')).toBe(true);
      expect(normaliseOrcidId('https://orcid.org/0000-0002-1694-233x')).toBe('0000-0002-1694-233X');
      expect(normaliseOrcidId('  0000-0002-1825-0097  ')).toBe('0000-0002-1825-0097');
    });

    it('rejects non-iD strings', () => {
      expect(isOrcidId('alice')).toBe(false);
      expect(isOrcidId('0000-0002-1825')).toBe(false);
      expect(isOrcidId('0000000218250097')).toBe(false);
    });
  });

  describe('gravatarUrl', () => {
    it('hashes the trimmed, lowercased email with SHA-256 and requests an identicon fallback', () => {
      const email = '  Josiah@Example.edu  ';
      const expected = createHash('sha256').update('josiah@example.edu').digest('hex');
      expect(gravatarUrl(email)).toBe(`https://gravatar.com/avatar/${expected}?d=identicon&s=80`);
    });
  });

  describe('orcidUser', () => {
    it('builds a handle-less user with a real-email Gravatar', () => {
      const user = orcidUser({
        id: '0000-0002-1825-0097',
        name: 'Josiah Carberry',
        email: 'josiah@example.edu',
        organisation: 'Brown University',
      });
      const emailHash = createHash('sha256').update('josiah@example.edu').digest('hex');
      expect(user).toEqual({
        provider: 'orcid',
        accountId: '0000-0002-1825-0097',
        handle: undefined,
        name: 'Josiah Carberry',
        organisation: 'Brown University',
        avatarUrl: `https://gravatar.com/avatar/${emailHash}?d=identicon&s=80`,
      });
    });

    it('falls back to the iD for both the name and the Gravatar seed when no email/name', () => {
      const user = orcidUser({ id: '0000-0002-1825-0097' });
      const idHash = createHash('sha256').update('0000-0002-1825-0097').digest('hex');
      expect(user.name).toBe('0000-0002-1825-0097');
      expect(user.organisation).toBe('');
      expect(user.avatarUrl).toBe(`https://gravatar.com/avatar/${idHash}?d=identicon&s=80`);
    });
  });
});

describe('orcidProvider', () => {
  let restoreFetch: () => void = () => {};
  const origId = process.env.ORCID_CLIENT_ID;
  const origSecret = process.env.ORCID_CLIENT_SECRET;
  const origBase = process.env.ORCID_BASE_URL;

  beforeEach(() => {
    process.env.ORCID_CLIENT_ID = 'cid';
    process.env.ORCID_CLIENT_SECRET = 'secret';
    delete process.env.ORCID_BASE_URL;
    resetOrcidApiForTesting();
  });

  afterEach(() => {
    restoreFetch();
    vi.unstubAllGlobals();
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore('ORCID_CLIENT_ID', origId);
    restore('ORCID_CLIENT_SECRET', origSecret);
    restore('ORCID_BASE_URL', origBase);
  });

  it('reports enabled only when both credentials are present', () => {
    expect(orcidProvider.enabled).toBe(true);
    delete process.env.ORCID_CLIENT_SECRET;
    expect(orcidProvider.enabled).toBe(false);
  });

  describe('authorizationUrl', () => {
    it('targets the configured base with the /authenticate scope and forwarded state', () => {
      const url = new URL(
        orcidProvider.authorizationUrl({ state: 'xyz', redirectUri: 'https://app/auth/orcid/callback' }),
      );
      expect(url.origin + url.pathname).toBe('https://orcid.org/oauth/authorize');
      // `client_id` is captured at module load (like the GitHub provider), so
      // its presence — not its value — is what we assert here.
      expect(url.searchParams.has('client_id')).toBe(true);
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('scope')).toBe('/authenticate');
      expect(url.searchParams.get('redirect_uri')).toBe('https://app/auth/orcid/callback');
      expect(url.searchParams.get('state')).toBe('xyz');
    });

    it('uses the sandbox base when ORCID_BASE_URL is set', () => {
      process.env.ORCID_BASE_URL = 'https://sandbox.orcid.org';
      const url = new URL(orcidProvider.authorizationUrl({ redirectUri: 'https://app/cb' }));
      expect(url.origin).toBe('https://sandbox.orcid.org');
    });
  });

  describe('exchangeCode', () => {
    it('builds the user from the token response, enriched by the public record', async () => {
      // The token POST goes through the global fetch; the public-record lookup
      // goes through the orcidApi seam — stub both.
      const fetchMock = vi.fn(async (url: string) => {
        if (String(url).endsWith('/oauth/token')) {
          return jsonResponse({ access_token: 'user-token', orcid: '0000-0002-1825-0097', name: 'Josiah Carberry' });
        }
        throw new Error(`unexpected global fetch: ${url}`);
      });
      vi.stubGlobal('fetch', fetchMock);

      restoreFetch = setOrcidFetchForTesting(async (url) => {
        if (url.endsWith('/oauth/token')) return tokenResponse();
        if (url.includes('/0000-0002-1825-0097/record')) {
          return jsonResponse({
            person: { emails: { email: [{ email: 'josiah@example.edu' }] } },
            'activities-summary': {
              employments: {
                'affiliation-group': [
                  { summaries: [{ 'employment-summary': { organization: { name: 'Brown University' } } }] },
                ],
              },
            },
          });
        }
        throw new Error(`unexpected pub fetch: ${url}`);
      });

      const profile = await orcidProvider.exchangeCode('the-code', 'https://app/auth/orcid/callback');
      expect(profile).not.toBeNull();
      expect(profile?.accessToken).toBe('user-token');
      expect(profile?.user.provider).toBe('orcid');
      expect(profile?.user.accountId).toBe('0000-0002-1825-0097');
      expect(profile?.user.handle).toBeUndefined();
      // Name from the token response; email/org from the public record.
      expect(profile?.user.name).toBe('Josiah Carberry');
      expect(profile?.user.organisation).toBe('Brown University');
      const emailHash = createHash('sha256').update('josiah@example.edu').digest('hex');
      expect(profile?.user.avatarUrl).toBe(`https://gravatar.com/avatar/${emailHash}?d=identicon&s=80`);
    });

    it('still succeeds when the public-record enrichment fails', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          if (String(url).endsWith('/oauth/token')) {
            return jsonResponse({ access_token: 't', orcid: '0000-0002-1825-0097', name: 'Solo Name' });
          }
          throw new Error(`unexpected: ${url}`);
        }),
      );
      // Public API token fetch fails → fetchOrcidPublic returns {}.
      restoreFetch = setOrcidFetchForTesting(async () => jsonResponse({ error: 'nope' }, { status: 401 }));

      const profile = await orcidProvider.exchangeCode('code', 'https://app/cb');
      expect(profile?.user.name).toBe('Solo Name');
      expect(profile?.user.organisation).toBe('');
      // Avatar falls back to an iD-seeded identicon.
      const idHash = createHash('sha256').update('0000-0002-1825-0097').digest('hex');
      expect(profile?.user.avatarUrl).toBe(`https://gravatar.com/avatar/${idHash}?d=identicon&s=80`);
    });

    it('returns null when the token response carries no orcid id', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonResponse({ access_token: 't' })),
      );
      expect(await orcidProvider.exchangeCode('code', 'https://app/cb')).toBeNull();
    });

    it('returns null when the token endpoint returns a non-OK status', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonResponse({ error: 'invalid_grant' }, { status: 400 })),
      );
      expect(await orcidProvider.exchangeCode('code', 'https://app/cb')).toBeNull();
    });
  });

  describe('resolveByAccountId / resolveByHandle', () => {
    function stubRecord(profile: Record<string, unknown>) {
      restoreFetch = setOrcidFetchForTesting(async (url) => {
        if (url.endsWith('/oauth/token')) return tokenResponse();
        if (url.includes('/record')) return jsonResponse(profile);
        throw new Error(`unexpected: ${url}`);
      });
    }

    it('resolves a well-formed iD via the public record', async () => {
      stubRecord({ person: { name: { 'credit-name': { value: 'Grace Hopper' } } } });
      const user = await orcidProvider.resolveByAccountId?.('0000-0002-1825-0097');
      expect(user?.accountId).toBe('0000-0002-1825-0097');
      expect(user?.name).toBe('Grace Hopper');
    });

    it('still yields a user (name = iD) when the record is empty', async () => {
      stubRecord({});
      const user = await orcidProvider.resolveByAccountId?.('0000-0002-1825-0097');
      expect(user?.name).toBe('0000-0002-1825-0097');
    });

    it('resolveByHandle resolves a pasted iD but rejects free text', async () => {
      stubRecord({ person: { name: { 'credit-name': { value: 'Grace Hopper' } } } });
      expect((await orcidProvider.resolveByHandle('0000-0002-1825-0097'))?.name).toBe('Grace Hopper');
      // Free text is not an iD — no lookup, returns null (placeholder upstream).
      expect(await orcidProvider.resolveByHandle('grace hopper')).toBeNull();
    });
  });

  describe('avatarUrl', () => {
    it('synthesises a stable iD-seeded identicon', () => {
      const idHash = createHash('sha256').update('0000-0002-1825-0097').digest('hex');
      expect(orcidProvider.avatarUrl({ accountId: '0000-0002-1825-0097', handle: undefined })).toBe(
        `https://gravatar.com/avatar/${idHash}?d=identicon&s=80`,
      );
    });
  });

  describe('directory.searchUsers', () => {
    const directory = orcidProvider.directory!;

    it('resolves a pasted iD directly without an expanded-search call', async () => {
      let searchCalled = false;
      restoreFetch = setOrcidFetchForTesting(async (url) => {
        if (url.endsWith('/oauth/token')) return tokenResponse();
        if (url.includes('/expanded-search/')) {
          searchCalled = true;
          return jsonResponse({ 'expanded-result': [] });
        }
        if (url.includes('/record'))
          return jsonResponse({ person: { name: { 'credit-name': { value: 'Grace Hopper' } } } });
        throw new Error(`unexpected: ${url}`);
      });

      const results = await directory.searchUsers(makeSession(), '0000-0002-1825-0097', undefined, 5);
      expect(searchCalled).toBe(false);
      expect(results.map((s) => s.user.accountId)).toEqual(['0000-0002-1825-0097']);
      expect(results[0].user.name).toBe('Grace Hopper');
    });

    it('searches the registry by name when the query is not an iD', async () => {
      restoreFetch = setOrcidFetchForTesting(async (url) => {
        if (url.endsWith('/oauth/token')) return tokenResponse();
        if (url.includes('/expanded-search/')) {
          return jsonResponse({
            'expanded-result': [
              {
                'orcid-id': '0000-0002-1825-0097',
                'given-names': 'Grace',
                'family-names': 'Hopper',
                'institution-name': ['US Navy'],
              },
            ],
          });
        }
        throw new Error(`unexpected: ${url}`);
      });

      const results = await directory.searchUsers(makeSession(), 'hopper', undefined, 5);
      expect(results.map((s) => s.user.name)).toEqual(['Grace Hopper']);
      expect(results[0].user.organisation).toBe('US Navy');
    });

    it('returns meeting ORCID users (tier 1) ahead of registry hits and dedupes by iD', async () => {
      restoreFetch = setOrcidFetchForTesting(async (url) => {
        if (url.endsWith('/oauth/token')) return tokenResponse();
        if (url.includes('/expanded-search/')) {
          return jsonResponse({
            'expanded-result': [
              // Same iD as the meeting user → must dedupe to the meeting copy.
              {
                'orcid-id': '0000-0002-1825-0097',
                'given-names': 'Grace',
                'family-names': 'Hopper',
                'institution-name': [],
              },
              {
                'orcid-id': '0000-0003-0000-0001',
                'given-names': 'Grace',
                'family-names': 'Murray',
                'institution-name': [],
              },
            ],
          });
        }
        throw new Error(`unexpected: ${url}`);
      });

      const meeting = makeMeeting([
        orcidUser({ id: '0000-0002-1825-0097', name: 'Grace Hopper', organisation: 'Meeting Org' }),
      ]);
      const results = await directory.searchUsers(makeSession(), 'grace', meeting, 5);

      expect(results.map((s) => s.user.accountId)).toEqual(['0000-0002-1825-0097', '0000-0003-0000-0001']);
      // Tier-1 copy wins the dedupe (carries the meeting badge + meeting org).
      expect(results[0].badge).toBe('meeting');
      expect(results[0].user.organisation).toBe('Meeting Org');
      expect(results[1].badge).toBeUndefined();
    });

    it('ignores non-ORCID meeting users in tier 1', async () => {
      restoreFetch = setOrcidFetchForTesting(async (url) => {
        if (url.endsWith('/oauth/token')) return tokenResponse();
        if (url.includes('/expanded-search/')) return jsonResponse({ 'expanded-result': [] });
        throw new Error(`unexpected: ${url}`);
      });

      // A GitHub-provider user named "grace" must not surface in an ORCID search.
      const meeting = makeMeeting([
        { provider: 'github', accountId: '42', handle: 'grace', name: 'Grace GH', organisation: '', avatarUrl: '' },
      ]);
      const results = await directory.searchUsers(makeSession(), 'grace', meeting, 5);
      expect(results).toEqual([]);
    });
  });

  describe('directory.searchUsersLocal / resolvePresenterFromDirectory', () => {
    const directory = orcidProvider.directory!;

    const meeting = makeMeeting([
      orcidUser({ id: '0000-0002-1825-0097', name: 'Grace Hopper', organisation: 'US Navy' }),
      orcidUser({ id: '0000-0003-0000-0001', name: 'Grace Murray', organisation: 'Yale' }),
    ]);

    it('searchUsersLocal matches meeting users synchronously', () => {
      const results = directory.searchUsersLocal(makeSession(), 'hopper', meeting, 5);
      expect(results.map((s) => s.user.name)).toEqual(['Grace Hopper']);
      expect(results[0].badge).toBe('meeting');
    });

    it('resolvePresenterFromDirectory returns the sole match, null when ambiguous', () => {
      const sole = directory.resolvePresenterFromDirectory(makeSession(), 'hopper', meeting);
      expect(sole?.user.accountId).toBe('0000-0002-1825-0097');

      // "grace" matches both → ambiguous → null.
      expect(directory.resolvePresenterFromDirectory(makeSession(), 'grace', meeting)).toBeNull();
    });
  });
});
