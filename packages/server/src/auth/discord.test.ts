import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MeetingState, User } from '@tcq/shared';
import { userKey } from '@tcq/shared';
import { discordProvider } from './discord.js';
import { discordUser } from './discordUser.js';
import type { SessionUser } from '../session.js';

/** Build a SessionUser inline; the Discord directory ignores most fields. */
function makeSession(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    provider: 'discord',
    accountId: 'searcher-id',
    handle: 'searcher',
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

/**
 * Stub `fetch` for the two-step OAuth2 flow: the token POST then the
 * `/users/@me` GET. Pass the JSON each endpoint should return (or a status to
 * force a non-OK response); a `null` profile means the user fetch is never
 * expected (e.g. the token step already failed).
 */
function stubDiscordFetch(opts: {
  token?: { body: unknown; status?: number };
  profile?: { body: unknown; status?: number } | null;
}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = String(url);
      if (u === 'https://discord.com/api/oauth2/token') {
        return jsonResponse(opts.token?.body ?? {}, { status: opts.token?.status });
      }
      if (u === 'https://discord.com/api/users/@me') {
        if (!opts.profile) throw new Error('unexpected profile fetch');
        return jsonResponse(opts.profile.body, { status: opts.profile.status });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }),
  );
}

describe('discordUser', () => {
  it('maps id→accountId, username→handle, avatar hash→CDN URL (no email stored)', () => {
    const user = discordUser({
      id: '80351110224678912',
      username: 'nelly',
      globalName: 'Nelly',
      avatar: '8342729096ea3675442027381ff50dfe',
    });
    expect(user).toEqual({
      provider: 'discord',
      accountId: '80351110224678912',
      handle: 'nelly',
      name: 'Nelly',
      organisation: '',
      avatarUrl: 'https://cdn.discordapp.com/avatars/80351110224678912/8342729096ea3675442027381ff50dfe.png',
    });
    // The email is never requested or stored.
    expect(user).not.toHaveProperty('email');
  });

  it('falls back name global_name → username → id, and empties handle/avatar when absent', () => {
    // global_name absent → username (also the handle).
    const u = discordUser({ id: 'abc', username: 'nelly' });
    expect(u.name).toBe('nelly');
    expect(u.handle).toBe('nelly');
    // global_name and username blank → id; blank username → no handle.
    const bare = discordUser({ id: 'abc', username: '' });
    expect(bare.name).toBe('abc');
    expect(bare.handle).toBeUndefined();
    expect(bare.organisation).toBe('');
    expect(bare.avatarUrl).toBe('');
  });
});

