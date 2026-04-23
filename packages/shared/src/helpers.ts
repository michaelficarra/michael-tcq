import type { AgendaEntry, AgendaItem, Session, UserKey } from './types.js';

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

/** Type guard: is this agenda entry a session header? */
export function isSession(entry: AgendaEntry): entry is Session {
  return entry.kind === 'session';
}

/** Type guard: is this agenda entry a regular agenda item? */
export function isAgendaItem(entry: AgendaEntry): entry is AgendaItem {
  return entry.kind === 'item';
}

/**
 * Format a duration in minutes as a short human-friendly string.
 *
 * Examples: `0 → "0m"`, `45 → "45m"`, `60 → "1h"`, `120 → "2h"`, `315 → "5h15m"`.
 * Zero parts are dropped. Negative values are rendered with a leading `-`
 * (this is a safety net — callers should normally pass non-negative values).
 */
export function formatShortDuration(minutes: number): string {
  if (minutes === 0) return '0m';
  const negative = minutes < 0;
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  const body = h === 0 ? `${m}m` : m === 0 ? `${h}h` : `${h}h${m}m`;
  return negative ? `-${body}` : body;
}
