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
import { githubUser } from './auth/githubUser.js';

// The mock user is a GitHub account (`github:admin`) so dev keys match the
// shape real GitHub auth and the migration produce.
export const MOCK_USER: User = githubUser({ login: 'admin', name: 'Admin' });

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