describe('discordProvider', () => {
  const origId = process.env.DISCORD_CLIENT_ID;
  const origSecret = process.env.DISCORD_CLIENT_SECRET;

  beforeEach(() => {
    process.env.DISCORD_CLIENT_ID = 'cid';
    process.env.DISCORD_CLIENT_SECRET = 'secret';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore('DISCORD_CLIENT_ID', origId);
    restore('DISCORD_CLIENT_SECRET', origSecret);
  });

  it('reports enabled only when both credentials are present', () => {
    expect(discordProvider.enabled).toBe(true);
    delete process.env.DISCORD_CLIENT_SECRET;
    expect(discordProvider.enabled).toBe(false);
  });

  describe('authorizationUrl', () => {
    it('targets Discord with the identify scope (no email) and forwarded state', () => {
      const url = new URL(
        discordProvider.authorizationUrl({ state: 'xyz', redirectUri: 'https://app/auth/discord/callback' }),
      );
      expect(url.origin + url.pathname).toBe('https://discord.com/oauth2/authorize');
      expect(url.searchParams.has('client_id')).toBe(true);
      expect(url.searchParams.get('response_type')).toBe('code');
      // Only `identify` — never `email`.
      expect(url.searchParams.get('scope')).toBe('identify');
      expect(url.searchParams.get('redirect_uri')).toBe('https://app/auth/discord/callback');
      expect(url.searchParams.get('state')).toBe('xyz');
    });
  });

  describe('exchangeCode', () => {
    it('exchanges the code, fetches the profile, and builds a User (username handle, no email/token)', async () => {
      stubDiscordFetch({
        token: { body: { access_token: 'user-token', token_type: 'Bearer' } },
        profile: {
          body: {
            id: '80351110224678912',
            username: 'nelly',
            global_name: 'Nelly',
            avatar: '8342729096ea3675442027381ff50dfe',
            // Discord may still return an email field; we must never store it.
            email: 'nelly@discord.test',
          },
        },
      });

      const profile = await discordProvider.exchangeCode('the-code', 'https://app/auth/discord/callback');
      // No server-side access token is retained for Discord.
      expect(profile?.accessToken).toBeUndefined();
      expect(profile?.user).toEqual({
        provider: 'discord',
        accountId: '80351110224678912',
        handle: 'nelly',
        name: 'Nelly',
        organisation: '',
        avatarUrl: 'https://cdn.discordapp.com/avatars/80351110224678912/8342729096ea3675442027381ff50dfe.png',
      });
      expect(profile?.user).not.toHaveProperty('email');
    });

    it('falls back name to username and yields an empty avatar when none is set', async () => {
      stubDiscordFetch({
        token: { body: { access_token: 't' } },
        profile: { body: { id: '1', username: 'plainuser', global_name: null, avatar: null } },
      });
      const profile = await discordProvider.exchangeCode('code', 'https://app/cb');
      expect(profile?.user.name).toBe('plainuser');
      expect(profile?.user.handle).toBe('plainuser');
      expect(profile?.user.avatarUrl).toBe('');
    });

    it('returns null when the token POST fails (network)', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('offline');
        }),
      );
      expect(await discordProvider.exchangeCode('code', 'https://app/cb')).toBeNull();
    });

    it('returns null on a non-OK token status', async () => {
      stubDiscordFetch({ token: { body: { error: 'invalid_grant' }, status: 400 } });
      expect(await discordProvider.exchangeCode('code', 'https://app/cb')).toBeNull();
    });

    it('returns null when the token response carries no access_token', async () => {
      stubDiscordFetch({ token: { body: { token_type: 'Bearer' } } });
      expect(await discordProvider.exchangeCode('code', 'https://app/cb')).toBeNull();
    });

    it('returns null on a non-OK profile status', async () => {
      stubDiscordFetch({ token: { body: { access_token: 't' } }, profile: { body: {}, status: 401 } });
      expect(await discordProvider.exchangeCode('code', 'https://app/cb')).toBeNull();
    });

    it('returns null when the profile is missing id or username', async () => {
      stubDiscordFetch({ token: { body: { access_token: 't' } }, profile: { body: { id: '1' } } });
      expect(await discordProvider.exchangeCode('code', 'https://app/cb')).toBeNull();
    });
  });

  describe('resolveByHandle / resolveByAccountId', () => {
    it('resolveByHandle always returns null (no public lookup)', async () => {
      expect(await discordProvider.resolveByHandle('anything')).toBeNull();
      expect(await discordProvider.resolveByHandle('80351110224678912')).toBeNull();
    });

    it('omits resolveByAccountId entirely (known-users cache handles re-resolution)', () => {
      expect(discordProvider.resolveByAccountId).toBeUndefined();
    });
  });

  describe('avatarUrl', () => {
    it('returns empty — no avatar is derivable from the id alone', () => {
      expect(discordProvider.avatarUrl({ accountId: '80351110224678912', handle: 'nelly' })).toBe('');
    });
  });

  describe('directory', () => {
    const directory = discordProvider.directory!;

    const meeting = makeMeeting([
      discordUser({ id: 'id-nelly', username: 'nelly', globalName: 'Nelly Lovelace' }),
      discordUser({ id: 'id-alan', username: 'alan_t', globalName: 'Alan Turing' }),
      // A non-Discord user that must never surface in a Discord search.
      {
        provider: 'orcid',
        accountId: '0000-0002-1825-0097',
        handle: undefined,
        name: 'Nelly Byron',
        organisation: '',
        avatarUrl: '',
      },
    ]);

    it('searchUsers returns only Discord meeting users, case-insensitive on display name', async () => {
      const results = await directory.searchUsers(makeSession(), 'NELLY', meeting, 5);
      // Matches the Discord "Nelly Lovelace" but not the ORCID "Nelly Byron".
      expect(results.map((s) => s.user.accountId)).toEqual(['id-nelly']);
      expect(results[0].badge).toBe('meeting');
    });

    it('matches on the username (handle) too', async () => {
      const results = await directory.searchUsers(makeSession(), 'alan_t', meeting, 5);
      expect(results.map((s) => s.user.accountId)).toEqual(['id-alan']);
    });

    it('searchUsersLocal mirrors searchUsers synchronously', () => {
      const results = directory.searchUsersLocal(makeSession(), 'turing', meeting, 5);
      expect(results.map((s) => s.user.name)).toEqual(['Alan Turing']);
    });

    it('resolvePresenterFromDirectory returns the sole match, null when ambiguous', () => {
      expect(directory.resolvePresenterFromDirectory(makeSession(), 'turing', meeting)?.user.accountId).toBe('id-alan');
      // Both Nelly and Alan match the broad query → not unique.
      expect(directory.resolvePresenterFromDirectory(makeSession(), 'a', meeting)).toBeNull();
    });
  });
});
