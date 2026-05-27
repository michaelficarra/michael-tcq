/**
 * Admin role utilities.
 *
 * Admins are configured via the comma-separated ADMIN_USERNAMES environment
 * variable. Each entry is either a bare GitHub handle (e.g. `alice`) or a
 * provider-qualified id (e.g. `github:12345`, `google:1057…`, `orcid:0000-…`)
 * — see `buildUserRefIndex` / `userMatchesIndex` in `@tcq/shared`. Admins
 * have access to a dashboard of all active meetings with connection
 * statistics and the ability to delete meetings.
 */

import type { User } from '@tcq/shared';
import { buildUserRefIndex, userMatchesIndex } from '@tcq/shared';

/** Check whether a user is an admin (matches any ADMIN_USERNAMES entry). */
export function isAdmin(user: User): boolean {
  // The env var is small and admin checks are infrequent (login, a few
  // routes), so building the index per call is cheap and keeps it live to
  // env changes in tests.
  const index = buildUserRefIndex((process.env.ADMIN_USERNAMES ?? '').split(','));
  return userMatchesIndex(user, index);
}
