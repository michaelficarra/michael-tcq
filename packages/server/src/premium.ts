/**
 * Premium tier utilities.
 *
 * Premium users are identified by GitHub username, configured via the
 * PREMIUM_USERNAMES environment variable (comma-separated). The premium
 * tier currently grants an animated border on the user's queue entries,
 * but the flag is intentionally generic — additional premium-tier
 * features may be gated on it in the future.
 */

import type { User } from '@tcq/shared';

/** Parse the premium usernames from the environment variable. */
function getPremiumUsernames(): Set<string> {
  const raw = process.env.PREMIUM_USERNAMES ?? '';
  return new Set(
    raw
      .split(',')
      .map((u) => u.trim().toLowerCase())
      .filter((u) => u.length > 0),
  );
}

/** Check whether a user belongs to the premium tier. */
export function isPremium(user: User): boolean {
  return getPremiumUsernames().has(user.ghUsername.toLowerCase());
}
