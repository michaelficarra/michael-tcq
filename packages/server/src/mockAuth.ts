/**
 * Mock authentication middleware for development.
 *
 * When mock auth is enabled, this middleware automatically sets a fake user
 * on every request's session. This allows features to be developed and tested
 * without creating an OAuth App.
 *
 * Mock auth is enabled only in a non-production environment AND when no real
 * authentication provider is configured. Gating on the environment (not just
 * the absence of providers) is a safety measure: a production deploy that is
 * missing its OAuth credentials must fail closed — returning 401s — rather
 * than silently auto-logging everyone in as the admin mock user.
 */

import type { RequestHandler } from 'express';
import type { User } from '@tcq/shared';
import { toSessionUser } from './session.js';
import { isAnyProviderConfigured } from './auth/registry.js';
import { mockUserFromLogin } from './mockUser.js';

// The default mock user is `admin`. It MUST resolve to the same key as
// `mockUserFromLogin('admin')` (what the dev user-switcher produces), so that
// switching to `admin` keeps the chair permissions of the `admin` who created
// a meeting — otherwise the auto-injected admin and the switched admin would
// be two different accounts. We reuse that resolver for the id, overriding
// only the display name ('Admin' rather than the login-derived 'admin').
export const MOCK_USER: User = { ...mockUserFromLogin('admin'), name: 'Admin' };

/**
 * Whether mock auth is active. True only outside production AND when no real
 * authentication provider is configured — see the module comment for why the
 * environment check matters. Every mock-only code path (the auto-login
 * middleware, the `/api/dev/switch-user` endpoint, the `mock` pseudo-provider
 * on the login page, mock user resolution) gates on this.
 */
export function isMockAuthEnabled(): boolean {
  return process.env.NODE_ENV !== 'production' && !isAnyProviderConfigured();
}

/**
 * Middleware that injects a mock user into the session when mock auth is
 * enabled. Does nothing in production or when OAuth credentials are present.
 */
export const mockAuth: RequestHandler = (req, _res, next) => {
  if (isMockAuthEnabled() && !req.session.user && !req.session.mockLoggedOut) {
    req.session.user = toSessionUser(MOCK_USER);
  }
  next();
};
