/**
 * Admin role utilities.
 *
 * Admins are identified by GitHub username (handle), configured via the
 * ADMIN_USERNAMES environment variable (comma-separated). Matching is by
 * handle rather than by user key because a GitHub user's key is now
 * `github:<numeric-id>`, which an operator configuring the env var wouldn't
 * know. Admins have access to a dashboard showing all active meetings with
 * connection statistics and the ability to delete meetings.
 */

import type { User } from '@tcq/shared';
import { GITHUB_PROVIDER_ID } from './auth/githubUser.js';

/** Parse the comma-separated admin handles from the environment variable. */
function getAdminHandles(): Set<string> {
  const raw = process.env.ADMIN_USERNAMES ?? '';
  return new Set(
    raw
      .split(',')
      .map((u) => u.trim().toLowerCase())
      .filter((u) => u.length > 0),
  );
}

/** Check whether a user is an admin. Only GitHub accounts can be admins for
 *  now, matched by their (lowercased) handle. */
export function isAdmin(user: User): boolean {
  if (user.provider !== GITHUB_PROVIDER_ID || !user.handle) return false;
  return getAdminHandles().has(user.handle.toLowerCase());
}
