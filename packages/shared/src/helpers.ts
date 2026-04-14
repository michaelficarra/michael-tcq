/**
 * Derive the canonical user key from a User-like object.
 * This is the single source of truth for how users are keyed in
 * the MeetingState.users map.
 */
export function userKey(user: { ghUsername: string }): string {
  return user.ghUsername.toLowerCase();
}
