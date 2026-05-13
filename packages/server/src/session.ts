/**
 * Session type augmentation.
 *
 * Extends the express-session types to include our custom fields.
 * This file is imported by index.ts to ensure the augmentation is
 * available everywhere.
 */

import type { User } from '@tcq/shared';
import { isAdmin } from './admin.js';
import { isPremium } from './premium.js';

/**
 * The authenticated user as stored on the session. `User` plus a cached
 * `isAdmin` flag — computed once on login (`toSessionUser`) so request
 * handlers read a typed property instead of re-parsing the admin env var.
 *
 * `accessToken` is the OAuth bearer obtained at the end of the GitHub
 * OAuth callback. It is held server-side only and used for autocomplete-
 * directory refreshes and tier-3 GitHub user search on behalf of the
 * logged-in user. Strip it before serialising the session user to any
 * client (see `toClientUser`).
 */
export type SessionUser = User & { isAdmin: boolean; accessToken?: string };

/** Attach `isAdmin` to a User to produce the session-shaped record. */
export function toSessionUser(user: User): SessionUser {
  return { ...user, isAdmin: isAdmin(user) };
}

/**
 * Strip server-only fields (currently `accessToken`) from a SessionUser
 * before sending it to the client. Use at every API boundary that returns
 * the current user, so a credential never leaks even if another endpoint
 * grows a careless `res.json(req.session.user)`.
 *
 * Both `isAdmin` and `isPremium` use the omit-when-false strategy: each
 * field is only present (`: true`) when the user qualifies and is omitted
 * entirely otherwise. Saves the `"isAdmin":false` / `"isPremium":false`
 * overhead on every /api/me response for the common case; the client
 * already treats absence as falsy.
 *
 * `isPremium` is re-evaluated per response (not cached on the session)
 * to match the Socket.IO broadcast path's `stampPremium`, so changes to
 * `PREMIUM_USERNAMES` propagate without forcing a re-login.
 */
export function toClientUser(user: SessionUser): User & { isAdmin?: true; isPremium?: true } {
  // Strip `isPremium` from the input as well — this function is the
  // authority on the wire-side flag, recomputed from the env var below.
  const { accessToken: _accessToken, isAdmin, isPremium: _isPremium, ...rest } = user;
  void _accessToken;
  void _isPremium;
  const result: User & { isAdmin?: true; isPremium?: true } = { ...rest };
  if (isAdmin) result.isAdmin = true;
  if (isPremium(rest)) result.isPremium = true;
  return result;
}

declare module 'express-session' {
  interface SessionData {
    /** The authenticated GitHub user, set after OAuth callback. */
    user?: SessionUser;

    /**
     * URL to redirect to after authentication. Set when an
     * unauthenticated user tries to access a protected route.
     */
    returnTo?: string;

    /**
     * When true, mock auth will not auto-populate a user.
     * Set by /auth/logout in mock auth mode to allow testing the logged-out state.
     */
    mockLoggedOut?: boolean;
  }
}
