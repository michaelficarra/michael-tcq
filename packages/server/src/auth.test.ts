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
