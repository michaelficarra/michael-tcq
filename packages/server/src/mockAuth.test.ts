import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import session from 'express-session';
import { isMockAuthEnabled, mockAuth, MOCK_USER } from './mockAuth.js';
import './session.js';

/**
 * The mock-auth gate must combine two conditions: a non-production
 * environment AND no real OAuth provider configured. The environment check is
 * the security-relevant part — a production deploy that forgot its OAuth
 * credentials must fail closed (no auto-login) rather than handing every
 * visitor the admin mock user.
 */
describe('isMockAuthEnabled', () => {
  const origEnv = process.env.NODE_ENV;
  const origClientId = process.env.GITHUB_CLIENT_ID;
  const origSecret = process.env.GITHUB_CLIENT_SECRET;

  function setProviderConfigured(configured: boolean) {
    if (configured) {
      process.env.GITHUB_CLIENT_ID = 'cid';
      process.env.GITHUB_CLIENT_SECRET = 'secret';
    } else {
      delete process.env.GITHUB_CLIENT_ID;
      delete process.env.GITHUB_CLIENT_SECRET;
    }
  }

  afterEach(() => {
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore('NODE_ENV', origEnv);
    restore('GITHUB_CLIENT_ID', origClientId);
    restore('GITHUB_CLIENT_SECRET', origSecret);
  });

  it('is enabled outside production when no provider is configured', () => {
    process.env.NODE_ENV = 'development';
    setProviderConfigured(false);
    expect(isMockAuthEnabled()).toBe(true);

    // The e2e suite runs with NODE_ENV=test and no providers — also mock.
    process.env.NODE_ENV = 'test';
    expect(isMockAuthEnabled()).toBe(true);

    // The everyday `npm run dev` server runs with NODE_ENV unset.
    delete process.env.NODE_ENV;
    expect(isMockAuthEnabled()).toBe(true);
  });

  it('is disabled in production even when no provider is configured (fail closed)', () => {
    process.env.NODE_ENV = 'production';
    setProviderConfigured(false);
    expect(isMockAuthEnabled()).toBe(false);
  });

  it('is disabled whenever a real provider is configured, regardless of environment', () => {
    setProviderConfigured(true);
    process.env.NODE_ENV = 'development';
    expect(isMockAuthEnabled()).toBe(false);
    process.env.NODE_ENV = 'production';
    expect(isMockAuthEnabled()).toBe(false);
  });
});

describe('mockAuth middleware', () => {
  const origEnv = process.env.NODE_ENV;
  const origClientId = process.env.GITHUB_CLIENT_ID;
  const origSecret = process.env.GITHUB_CLIENT_SECRET;

  beforeEach(() => {
    delete process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_SECRET;
  });

  afterEach(() => {
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore('NODE_ENV', origEnv);
    restore('GITHUB_CLIENT_ID', origClientId);
    restore('GITHUB_CLIENT_SECRET', origSecret);
  });

  /** Tiny app that echoes whether the mock middleware injected a session user. */
  async function injectedUserName(): Promise<string | null> {
    const app = express();
    app.use(session({ secret: 'test', resave: false, saveUninitialized: false }));
    app.use(mockAuth);
    app.get('/whoami', (req, res) => {
      res.json({ name: req.session.user?.name ?? null });
    });

    const server = app.listen(0);
    try {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const res = await fetch(`http://localhost:${port}/whoami`);
      const body = (await res.json()) as { name: string | null };
      return body.name;
    } finally {
      server.close();
    }
  }

  it('injects the admin mock user outside production', async () => {
    process.env.NODE_ENV = 'development';
    expect(await injectedUserName()).toBe(MOCK_USER.name);
  });

  it('injects no user in production (request stays unauthenticated)', async () => {
    process.env.NODE_ENV = 'production';
    expect(await injectedUserName()).toBeNull();
  });
});
