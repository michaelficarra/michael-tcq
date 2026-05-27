/**
 * Admin role utilities.
 *
 * Admins are identified by user key, configured via the ADMIN_USERNAMES
 * environment variable (comma-separated). Each entry is either a full
 * `${provider}:${accountId}` key (e.g. `github:alice`) or a bare GitHub
 * username, which is expanded to `github:<lower>` for backward
 * compatibility. Admins have access to a dashboard showing all active
 * meetings with connection statistics and the ability to delete meetings.
 */

import type { User } from '@tcq/shared';
import { userKey, migrateKey } from '@tcq/shared';

/** Parse the admin keys from the environment variable, expanding bare
 *  GitHub usernames to `github:` keys (via `migrateKey`). */
function getAdminKeys(): Set<string> {
  const raw = process.env.ADMIN_USERNAMES ?? '';
  return new Set(
    raw
      .split(',')
      .map((u) => u.trim().toLowerCase())
      .filter((u) => u.length > 0)
      .map((u) => migrateKey(u) as string),
  );
}

/** Check whether a user is an admin. */
export function isAdmin(user: User): boolean {
  return getAdminKeys().has(userKey(user));
}
