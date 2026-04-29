import { describe, it, expect } from 'vitest';
import { Timestamp } from '@google-cloud/firestore';
import { sessionDocParser, TTL_BUFFER_MS } from './sessionDocParser.js';

const COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Build a session-like object resembling what express-session passes to `store.set`. */
function makeSession(
  overrides: Partial<{ expires: Date | string | null; originalMaxAge: number | null; user: unknown }> = {},
) {
  return {
    cookie: {
      expires: overrides.expires === undefined ? new Date(Date.now() + COOKIE_MAX_AGE_MS) : overrides.expires,
      originalMaxAge: overrides.originalMaxAge === undefined ? COOKIE_MAX_AGE_MS : overrides.originalMaxAge,
      httpOnly: true,
      secure: true,
    },
    user: overrides.user ?? { login: 'octocat', id: 1 },
  };
}

describe('sessionDocParser', () => {
  it('round-trips session content via save → read', () => {
    const session = makeSession({ user: { login: 'alice', id: 42, isAdmin: true } });

    const doc = sessionDocParser.save(session);
    const recovered = sessionDocParser.read(doc) as { user: { login: string; id: number; isAdmin: boolean } };

    expect(recovered.user.login).toBe('alice');
    expect(recovered.user.id).toBe(42);
    expect(recovered.user.isAdmin).toBe(true);
  });

  it('writes expireAt as cookie.expires + 24h buffer', () => {
    const expires = new Date('2026-05-10T00:00:00.000Z');
    const session = makeSession({ expires });

    const doc = sessionDocParser.save(session);

    expect(doc.expireAt).toBeInstanceOf(Timestamp);
    const expected = expires.getTime() + TTL_BUFFER_MS;
    expect(doc.expireAt.toMillis()).toBe(expected);
  });

  it('accepts an ISO-string cookie.expires', () => {
    const isoExpires = '2026-05-10T00:00:00.000Z';
    const session = makeSession({ expires: isoExpires });

    const doc = sessionDocParser.save(session);

    const expected = new Date(isoExpires).getTime() + TTL_BUFFER_MS;
    expect(doc.expireAt.toMillis()).toBe(expected);
  });

  it('falls back to originalMaxAge when cookie.expires is missing', () => {
    const session = makeSession({ expires: null, originalMaxAge: COOKIE_MAX_AGE_MS });

    const before = Date.now();
    const doc = sessionDocParser.save(session);
    const after = Date.now();

    // Expected window: [before + maxAge + buffer, after + maxAge + buffer]
    const min = before + COOKIE_MAX_AGE_MS + TTL_BUFFER_MS;
    const max = after + COOKIE_MAX_AGE_MS + TTL_BUFFER_MS;
    expect(doc.expireAt.toMillis()).toBeGreaterThanOrEqual(min);
    expect(doc.expireAt.toMillis()).toBeLessThanOrEqual(max);
  });

  it('exports a 24-hour TTL buffer', () => {
    expect(TTL_BUFFER_MS).toBe(24 * 60 * 60 * 1000);
  });
});
