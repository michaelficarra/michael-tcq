import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MeetingState, User } from '@tcq/shared';
import { userKey } from '@tcq/shared';
import { googleProvider } from './google.js';
import { googleUser } from './googleUser.js';
import type { SessionUser } from '../session.js';

/** Build a SessionUser inline; the Google directory ignores most fields. */
function makeSession(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    provider: 'google',
    accountId: 'searcher-sub',
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

/** Build an unsigned (signature-free) JWT with the given payload claims; the
 *  Google provider decodes the payload without verifying the signature. */
function makeIdToken(claims: Record<string, unknown>): string {
  const seg = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${seg({ alg: 'RS256', typ: 'JWT' })}.${seg(claims)}.signature-not-checked`;
}

describe('googleUser', () => {
  it('builds a handle-less user, mapping sub→accountId, picture→avatar, hd→organisation', () => {
    const user = googleUser({
      sub: '110169484474386276334',
      name: 'Ada Lovelace',
      email: 'ada@analytical.test',
      picture: 'https://lh3.googleusercontent.com/a/ada=s96',
      hd: 'analytical.test',
    });
    expect(user).toEqual({
      provider: 'google',
      accountId: '110169484474386276334',
      handle: undefined,
      name: 'Ada Lovelace',
      organisation: 'analytical.test',
      avatarUrl: 'https://lh3.googleusercontent.com/a/ada=s96',
    });
  });

  it('falls back name to email then sub, and leaves org/avatar empty when absent', () => {
    expect(googleUser({ sub: 'abc', email: 'only@email.test' }).name).toBe('only@email.test');
    const bare = googleUser({ sub: 'abc' });
    expect(bare.name).toBe('abc');
    expect(bare.organisation).toBe('');
    expect(bare.avatarUrl).toBe('');
  });
});

describe('googleProvider', () => {
  const origId = process.env.GOOGLE_CLIENT_ID;
  const origSecret = process.env.GOOGLE_CLIENT_SECRET;

  beforeEach(() => {
    process.env.GOOGLE_CLIENT_ID = 'cid';
    process.env.GOOGLE_CLIENT_SECRET = 'secret';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore('GOOGLE_CLIENT_ID', origId);
    restore('GOOGLE_CLIENT_SECRET', origSecret);
  });

  it('reports enabled only when both credentials are present', () => {
    expect(googleProvider.enabled).toBe(true);
    delete process.env.GOOGLE_CLIENT_SECRET;
    expect(googleProvider.enabled).toBe(false);
  });

  describe('authorizationUrl', () => {
    it('targets Google with the openid scope and forwarded state', () => {
      const url = new URL(
        googleProvider.authorizationUrl({ state: 'xyz', redirectUri: 'https://app/auth/google/callback' }),
      );
      expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
      expect(url.searchParams.has('client_id')).toBe(true);
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('scope')).toBe('openid email profile');
      expect(url.searchParams.get('redirect_uri')).toBe('https://app/auth/google/callback');
      expect(url.searchParams.get('state')).toBe('xyz');
    });
  });

  describe('exchangeCode', () => {
    it('decodes the id_token into a User (sub, name, picture, hd) and returns the access token', async () => {
      const idToken = makeIdToken({
        sub: '110169484474386276334',
        name: 'Ada Lovelace',
        email: 'ada@analytical.test',
        picture: 'https://lh3.googleusercontent.com/a/ada=s96',
        hd: 'analytical.test',
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          expect(String(url)).toBe('https://oauth2.googleapis.com/token');
          return jsonResponse({ access_token: 'user-token', id_token: idToken, expires_in: 3599 });
        }),
      );

      const profile = await googleProvider.exchangeCode('the-code', 'https://app/auth/google/callback');
      expect(profile?.accessToken).toBe('user-token');
      expect(profile?.user).toEqual({
        provider: 'google',
        accountId: '110169484474386276334',
        handle: undefined,
        name: 'Ada Lovelace',
        organisation: 'analytical.test',
        avatarUrl: 'https://lh3.googleusercontent.com/a/ada=s96',
      });
    });

    it('falls back the name to email then sub for a consumer account (no hd)', async () => {
      const idToken = makeIdToken({ sub: 'consumer-sub', email: 'someone@gmail.com' });
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonResponse({ access_token: 't', id_token: idToken })),
      );
      const profile = await googleProvider.exchangeCode('code', 'https://app/cb');
      expect(profile?.user.name).toBe('someone@gmail.com');
      expect(profile?.user.organisation).toBe('');
    });

    it('returns null when the token POST fails (network)', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('offline');
        }),
      );
      expect(await googleProvider.exchangeCode('code', 'https://app/cb')).toBeNull();
    });

    it('returns null on a non-OK token status', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonResponse({ error: 'invalid_grant' }, { status: 400 })),
      );
      expect(await googleProvider.exchangeCode('code', 'https://app/cb')).toBeNull();
    });

    it('returns null when the response carries no id_token', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonResponse({ access_token: 't' })),
      );
      expect(await googleProvider.exchangeCode('code', 'https://app/cb')).toBeNull();
    });

    it('returns null on a malformed id_token (not three JWT segments / bad JSON / no sub)', async () => {
      const cases = [
        'not-a-jwt',
        'only.two',
        `${Buffer.from('{').toString('base64url')}.${Buffer.from('not json').toString('base64url')}.sig`,
        makeIdToken({ name: 'no sub here' }),
      ];
      for (const idToken of cases) {
        vi.stubGlobal(
          'fetch',
          vi.fn(async () => jsonResponse({ access_token: 't', id_token: idToken })),
        );
        expect(await googleProvider.exchangeCode('code', 'https://app/cb')).toBeNull();
      }
    });
  });

  describe('resolveByHandle / resolveByAccountId', () => {
    it('resolveByHandle always returns null (no public lookup)', async () => {
      expect(await googleProvider.resolveByHandle('anything')).toBeNull();
      expect(await googleProvider.resolveByHandle('110169484474386276334')).toBeNull();
    });

    it('omits resolveByAccountId entirely (known-users cache handles re-resolution)', () => {
      expect(googleProvider.resolveByAccountId).toBeUndefined();
    });
  });

  describe('avatarUrl', () => {
    it('returns empty — no avatar is derivable from the sub alone', () => {
      expect(googleProvider.avatarUrl({ accountId: '110169484474386276334', handle: undefined })).toBe('');
    });
  });

  describe('directory', () => {
    const directory = googleProvider.directory!;

    const meeting = makeMeeting([
      googleUser({ sub: 'sub-ada', name: 'Ada Lovelace', hd: 'analytical.test' }),
      googleUser({ sub: 'sub-alan', name: 'Alan Turing', hd: 'bletchley.test' }),
      // A non-Google user that must never surface in a Google search.
      {
        provider: 'orcid',
        accountId: '0000-0002-1825-0097',
        handle: undefined,
        name: 'Ada Byron',
        organisation: '',
        avatarUrl: '',
      },
    ]);

    it('searchUsers returns only Google meeting users, case-insensitive', async () => {
      const results = await directory.searchUsers(makeSession(), 'ADA', meeting, 5);
      // Matches the Google "Ada Lovelace" but not the ORCID "Ada Byron".
      expect(results.map((s) => s.user.accountId)).toEqual(['sub-ada']);
      expect(results[0].badge).toBe('meeting');
    });

    it('searchUsersLocal mirrors searchUsers synchronously', () => {
      const results = directory.searchUsersLocal(makeSession(), 'turing', meeting, 5);
      expect(results.map((s) => s.user.name)).toEqual(['Alan Turing']);
    });

    it('resolvePresenterFromDirectory returns the sole match, null when ambiguous', () => {
      expect(directory.resolvePresenterFromDirectory(makeSession(), 'turing', meeting)?.user.accountId).toBe(
        'sub-alan',
      );
      // Both Ada and Alan match the empty-ish broad query → not unique.
      expect(directory.resolvePresenterFromDirectory(makeSession(), 'a', meeting)).toBeNull();
    });
  });
});
