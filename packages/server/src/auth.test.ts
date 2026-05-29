import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import session from 'express-session';
import { createAuthRoutes } from './auth.js';
import { mockAuth } from './mockAuth.js';
import './session.js';

/** Create a test app with session + auth routes. */
function createTestApp() {
  const app = express();
  app.use(session({ secret: 'test', resave: false, saveUninitialized: false }));
  app.use(mockAuth);
  app.use('/auth', createAuthRoutes());
  return app;
}

async function listen(app: express.Express) {
  return new Promise<{ baseUrl: string; close: () => void }>((resolve) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        baseUrl: `http://localhost:${port}`,
        close: () => server.close(),
      });
    });
  });
}

describe('Auth routes', () => {
  let baseUrl: string;
  let close: () => void;

  beforeEach(async () => {
    const app = createTestApp();
    ({ baseUrl, close } = await listen(app));
    return () => close();
  });

  describe('GET /auth/github', () => {
    it('redirects to home in mock auth mode when OAuth is not configured', async () => {
      // Without GITHUB_CLIENT_ID, the handler redirects to home
      // (clearing the mockLoggedOut flag so mock auth can re-populate)
      const res = await fetch(`${baseUrl}/auth/github`, { redirect: 'manual' });

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/');
    });

    it('redirects to a safe returnTo path in mock auth mode', async () => {
      // A logged-out user deep-linking to a meeting should land back
      // on that meeting after the (mock) auth round-trip.
      const res = await fetch(`${baseUrl}/auth/github?returnTo=%2Fmeeting%2Ffoo`, { redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/meeting/foo');
    });

    // Open-redirect guard: anything that the browser might resolve to a
    // different origin must be rejected — otherwise an attacker could
    // craft phishing links that bounce through our login endpoint.
    it('rejects protocol-relative returnTo', async () => {
      const res = await fetch(`${baseUrl}/auth/github?returnTo=%2F%2Fevil.com`, { redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/');
    });

    it('rejects absolute-URL returnTo', async () => {
      const res = await fetch(`${baseUrl}/auth/github?returnTo=https%3A%2F%2Fevil.com`, { redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/');
    });

    it('rejects backslash-prefixed returnTo', async () => {
      const res = await fetch(`${baseUrl}/auth/github?returnTo=%2F%5Cevil.com`, { redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/');
    });
  });

  describe('GET /auth/github/callback', () => {
    // The callback only exists for a *configured* provider; in mock-auth
    // mode (no credentials) it 404s before reaching the missing-code check.
    // Enable GitHub OAuth for this block so the 400 path is exercised; the
    // rest of the file deliberately runs in mock-auth mode.
    const original = process.env.GITHUB_CLIENT_ID;
    beforeEach(() => {
      process.env.GITHUB_CLIENT_ID = 'test-client-id';
    });
    afterEach(() => {
      if (original === undefined) delete process.env.GITHUB_CLIENT_ID;
      else process.env.GITHUB_CLIENT_ID = original;
    });

    it('returns 400 when authorisation code is missing', async () => {
      const res = await fetch(`${baseUrl}/auth/github/callback`);
      expect(res.status).toBe(400);
    });

    it('returns 404 for an unknown / unconfigured provider', async () => {
      const res = await fetch(`${baseUrl}/auth/nope/callback?code=x`);
      expect(res.status).toBe(404);
    });
  });

  describe('OAuth state (CSRF defence)', () => {
    // State generation + validation only happen for a *configured* provider
    // (the mock-auth branch never round-trips through a real callback).
    const original = process.env.GITHUB_CLIENT_ID;
    beforeEach(() => {
      process.env.GITHUB_CLIENT_ID = 'test-client-id';
    });
    afterEach(() => {
      if (original === undefined) delete process.env.GITHUB_CLIENT_ID;
      else process.env.GITHUB_CLIENT_ID = original;
    });

    it('mints a state nonce on the authorize redirect and stores it on the session', async () => {
      const res = await fetch(`${baseUrl}/auth/github`, { redirect: 'manual' });
      expect(res.status).toBe(302);
      const location = res.headers.get('location') ?? '';
      // The provider's authorize URL must carry our generated state...
      const state = new URL(location).searchParams.get('state');
      expect(state).toBeTruthy();
      // ...and the session (holding the same nonce) must be persisted.
      expect(res.headers.get('set-cookie')).toBeTruthy();
    });

    it('rejects a callback with no state (defends against an unsolicited code)', async () => {
      // Code present, but no state and no prior session → cannot have been
      // initiated by us, so the code is never exchanged.
      const res = await fetch(`${baseUrl}/auth/github/callback?code=x`, { redirect: 'manual' });
      expect(res.status).toBe(400);
    });

    it('rejects a callback whose state does not match the session', async () => {
      // Establish a session carrying a freshly-minted nonce...
      const start = await fetch(`${baseUrl}/auth/github`, { redirect: 'manual' });
      const cookie = (start.headers.get('set-cookie') ?? '').split(';')[0];
      expect(cookie).toBeTruthy();
      // ...then replay the callback with a *different* state on that session.
      const res = await fetch(`${baseUrl}/auth/github/callback?code=x&state=not-the-real-nonce`, {
        headers: { cookie },
        redirect: 'manual',
      });
      expect(res.status).toBe(400);
    });

    it('rotates the session id on a successful login (session-fixation defence)', async () => {
      // Pull the `connect.sid` value out of a Set-Cookie header.
      const sidFrom = (setCookie: string | null) => /connect\.sid=([^;]+)/.exec(setCookie ?? '')?.[1] ?? null;

      // Stub GitHub's token + profile endpoints so the callback reaches a
      // successful exchange; everything else (incl. the test server) falls
      // through to the real fetch. The catch-all api.github.com branch keeps
      // the fire-and-forget directory warm off the network.
      const realFetch = globalThis.fetch;
      globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : (input as URL | Request).toString();
        if (url === 'https://github.com/login/oauth/access_token') {
          return Promise.resolve(Response.json({ access_token: 'gh-token' }));
        }
        if (url === 'https://api.github.com/user') {
          return Promise.resolve(Response.json({ id: 4242, login: 'octocat', name: 'The Octocat', company: 'GitHub' }));
        }
        if (url.startsWith('https://api.github.com/')) return Promise.resolve(Response.json([]));
        return realFetch(input as never, init);
      }) as typeof fetch;

      try {
        // Start login: establishes a session (id #1) and mints the state.
        const start = await fetch(`${baseUrl}/auth/github`, { redirect: 'manual' });
        const startCookie = start.headers.get('set-cookie') ?? '';
        const sidBefore = sidFrom(startCookie);
        const state = new URL(start.headers.get('location') ?? '').searchParams.get('state');
        expect(sidBefore).toBeTruthy();
        expect(state).toBeTruthy();

        // Complete the callback on that same session with the matching state.
        const cb = await fetch(`${baseUrl}/auth/github/callback?code=x&state=${state}`, {
          headers: { cookie: startCookie.split(';')[0] },
          redirect: 'manual',
        });
        expect(cb.status).toBe(302);
        expect(cb.headers.get('location')).toBe('/');

        // The authenticated response must carry a *new* session id (id #2).
        const sidAfter = sidFrom(cb.headers.get('set-cookie'));
        expect(sidAfter).toBeTruthy();
        expect(sidAfter).not.toBe(sidBefore);
      } finally {
        globalThis.fetch = realFetch;
      }
    });
  });

  describe('GET /auth/logout', () => {
    it('redirects to home page', async () => {
      const res = await fetch(`${baseUrl}/auth/logout`, { redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/');
    });
  });

  describe('production with no providers (fail closed)', () => {
    // A production deploy missing its OAuth credentials must NOT fall back to
    // the mock-auth redirect — the `mock` branch is gated on a non-production
    // environment. With no enabled provider, `/auth/github` resolves to no
    // provider and 404s instead of bouncing through mock login.
    const original = process.env.NODE_ENV;
    beforeEach(() => {
      process.env.NODE_ENV = 'production';
    });
    afterEach(() => {
      if (original === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = original;
    });

    it('does not mock-redirect /auth/github; returns 404', async () => {
      const res = await fetch(`${baseUrl}/auth/github`, { redirect: 'manual' });
      expect(res.status).toBe(404);
    });
  });
});
