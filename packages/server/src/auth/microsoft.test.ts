import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MeetingState, User } from '@tcq/shared';
import { userKey } from '@tcq/shared';
import { microsoftProvider } from './microsoft.js';
import { microsoftUser } from './microsoftUser.js';
import { gravatarUrl } from './gravatar.js';
import type { SessionUser } from '../session.js';

/** Build a SessionUser inline; the Microsoft directory ignores most fields. */
function makeSession(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    provider: 'microsoft',
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
 *  Microsoft provider decodes the payload without verifying the signature. */
function makeIdToken(claims: Record<string, unknown>): string {
  const seg = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${seg({ alg: 'RS256', typ: 'JWT' })}.${seg(claims)}.signature-not-checked`;
}

describe('microsoftUser', () => {
  it('builds a handle-less user: sub→accountId, gravatar from email, empty org', () => {
    const user = microsoftUser({
      sub: 'AAAAAAAAAAAAAAAAAAAAAA',
      name: 'Ada Lovelace',
      email: 'ada@contoso.test',
      preferredUsername: 'ada@contoso.test',
    });
    expect(user).toEqual({
      provider: 'microsoft',
      accountId: 'AAAAAAAAAAAAAAAAAAAAAA',
      handle: undefined,
      name: 'Ada Lovelace',
      organisation: '',
      avatarUrl: gravatarUrl('ada@contoso.test'),
    });
  });

  it('falls the name back through preferred_username then email then sub', () => {
    expect(microsoftUser({ sub: 's', preferredUsername: 'user@upn.test' }).name).toBe('user@upn.test');
    expect(microsoftUser({ sub: 's', email: 'only@email.test' }).name).toBe('only@email.test');
    expect(microsoftUser({ sub: 'bare-sub' }).name).toBe('bare-sub');
  });

  it('seeds the gravatar from email, then preferred_username, then sub', () => {
    expect(microsoftUser({ sub: 's', email: 'e@x.test', preferredUsername: 'u@x.test' }).avatarUrl).toBe(
      gravatarUrl('e@x.test'),
    );
    expect(microsoftUser({ sub: 's', preferredUsername: 'u@x.test' }).avatarUrl).toBe(gravatarUrl('u@x.test'));
    expect(microsoftUser({ sub: 'bare-sub' }).avatarUrl).toBe(gravatarUrl('bare-sub'));
  });
});

describe('microsoftProvider', () => {
  const origId = process.env.MICROSOFT_CLIENT_ID;
  const origSecret = process.env.MICROSOFT_CLIENT_SECRET;
  const origTenant = process.env.MICROSOFT_TENANT;

  beforeEach(() => {
    process.env.MICROSOFT_CLIENT_ID = 'cid';
    process.env.MICROSOFT_CLIENT_SECRET = 'secret';
    delete process.env.MICROSOFT_TENANT;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore('MICROSOFT_CLIENT_ID', origId);
    restore('MICROSOFT_CLIENT_SECRET', origSecret);
    restore('MICROSOFT_TENANT', origTenant);
  });

  it('reports enabled only when both credentials are present', () => {
    expect(microsoftProvider.enabled).toBe(true);
    delete process.env.MICROSOFT_CLIENT_SECRET;
    expect(microsoftProvider.enabled).toBe(false);
  });

  describe('authorizationUrl', () => {
    it('targets the common tenant v2.0 endpoint with the openid scope and forwarded state', () => {
      const url = new URL(
        microsoftProvider.authorizationUrl({ state: 'xyz', redirectUri: 'https://app/auth/microsoft/callback' }),
      );
      expect(url.origin + url.pathname).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
      expect(url.searchParams.has('client_id')).toBe(true);
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('scope')).toBe('openid email profile');
      expect(url.searchParams.get('redirect_uri')).toBe('https://app/auth/microsoft/callback');
      expect(url.searchParams.get('state')).toBe('xyz');
    });

    it('honours MICROSOFT_TENANT for a single-tenant deployment', () => {
      process.env.MICROSOFT_TENANT = 'contoso.onmicrosoft.com';
      const url = new URL(microsoftProvider.authorizationUrl({ redirectUri: 'https://app/cb' }));
      expect(url.origin + url.pathname).toBe(
        'https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/authorize',
      );
    });
  });

  describe('exchangeCode', () => {
    it('decodes the id_token into a User and returns the access token', async () => {
      const idToken = makeIdToken({
        sub: 'AAAAAAAAAAAAAAAAAAAAAA',
        name: 'Ada Lovelace',
        email: 'ada@contoso.test',
        preferred_username: 'ada@contoso.test',
        tid: 'a-tenant-guid',
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          expect(String(url)).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/token');
          return jsonResponse({ access_token: 'user-token', id_token: idToken, expires_in: 3599 });
        }),
      );

      const profile = await microsoftProvider.exchangeCode('the-code', 'https://app/auth/microsoft/callback');
      expect(profile?.accessToken).toBe('user-token');
      expect(profile?.user).toEqual({
        provider: 'microsoft',
        accountId: 'AAAAAAAAAAAAAAAAAAAAAA',
        handle: undefined,
        name: 'Ada Lovelace',
        organisation: '',
        avatarUrl: gravatarUrl('ada@contoso.test'),
      });
    });

    it('uses preferred_username as the name/gravatar seed when no name or email', async () => {
      const idToken = makeIdToken({ sub: 'consumer-sub', preferred_username: 'someone@outlook.test' });
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonResponse({ access_token: 't', id_token: idToken })),
      );
      const profile = await microsoftProvider.exchangeCode('code', 'https://app/cb');
      expect(profile?.user.name).toBe('someone@outlook.test');
      expect(profile?.user.avatarUrl).toBe(gravatarUrl('someone@outlook.test'));
    });

    it('returns null when the token POST fails (network)', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('offline');
        }),
      );
      expect(await microsoftProvider.exchangeCode('code', 'https://app/cb')).toBeNull();
    });

    it('returns null on a non-OK token status', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonResponse({ error: 'invalid_grant' }, { status: 400 })),
      );
      expect(await microsoftProvider.exchangeCode('code', 'https://app/cb')).toBeNull();
    });

    it('returns null when the response carries no id_token', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonResponse({ access_token: 't' })),
      );
      expect(await microsoftProvider.exchangeCode('code', 'https://app/cb')).toBeNull();
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
        expect(await microsoftProvider.exchangeCode('code', 'https://app/cb')).toBeNull();
      }
    });
  });

  describe('resolveByHandle / resolveByAccountId', () => {
    it('resolveByHandle always returns null (no public lookup)', async () => {
      expect(await microsoftProvider.resolveByHandle('anything')).toBeNull();
    });

    it('omits resolveByAccountId entirely (known-users cache handles re-resolution)', () => {
      expect(microsoftProvider.resolveByAccountId).toBeUndefined();
    });
  });

  describe('avatarUrl', () => {
    it('returns a stable sub-seeded gravatar identicon', () => {
      expect(microsoftProvider.avatarUrl({ accountId: 'AAAAAAAAAAAAAAAAAAAAAA', handle: undefined })).toBe(
        gravatarUrl('AAAAAAAAAAAAAAAAAAAAAA'),
      );
    });
  });

  describe('directory', () => {
    const directory = microsoftProvider.directory!;

    const meeting = makeMeeting([
      microsoftUser({ sub: 'sub-ada', name: 'Ada Lovelace' }),
      microsoftUser({ sub: 'sub-alan', name: 'Alan Turing' }),
      // A non-Microsoft user that must never surface in a Microsoft search.
      {
        provider: 'google',
        accountId: 'g-ada',
        handle: undefined,
        name: 'Ada Byron',
        organisation: '',
        avatarUrl: '',
      },
    ]);

    it('searchUsers returns only Microsoft meeting users, case-insensitive', async () => {
      const results = await directory.searchUsers(makeSession(), 'ADA', meeting, 5);
      // Matches the Microsoft "Ada Lovelace" but not the Google "Ada Byron".
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
      // Both Ada and Alan match the broad query → not unique.
      expect(directory.resolvePresenterFromDirectory(makeSession(), 'a', meeting)).toBeNull();
    });
  });
});
