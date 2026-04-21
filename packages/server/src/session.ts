/**
 * Session type augmentation.
 *
 * Extends the express-session types to include our custom fields.
 * This file is imported by index.ts to ensure the augmentation is
 * available everywhere.
 */

import type { User } from '@tcq/shared';
import { isAdmin } from './admin.js';

/**
 * The authenticated user as stored on the session. `User` plus a cached
 * `isAdmin` flag — computed once on login (`toSessionUser`) so request
 * handlers read a typed property instead of re-parsing the admin env var.
 */
export type SessionUser = User & { isAdmin: boolean };

/** Attach `isAdmin` to a User to produce the session-shaped record. */
export function toSessionUser(user: User): SessionUser {
  return { ...user, isAdmin: isAdmin(user) };
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
