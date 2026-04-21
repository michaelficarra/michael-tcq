import type { UserKey } from './types.js';

/**
 * Derive the canonical user key from a User-like object.
 * This is the single source of truth for how users are keyed in
 * the MeetingState.users map.
 */
export function userKey(user: { ghUsername: string }): UserKey {
  return user.ghUsername.toLowerCase() as UserKey;
}

/**
 * Brand an already-normalised (lowercased) username as a UserKey.
 * Use this at trust boundaries — for example, when accepting a username
 * string from a wire payload and using it to index `meeting.users`. The
 * caller is asserting that the string is equivalent to what `userKey()`
 * would produce from the corresponding `User` object.
 */
export function asUserKey(s: string): UserKey {
  return s as UserKey;
}
