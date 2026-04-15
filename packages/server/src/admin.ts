/**
 * Admin role utilities.
 *
 * Admins are identified by GitHub username, configured via the
 * ADMIN_USERNAMES environment variable (comma-separated).
 * Admins have access to a dashboard showing all active meetings
 * with connection statistics and the ability to delete meetings.
 */

import type { User } from '@tcq/shared';

/** Parse the admin usernames from the environment variable. */
function getAdminUsernames(): Set<string> {
  const raw = process.env.ADMIN_USERNAMES ?? '';
  return new Set(
    raw
      .split(',')
      .map((u) => u.trim().toLowerCase())
      .filter((u) => u.length > 0),
  );
}

/** Check whether a user is an admin. */
export function isAdmin(user: User): boolean {
  return getAdminUsernames().has(user.ghUsername.toLowerCase());
}
