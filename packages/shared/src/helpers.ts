// Pull in the ES2025 Intl type slice for `Intl.DurationFormat` (used below)
// without changing the emit target. Types only — no runtime polyfill.
/// <reference lib="es2025.intl" />
import type { AgendaEntry, AgendaItem, Session, User, UserKey } from './types.js';

/**
 * Derive the canonical user key from a User-like object: the
 * `${provider}:${accountId}` pair (e.g. `github:alice`). This is the
 * single source of truth for how users are keyed in the
 * MeetingState.users map. The provider supplies an `accountId` that is
 * already in its canonical form (GitHub lowercases its login), so no
 * normalisation happens here.
 */
export function userKey(user: { provider: string; accountId: string }): UserKey {
  return `${user.provider}:${user.accountId}` as UserKey;
}

/**
 * Brand an already-canonical `${provider}:${accountId}` string as a
 * UserKey. Use this at trust boundaries — for example, when accepting a
 * key string from a wire payload and using it to index `meeting.users`.
 * The caller is asserting that the string is equivalent to what
 * `userKey()` would produce from the corresponding `User` object. Note
 * this is NOT for branding a bare handle: a typed-in login must be
 * resolved to a `User` (and thus a `{provider, accountId}`) first.
 */
export function asUserKey(s: string): UserKey {
  return s as UserKey;
}

/**
 * Format a user's identity for a hover title / tooltip: the human-readable
 * handle when the provider has one (prefixed with `@`, mirroring the
 * mention convention), otherwise the bare account identifier — always
 * suffixed with the provider so the same display name from two different
 * providers is distinguishable. Examples: `@alice · github`,
 * `0000-0002-1825-0097 · orcid`.
 */
export function userLabel(user: Pick<User, 'provider' | 'accountId' | 'handle'>): string {
  const identifier = user.handle ? `@${user.handle}` : user.accountId;
  return `${identifier} · ${user.provider}`;
}

/**
 * Normalise a GitHub-username text input by trimming surrounding
 * whitespace and stripping a single leading `@` (with any whitespace
 * between the `@` and the name). Returns the bare username; an empty
 * string indicates the input was nothing but whitespace and/or `@`.
 *
 * Examples:
 *   "alice"       → "alice"
 *   " alice "     → "alice"
 *   "@alice"      → "alice"
 *   " @ alice "   → "alice"
 *   " @ "         → ""
 */
export function normaliseGithubUsername(raw: string): string {
  return raw.trim().replace(/^@\s*/, '');
}

/** Type guard: is this agenda entry a session header? */
export function isSession(entry: AgendaEntry): entry is Session {
  return entry.kind === 'session';
}

/** Type guard: is this agenda entry a regular agenda item? */
export function isAgendaItem(entry: AgendaEntry): entry is AgendaItem {
  return entry.kind === 'item';
}

export type DurationStyle = 'long' | 'short' | 'narrow';
export type DurationParts = { days?: number; hours?: number; minutes?: number; seconds?: number };

const DURATION_UNITS = ['days', 'hours', 'minutes', 'seconds'] as const;

// Hand-written fallback labels, used only when Intl.DurationFormat is unavailable
// (pre-2025 browsers) or for the all-zero case the native API can't render. Keeps
// us free of any polyfill dependency. `glue` joins a number to its unit label;
// `sep` joins the unit segments together.
const DURATION_FALLBACK = {
  narrow: { sep: ' ', glue: '', d: 'd', h: 'h', m: 'm', s: 's' },
  short: { sep: ', ', glue: ' ', d: 'day', h: 'hr', m: 'min', s: 'sec' },
  long: { sep: ', ', glue: ' ', d: 'day', h: 'hour', m: 'minute', s: 'second' },
} as const;

/**
 * Format a balanced duration as a localised, auto-pluralised string via
 * `Intl.DurationFormat`, with a hand-written fallback when it's unavailable.
 *
 * Callers pass a pre-balanced parts object (zero-valued units are omitted by the
 * native API). Locale is left to the runtime default to honour the viewer's locale.
 *
 * Examples (en): `{minutes:45}, 'narrow' → "45m"`, `{hours:1,minutes:30}, 'narrow' → "1h 30m"`,
 * `{hours:1,minutes:5}, 'short' → "1 hr, 5 min"`.
 */
export function formatDuration(parts: DurationParts, style: DurationStyle): string {
  const present = DURATION_UNITS.filter((u) => parts[u] !== undefined);
  const nonzero = present.filter((u) => parts[u] !== 0);

  // Native path. Skipped for an all-zero duration because Intl.DurationFormat
  // returns "" for it (and throws on a fully empty parts object).
  if (typeof Intl.DurationFormat !== 'undefined' && nonzero.length > 0) {
    return new Intl.DurationFormat(undefined, { style }).format(parts);
  }

  // Manual fallback. For the all-zero case, emit "0<smallest requested unit>".
  const f = DURATION_FALLBACK[style];
  const units = nonzero.length > 0 ? nonzero : [present[present.length - 1] ?? 'seconds'];
  return units
    .map((u) => {
      const n = parts[u] ?? 0;
      const key = u[0] as 'd' | 'h' | 'm' | 's';
      const label = style === 'long' ? `${f[key]}${n === 1 ? '' : 's'}` : f[key];
      return `${n}${f.glue}${label}`;
    })
    .join(f.sep);
}

/**
 * Format a duration in minutes as a short human-friendly string.
 *
 * Examples: `0 → "0m"`, `45 → "45m"`, `60 → "1h"`, `120 → "2h"`, `90 → "1h 30m"`.
 * Callers pass non-negative values.
 */
export function formatShortDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const parts = h === 0 ? { minutes: m } : m === 0 ? { hours: h } : { hours: h, minutes: m };
  return formatDuration(parts, 'narrow');
}
