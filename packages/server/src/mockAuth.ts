/**
 * Mock authentication middleware for development.
 *
 * When no authentication provider is configured, this middleware
 * automatically sets a fake user on every request's session. This allows
 * features to be developed and tested without creating an OAuth App.
 *
 * When any provider IS configured, this middleware does nothing and real
 * OAuth is used instead.
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
 * Returns true if any authentication provider is configured. When true,
 * mock auth is skipped and real OAuth is used. Retains the historical name
 * `isOAuthConfigured` (now a thin alias) so the many call sites that gate
 * mock-only behaviour on it don't need to change.
 */
export function isOAuthConfigured(): boolean {
  return isAnyProviderConfigured();
}

/**
 * Middleware that injects a mock user into the session when OAuth
 * is not configured. Does nothing when OAuth credentials are present.
 */
export const mockAuth: RequestHandler = (req, _res, next) => {
  if (!isOAuthConfigured() && !req.session.user && !req.session.mockLoggedOut) {
    req.session.user = toSessionUser(MOCK_USER);
  }
  next();
};
