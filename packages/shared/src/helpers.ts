// Pull in the ES2025 Intl type slice for `Intl.DurationFormat` (used below)
// without changing the emit target. Types only — no runtime polyfill.
/// <reference lib="es2025.intl" />
import type { AgendaEntry, AgendaItem, Session, User, UserKey } from './types.js';

/**
 * Derive the canonical user key from a User-like object: the
 * `${provider}:${accountId}` pair (e.g. `github:12345`). This is the
 * single source of truth for how users are keyed in the
 * MeetingState.users map. The provider supplies an `accountId` already in
 * its canonical form (e.g. GitHub's numeric user id), so no normalisation
 * happens here.
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
 * Format a user's identity for a hover title / tooltip — always suffixed with
 * the provider so the same display name from two different providers is
 * distinguishable. The identifier is the most human-readable handle available:
 * the `@handle` when the provider has one (mirroring the mention convention),
 * else the email when one is known, else the bare account id. Examples:
 * `@alice · github`, `someone@gmail.com · google`, `0000-0002-1825-0097 · orcid`.
 *
 * Note for GitHub: `accountId` is the numeric GitHub user id, so the label
 * deliberately shows the `@handle` (login), not the id. For handle-less
 * providers whose `accountId` is opaque (Google's numeric `sub`), the email —
 * when the provider supplied one — is far more recognisable than the id.
 */
export function userLabel(user: Pick<User, 'provider' | 'accountId' | 'handle' | 'email'>): string {
  const identifier = user.handle ? `@${user.handle}` : (user.email ?? user.accountId);
  return `${identifier} · ${user.provider}`;
}

/**
 * Provider id for an unverified, free-text presenter — a name a chair typed
 * (or an agenda import produced) that didn't resolve to a real account. It
 * is not a real authentication provider; it exists so such entries get a
 * stable, collision-free `UserKey` (`placeholder:<lowercased-name>`) that
 * can't clash with a real provider's account id (e.g. a numeric GitHub id).
 */
export const PLACEHOLDER_PROVIDER = 'placeholder';

/**
 * Build a placeholder `User` for an unresolved free-text presenter name.
 * Keyed distinctly per name; carries no avatar. The directory skips these
 * because their provider isn't a real one.
 */
export function placeholderUser(name: string): User {
  return {
    provider: PLACEHOLDER_PROVIDER,
    accountId: name.toLowerCase(),
    handle: name,
    name,
    organisation: '',
    avatarUrl: '',
  };
}

// -- Admin / premium user references -------------------------------------
//
// `ADMIN_USERNAMES` and the premium list let an operator name accounts in
// either of two forms:
//   - a bare handle (e.g. `alice`) — interpreted as a GitHub handle, the
//     backward-compatible form (GitHub is the only handle-based provider);
//   - a provider-qualified id `provider:rest` (e.g. `github:12345`,
//     `google:1057…`, `orcid:0000-0002-1825-0097`), where `rest` is the
//     account id — and, for GitHub, may instead be a handle (`github:alice`).
//
// GitHub handles/ids are case-insensitive, so we lowercase them; other
// providers' account ids are opaque and case-sensitive, so we preserve them.

const GITHUB_PROVIDER = 'github';

/**
 * Canonicalise a single admin/premium reference for storage and comparison.
 * Returns null for empty/structurally-invalid input. Does not enforce a
 * provider's handle charset — callers validate that at the trust boundary.
 */
export function canonicalUserRef(raw: string): string | null {
  const e = raw.trim();
  if (e === '') return null;
  const colon = e.indexOf(':');
  if (colon === -1) {
    // bare GitHub handle — strip a leading `@` and lowercase.
    const handle = normaliseGithubUsername(e).toLowerCase();
    return handle === '' ? null : handle;
  }
  const provider = e.slice(0, colon).toLowerCase();
  const rest = e.slice(colon + 1);
  if (provider === '' || rest === '') return null;
  // GitHub's `rest` (handle or numeric id) is case-insensitive; everything
  // else is an opaque, case-sensitive account id.
  return provider === GITHUB_PROVIDER ? `${provider}:${rest.toLowerCase()}` : `${provider}:${rest}`;
}

/**
 * Pre-indexed admin/premium reference list for O(1) membership checks.
 * `keys` holds canonical `provider:accountId` keys; `githubHandles` holds
 * lowercased GitHub handles (from bare entries and `github:<handle>` entries).
 */
export interface UserRefIndex {
  keys: Set<string>;
  githubHandles: Set<string>;
}

/** Build a `UserRefIndex` from raw reference strings (each canonicalised). */
export function buildUserRefIndex(refs: readonly string[]): UserRefIndex {
  const keys = new Set<string>();
  const githubHandles = new Set<string>();
  for (const raw of refs) {
    const ref = canonicalUserRef(raw);
    if (ref === null) continue;
    const colon = ref.indexOf(':');
    if (colon === -1) {
      githubHandles.add(ref); // canonical bare = lowercased handle
      continue;
    }
    const provider = ref.slice(0, colon);
    const rest = ref.slice(colon + 1);
    keys.add(ref);
    // A `github:<rest>` entry also matches by handle (rest already lowercased).
    if (provider === GITHUB_PROVIDER) githubHandles.add(rest);
  }
  return { keys, githubHandles };
}

/** Whether `user` matches any reference in the index (by key, or — for a
 *  GitHub user — by handle). O(1). */
export function userMatchesIndex(user: Pick<User, 'provider' | 'accountId' | 'handle'>, index: UserRefIndex): boolean {
  if (index.keys.has(userKey(user))) return true;
  return user.provider === GITHUB_PROVIDER && !!user.handle && index.githubHandles.has(user.handle.toLowerCase());
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
