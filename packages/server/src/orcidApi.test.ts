import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  orcidBase,
  orcidPubBase,
  fetchOrcidPublic,
  orcidExpandedSearch,
  primeOrcidToken,
  setOrcidFetchForTesting,
  resetOrcidApiForTesting,
} from './orcidApi.js';

/** Build a minimal JSON Response the module's fetch hook can return. */
function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A canned `/read-public` client-credentials token response. */
function tokenResponse(token = 'read-public-token', expiresIn = 631_138_518): Response {
  return jsonResponse({ access_token: token, token_type: 'bearer', scope: '/read-public', expires_in: expiresIn });
}

describe('orcidApi', () => {
  let restoreFetch: () => void = () => {};
  const originalBaseUrl = process.env.ORCID_BASE_URL;
  const originalClientId = process.env.ORCID_CLIENT_ID;
  const originalClientSecret = process.env.ORCID_CLIENT_SECRET;

  beforeEach(() => {
    // The token fetch reads credentials straight off the env at call time.
    process.env.ORCID_CLIENT_ID = 'cid';
    process.env.ORCID_CLIENT_SECRET = 'secret';
    delete process.env.ORCID_BASE_URL;
    resetOrcidApiForTesting();
  });

  afterEach(() => {
    restoreFetch();
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore('ORCID_BASE_URL', originalBaseUrl);
    restore('ORCID_CLIENT_ID', originalClientId);
    restore('ORCID_CLIENT_SECRET', originalClientSecret);
  });

  describe('base URLs', () => {
    it('defaults to orcid.org and derives the pub host', () => {
      expect(orcidBase()).toBe('https://orcid.org');
      expect(orcidPubBase()).toBe('https://pub.orcid.org/v3.0');
    });

    it('honours ORCID_BASE_URL (sandbox) and strips trailing slashes', () => {
      process.env.ORCID_BASE_URL = 'https://sandbox.orcid.org/';
      expect(orcidBase()).toBe('https://sandbox.orcid.org');
      expect(orcidPubBase()).toBe('https://pub.sandbox.orcid.org/v3.0');
    });
  });

  describe('read-public token', () => {
    it('fetches a client-credentials token once and caches it across public calls', async () => {
      const tokenCalls: string[] = [];
      restoreFetch = setOrcidFetchForTesting(async (url, init) => {
        if (url.endsWith('/oauth/token')) {
          tokenCalls.push(String(init?.body));
          return tokenResponse();
        }
        if (url.includes('/record')) return jsonResponse({ person: { name: { 'given-names': { value: 'A' } } } });
        throw new Error(`unexpected url: ${url}`);
      });

      // Two record lookups should share a single token fetch.
      await fetchOrcidPublic('0000-0002-1825-0097');
      await fetchOrcidPublic('0000-0002-1825-0097');

      expect(tokenCalls).toHaveLength(1);
      // The grant is client-credentials with the read-public scope.
      expect(tokenCalls[0]).toContain('grant_type=client_credentials');
      expect(tokenCalls[0]).toContain('scope=%2Fread-public');
    });

    it('coalesces concurrent token fetches into one request', async () => {
      let tokenCalls = 0;
      restoreFetch = setOrcidFetchForTesting(async (url) => {
        if (url.endsWith('/oauth/token')) {
          tokenCalls++;
          // Defer a tick so both callers are in flight before either resolves.
          await new Promise((r) => setTimeout(r, 5));
          return tokenResponse();
        }
        if (url.includes('/record')) return jsonResponse({});
        throw new Error(`unexpected url: ${url}`);
      });

      await Promise.all([fetchOrcidPublic('0000-0002-1825-0097'), fetchOrcidPublic('0000-0002-1825-0098')]);
      expect(tokenCalls).toBe(1);
    });

    it('refreshes the token and retries once after a 401 from the public API', async () => {
      const tokens = ['stale-token', 'fresh-token'];
      let tokenIssued = 0;
      const bearersSeen: string[] = [];
      restoreFetch = setOrcidFetchForTesting(async (url, init) => {
        if (url.endsWith('/oauth/token')) {
          return tokenResponse(tokens[tokenIssued++] ?? 'extra');
        }
        if (url.includes('/record')) {
          const auth = (init?.headers as Record<string, string>)?.Authorization ?? '';
          bearersSeen.push(auth);
          // The first (stale) token is rejected; the refreshed one succeeds.
          if (auth.includes('stale-token')) return jsonResponse({ message: 'expired' }, { status: 401 });
          return jsonResponse({ person: { name: { 'credit-name': { value: 'Josh' } } } });
        }
        throw new Error(`unexpected url: ${url}`);
      });

      const profile = await fetchOrcidPublic('0000-0002-1825-0097');
      // Two token issues (initial + forced refresh) and the retry succeeded.
      expect(tokenIssued).toBe(2);
      expect(bearersSeen).toEqual(['Bearer stale-token', 'Bearer fresh-token']);
      expect(profile.name).toBe('Josh');
    });

    it('primeOrcidToken warms the cache so a later call makes no token request', async () => {
      let tokenCalls = 0;
      restoreFetch = setOrcidFetchForTesting(async (url) => {
        if (url.endsWith('/oauth/token')) {
          tokenCalls++;
          return tokenResponse();
        }
        if (url.includes('/record')) return jsonResponse({});
        throw new Error(`unexpected url: ${url}`);
      });

      await primeOrcidToken();
      expect(tokenCalls).toBe(1);
      await fetchOrcidPublic('0000-0002-1825-0097');
      expect(tokenCalls).toBe(1);
    });

    it('returns empty data (no throw) when the token endpoint fails', async () => {
      restoreFetch = setOrcidFetchForTesting(async (url) => {
        if (url.endsWith('/oauth/token')) return jsonResponse({ error: 'invalid_client' }, { status: 401 });
        throw new Error(`unexpected url: ${url}`);
      });

      await expect(fetchOrcidPublic('0000-0002-1825-0097')).resolves.toEqual({});
    });
  });

  describe('fetchOrcidPublic', () => {
    beforeEach(() => {
      // Pre-warm a token so the per-test hooks only need to answer /record.
      restoreFetch = setOrcidFetchForTesting(async (url) => {
        if (url.endsWith('/oauth/token')) return tokenResponse();
        throw new Error(`unexpected url: ${url}`);
      });
    });

    it('parses the credit-name, first public email, and first employer', async () => {
      restoreFetch = setOrcidFetchForTesting(async (url) => {
        if (url.endsWith('/oauth/token')) return tokenResponse();
        if (url.includes('/0000-0002-1825-0097/record')) {
          return jsonResponse({
            person: {
              name: { 'credit-name': { value: 'Josiah Carberry' }, 'given-names': { value: 'J' } },
              emails: { email: [{ email: 'josiah@example.edu' }, { email: 'second@example.edu' }] },
            },
            'activities-summary': {
              employments: {
                'affiliation-group': [
                  { summaries: [{ 'employment-summary': { organization: { name: 'Brown University' } } }] },
                ],
              },
            },
          });
        }
        throw new Error(`unexpected url: ${url}`);
      });

      const profile = await fetchOrcidPublic('0000-0002-1825-0097');
      expect(profile).toEqual({
        name: 'Josiah Carberry',
        email: 'josiah@example.edu',
        organisation: 'Brown University',
      });
    });

    it('falls back to given + family name when no credit-name is set', async () => {
      restoreFetch = setOrcidFetchForTesting(async (url) => {
        if (url.endsWith('/oauth/token')) return tokenResponse();
        if (url.includes('/record')) {
          return jsonResponse({
            person: { name: { 'given-names': { value: 'Grace' }, 'family-name': { value: 'Hopper' } } },
          });
        }
        throw new Error(`unexpected url: ${url}`);
      });

      const profile = await fetchOrcidPublic('0000-0002-1825-0097');
      expect(profile.name).toBe('Grace Hopper');
      // No public email or employer in this record.
      expect(profile.email).toBeUndefined();
      expect(profile.organisation).toBeUndefined();
    });

    it('returns an empty profile when the record fetch 404s', async () => {
      restoreFetch = setOrcidFetchForTesting(async (url) => {
        if (url.endsWith('/oauth/token')) return tokenResponse();
        if (url.includes('/record')) return jsonResponse({ message: 'not found' }, { status: 404 });
        throw new Error(`unexpected url: ${url}`);
      });

      await expect(fetchOrcidPublic('0000-0002-1825-0097')).resolves.toEqual({});
    });
  });

  describe('orcidExpandedSearch', () => {
    it('maps expanded-result rows to {id, name, organisation}', async () => {
      restoreFetch = setOrcidFetchForTesting(async (url) => {
        if (url.endsWith('/oauth/token')) return tokenResponse();
        if (url.includes('/expanded-search/')) {
          // Echo the query so we can assert it was forwarded.
          expect(url).toContain('q=hopper');
          expect(url).toContain('rows=5');
          return jsonResponse({
            'expanded-result': [
              {
                'orcid-id': '0000-0002-1825-0097',
                'given-names': 'Grace',
                'family-names': 'Hopper',
                'institution-name': ['US Navy'],
              },
              {
                'orcid-id': '0000-0001-0000-0000',
                'credit-name': 'Ada, Countess of Lovelace',
                'given-names': 'Augusta',
                'family-names': 'King',
                'institution-name': [],
              },
            ],
            'num-found': 2,
          });
        }
        throw new Error(`unexpected url: ${url}`);
      });

      const results = await orcidExpandedSearch('hopper', 5);
      expect(results).toEqual([
        { id: '0000-0002-1825-0097', name: 'Grace Hopper', organisation: 'US Navy' },
        // credit-name wins over given+family when present.
        { id: '0000-0001-0000-0000', name: 'Ada, Countess of Lovelace', organisation: '' },
      ]);
    });

    it('returns [] for a blank query without hitting the network', async () => {
      let called = false;
      restoreFetch = setOrcidFetchForTesting(async () => {
        called = true;
        return jsonResponse({});
      });

      expect(await orcidExpandedSearch('   ', 5)).toEqual([]);
      expect(called).toBe(false);
    });

    it('returns [] when the search endpoint errors', async () => {
      restoreFetch = setOrcidFetchForTesting(async (url) => {
        if (url.endsWith('/oauth/token')) return tokenResponse();
        if (url.includes('/expanded-search/')) return jsonResponse({ message: 'boom' }, { status: 500 });
        throw new Error(`unexpected url: ${url}`);
      });

      expect(await orcidExpandedSearch('hopper', 5)).toEqual([]);
    });
  });
});
