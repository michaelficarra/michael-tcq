/**
 * Resolve a `UserSelection` (committed by a client user-selector) into a full
 * `User`, provider-neutrally.
 *
 * Two selection shapes (see `UserSelectionSchema` in `@tcq/shared`):
 *   - `{ provider, accountId }` — a concrete account picked from the
 *     directory. We never trust client-supplied display fields, so the
 *     identity is re-resolved to an authoritative profile: first cheaply
 *     (it's the acting user, or already a meeting participant), otherwise via
 *     the provider's `resolveByAccountId`.
 *   - `{ handle }` — free text typed without picking a suggestion. Resolved
 *     via the searcher's provider `resolveByHandle` (GitHub today), falling
 *     back to an unverified `placeholder:` user.
 *
 * A synchronous fast path (`resolveSelectionsSync`) covers the cases that
 * don't need a provider API call, preserving the per-handler event ordering
 * that the socket handlers rely on when no network round-trip is needed (see
 * the note on the agenda-add handler). Only genuinely-remote lookups await.
 */

import type { MeetingState, User, UserKey, UserSelection } from '@tcq/shared';
import { userKey, placeholderUser } from '@tcq/shared';
import type { SessionUser } from './session.js';
import { isMockAuthEnabled } from './mockAuth.js';
import { providerById } from './auth/registry.js';
import { findUserByHandle } from './auth/githubUser.js';
import { mockUserFromLogin, mockUserFromId } from './mockUser.js';

/**
 * Whether a selection refers to the acting user themselves — used by the
 * chair handler's "you can't remove yourself" guard, before resolution.
 * `{provider,accountId}` matches by key; `{handle}` matches the user's handle.
 */
export function selectionIsSelf(
  user: { provider: string; accountId: string; handle?: string },
  sel: UserSelection,
): boolean {
  if ('handle' in sel) return !!user.handle && user.handle.toLowerCase() === sel.handle.toLowerCase();
  return user.provider === sel.provider && user.accountId === sel.accountId;
}

/** Strip server-only session fields so a resolved acting user is stored as a
 *  plain `User` (no `isAdmin` / `accessToken` leaking into meeting state). */
function sessionAsUser(session: SessionUser): User {
  const { isAdmin: _isAdmin, accessToken: _accessToken, ...user } = session;
  void _isAdmin;
  void _accessToken;
  return user;
}

/**
 * Resolve one selection without any network call, or return `null` when a
 * provider API round-trip is required (OAuth-mode account/handle not already
 * known). Mock-auth mode resolves everything synchronously (no API).
 */
function resolveSelectionSync(
  session: SessionUser,
  meeting: MeetingState | undefined,
  sel: UserSelection,
): User | null {
  if ('handle' in sel) {
    const handle = sel.handle;
    if (session.handle?.toLowerCase() === handle.toLowerCase()) return sessionAsUser(session);
    const known = findUserByHandle(meeting, handle);
    if (known) return known;
    // Dev (mock-auth) mode: resolve synchronously via the seed-aware helper.
    if (isMockAuthEnabled()) return mockUserFromLogin(handle);
    return null;
  }
  const key = userKey(sel);
  if (userKey(session) === key) return sessionAsUser(session);
  const known = meeting?.users[key as UserKey];
  if (known) return known;
  // Dev mode: re-resolve a picked id via the seed (null if not a seed member).
  if (isMockAuthEnabled()) return mockUserFromId(sel.accountId);
  return null;
}

/** Resolve one selection, awaiting a provider lookup when the sync path can't. */
async function resolveSelection(
  session: SessionUser,
  meeting: MeetingState | undefined,
  sel: UserSelection,
): Promise<User | null> {
  const sync = resolveSelectionSync(session, meeting, sel);
  if (sync) return sync;
  if ('handle' in sel) {
    // Free-text path: resolve against the searcher's provider; an unresolved
    // handle becomes a placeholder so the typed name still renders.
    const resolved = await providerById(session.provider)?.resolveByHandle?.(sel.handle);
    return resolved ?? placeholderUser(sel.handle);
  }
  // Picked-account path: re-resolve the identity to an authoritative profile.
  // Null (account gone, or provider has no id lookup) is surfaced to callers.
  return (await providerById(sel.provider)?.resolveByAccountId?.(sel.accountId)) ?? null;
}

/**
 * Resolve a list of selections to `User[]`, synchronously when every entry
 * resolves without a network call (mirrors the old `resolvePresentersFor`
 * sync-return contract), otherwise as a Promise. Entries that can't be
 * resolved at all (e.g. a picked account that no longer exists) are dropped.
 */
export function resolveSelections(
  session: SessionUser,
  meeting: MeetingState | undefined,
  selections: UserSelection[],
): User[] | Promise<User[]> {
  const sync = selections.map((sel) => resolveSelectionSync(session, meeting, sel));
  if (sync.every((u): u is User => u !== null)) return sync;
  return Promise.all(selections.map((sel) => resolveSelection(session, meeting, sel))).then((users) =>
    users.filter((u): u is User => u !== null),
  );
}

/** Resolve a single selection (await form). Null when it can't be resolved. */
export async function resolveOneSelection(
  session: SessionUser,
  meeting: MeetingState | undefined,
  sel: UserSelection,
): Promise<User | null> {
  return resolveSelection(session, meeting, sel);
}

/**
 * Resolve a typed handle (the free-text path) to a User, used where the wire
 * still carries a bare handle rather than a selection (queue `asUsername`).
 * Never null — an unresolved handle becomes a placeholder.
 */
export async function resolveHandle(
  session: SessionUser,
  meeting: MeetingState | undefined,
  handle: string,
): Promise<User> {
  const u = await resolveSelection(session, meeting, { handle });
  // resolveSelection on a `{handle}` only returns null in the (impossible)
  // case of a provider with no resolveByHandle; default to a placeholder.
  return u ?? placeholderUser(handle);
}
