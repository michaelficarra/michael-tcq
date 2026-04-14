/**
 * Mock authentication middleware for development.
 *
 * When GitHub OAuth credentials are not configured (GITHUB_CLIENT_ID is
 * empty), this middleware automatically sets a fake user on every
 * request's session. This allows features to be developed and tested
 * without creating a GitHub OAuth App.
 *
 * When OAuth credentials ARE configured, this middleware does nothing
 * and real GitHub authentication is used instead.
 */

import type { RequestHandler } from 'express';
import type { User } from '@tcq/shared';
// Import session augmentation for the User type on SessionData
import './session.js';

export const MOCK_USER: User = {
  ghid: 1,
  ghUsername: 'admin',
  name: 'Admin',
  organisation: '',
};

/**
 * Returns true if GitHub OAuth is configured (client ID is set).
 * When true, mock auth is skipped and real OAuth is used.
 */
export function isOAuthConfigured(): boolean {
  return !!process.env.GITHUB_CLIENT_ID;
}

/**
 * Middleware that injects a mock user into the session when OAuth
 * is not configured. Does nothing when OAuth credentials are present.
 */
export const mockAuth: RequestHandler = (req, _res, next) => {
  if (!isOAuthConfigured() && !req.session.user && !req.session.mockLoggedOut) {
    req.session.user = MOCK_USER;
  }
  next();
};
