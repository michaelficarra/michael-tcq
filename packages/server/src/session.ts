/**
 * Session type augmentation.
 *
 * Extends the express-session types to include our custom fields.
 * This file is imported by index.ts to ensure the augmentation is
 * available everywhere.
 */

import type { User } from '@tcq/shared';

declare module 'express-session' {
  interface SessionData {
    /** The authenticated GitHub user, set after OAuth callback. */
    user?: User;

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
