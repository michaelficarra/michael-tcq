/**
 * A process-wide cache of every real `User` the server has seen this process
 * lifetime — provider-agnostic, used as a last-resort fallback when a user is
 * *referenced* somewhere (an agenda presenter, a chair added by reference, a
 * premium-list entry) before they have a resolvable identity in hand.
 *
 * Why it exists: GitHub and ORCID both have a public lookup-by-id, so a stored
 * `provider:accountId` reference can always be re-resolved to a real name and
 * avatar. Google deliberately does not — there is no public way to turn a
 * `sub` into a profile. Without this cache a Google user referenced before
 * they join would render as a silhouette + bare numeric `sub`. By recording
 * every user at login and at every meeting-user write, any Google (or ORCID,
 * or GitHub) user who has *ever* been seen on this server resolves with their
 * real name + avatar wherever they're referenced.
 *
 * The cache is intentionally simple: an unbounded `Map` keyed by `UserKey`.
 * It's bounded in practice by the server's user base, and it's rebuilt from
 * the persisted meetings at boot (see `MeetingManager.restore`), so there's no
 * persistence or eviction to manage here.
 */

import type { User, UserKey } from '@tcq/shared';
import { userKey, PLACEHOLDER_PROVIDER } from '@tcq/shared';

const knownUsers = new Map<UserKey, User>();

/**
 * Record a real user in the cache (idempotent upsert). Placeholder users —
 * unresolved free-text names — are ignored so they never poison a real key,
 * as are users with an empty provider/accountId. Last write wins, so a fresher
 * profile (a rename, a new avatar) supersedes an older cached entry.
 */
export function recordUser(user: User): void {
  if (user.provider === PLACEHOLDER_PROVIDER) return;
  if (user.provider === '' || user.accountId === '') return;
  knownUsers.set(userKey(user), user);
}

/** Look up a known user by canonical key. O(1). */
export function getKnownUser(key: UserKey): User | undefined {
  return knownUsers.get(key);
}

/** Look up a known user by provider + account id. Convenience over `getKnownUser`. */
export function getKnownUserByProviderAccount(provider: string, accountId: string): User | undefined {
  return knownUsers.get(userKey({ provider, accountId }));
}

/**
 * Find a known user whose handle matches (case-insensitive). Used by the
 * free-text resolution path, which only has a typed handle to go on. A linear
 * scan is fine: the cache is bounded by the user base and this only runs when
 * the cheaper key/meeting lookups have already missed.
 */
export function getKnownUserByHandle(handle: string): User | undefined {
  const h = handle.toLowerCase();
  for (const user of knownUsers.values()) {
    if (user.handle && user.handle.toLowerCase() === h) return user;
  }
  return undefined;
}

/** Clear the cache (tests). */
export function resetKnownUsersForTesting(): void {
  knownUsers.clear();
}
