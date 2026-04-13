import { describe, it, expect, beforeEach } from 'vitest';
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
  });

  describe('GET /auth/github/callback', () => {
    it('returns 400 when authorisation code is missing', async () => {
      const res = await fetch(`${baseUrl}/auth/github/callback`);
      expect(res.status).toBe(400);
    });
  });

  describe('GET /auth/logout', () => {
    it('redirects to home page', async () => {
      const res = await fetch(`${baseUrl}/auth/logout`, { redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/');
    });
  });
});
