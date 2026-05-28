/**
 * PremiumUsersPanel — admin-only section for managing the TCQ Premium™
 * user list at runtime. Previously a static `PREMIUM_USERNAMES` env var;
 * now mutated through `/api/admin/premium-users` and persisted in the
 * `AppSettings` document.
 *
 * Layout, top to bottom:
 *   1. Section header.
 *   2. Single-mode `UserCombobox` as the *add* input. We deliberately
 *      avoid `mode="multi"` here: chip-input multi mode would render
 *      every premium subscriber inline, which doesn't scale.
 *   3. Scrollable wrapped pill list. Each pill is a `<UserBadge>`
 *      plus an × remove button.
 *
 * State sync follows the same optimistic + 10-second-poll pattern used
 * by AdminPanel for soft-delete: local state updates immediately on
 * commit, and the shared `refreshTick` GETs the canonical list so any
 * drift self-heals.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PremiumUser, PremiumUsersResponse, User } from '@tcq/shared';
import { userKey } from '@tcq/shared';
import { useToast } from '../contexts/ToastContext.js';
import { UserBadge } from './UserBadge.js';
import { UserCombobox, type SelectedUser } from './UserCombobox.js';
import { CircleXIcon } from './icons.js';

/**
 * Reduce a directory selection (or free-text) to the premium reference to
 * store: a GitHub pick → its handle (the back-compat bare form); a non-GitHub
 * pick → its `provider:accountId` key; free text → the typed string (which may
 * itself be a `provider:id`). The server canonicalises and validates it.
 */
function selectionToPremiumRef(sel: SelectedUser): string {
  if (!('user' in sel)) return sel.handle;
  const { user } = sel;
  return user.provider === 'github' ? (user.handle ?? user.accountId) : userKey(user);
}

/** Build a display-only `User` from a stored premium reference, used only as
 *  the optimistic placeholder while a freshly-added pill awaits the server's
 *  resolved entry (which carries the real display name and avatar). Kept
 *  provider-neutral — the parse mirrors `canonicalUserRef`'s format (bare → a
 *  GitHub handle; `provider:rest` → that provider's account id) and the avatar
 *  is left blank (the badge shows a silhouette) until the resolved entry lands
 *  a moment later. */
function refToUser(ref: string): User {
  const colon = ref.indexOf(':');
  if (colon === -1) {
    return { provider: 'github', accountId: ref, handle: ref, name: ref, organisation: '', avatarUrl: '' };
  }
  const provider = ref.slice(0, colon);
  const rest = ref.slice(colon + 1);
  return { provider, accountId: rest, name: rest, organisation: '', avatarUrl: '' };
}

export function PremiumUsersPanel({ refreshTick }: { refreshTick: number }) {
  const { showToast } = useToast();
  // Resolved entries (canonical ref + display profile), sorted by ref to match
  // the server. The ref is the identity key for dedup/remove; the user drives
  // the badge.
  const [entries, setEntries] = useState<PremiumUser[]>([]);
  const [loading, setLoading] = useState(true);
  // Monotonic generation counter for response ordering. Bumped on every
  // mutation (add / remove); GET responses that resolve with an older
  // generation than the latest mutation are discarded — they would
  // otherwise overwrite a freshly-applied canonical list with stale
  // data from a poll that was in flight before the mutation fired.
  const generationRef = useRef(0);

  // GET the canonical list from the server. Called on mount and on
  // every shared refresh tick — same pattern as AdminPanel so any
  // optimistic local divergence is reconciled within ~10 s.
  const fetchEntries = useCallback(async () => {
    // Capture the generation at fetch start so we can compare on resolve.
    const myGen = generationRef.current;
    try {
      const res = await fetch('/api/admin/premium-users');
      if (res.ok) {
        const body: PremiumUsersResponse = await res.json();
        // Discard if a mutation has happened since this GET fired — the
        // mutation's response is authoritative and has already updated
        // state.
        if (myGen !== generationRef.current) return;
        setEntries(body.users);
      }
    } catch {
      // Silently swallow — same posture as AdminPanel. The next tick
      // will retry; transient network blips shouldn't replace the list
      // with an empty state.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Intentional polled fetch — setState lands asynchronously after
    // the response, not synchronously inside the effect body.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchEntries();
  }, [fetchEntries, refreshTick]);

  /** Add a reference — called when the combobox commits. The server
   *  canonicalises (case, `@`, provider prefix); we send the raw value. */
  async function handleAdd(rawUsername: string) {
    const value = rawUsername.trim();
    if (value === '' || entries.some((e) => e.ref === value)) return;
    const previous = entries;
    // Optimistic insert so the pill appears immediately; the placeholder
    // carries a synthesised avatar until the server's resolved entry (real
    // display name + avatar) replaces it. Sort by ref to match the server.
    const optimistic = [...entries, { ref: value, user: refToUser(value) }].sort((a, b) => a.ref.localeCompare(b.ref));
    generationRef.current++;
    setEntries(optimistic);
    try {
      const res = await fetch('/api/admin/premium-users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: value }),
      });
      if (res.ok) {
        const body: PremiumUsersResponse & { ok: true } = await res.json();
        // Replace with the canonical, resolved list — this lets server-side
        // canonicalisation (case, whitespace) and profile resolution take
        // effect immediately rather than waiting for the next poll.
        setEntries(body.users);
      } else {
        // Roll back the optimistic add and surface the server message.
        setEntries(previous);
        const body = await res.json().catch(() => ({}));
        showToast({ message: typeof body.error === 'string' ? body.error : 'Failed to add premium user' });
      }
    } catch {
      setEntries(previous);
      showToast({ message: 'Failed to add premium user' });
    }
  }

  /** Remove a premium user via the × button on a pill, keyed by canonical ref. */
  async function handleRemove(ref: string) {
    const previous = entries;
    generationRef.current++;
    setEntries(entries.filter((e) => e.ref !== ref));
    try {
      const res = await fetch(`/api/admin/premium-users/${encodeURIComponent(ref)}`, { method: 'DELETE' });
      if (!res.ok) {
        setEntries(previous);
        const body = await res.json().catch(() => ({}));
        showToast({ message: typeof body.error === 'string' ? body.error : 'Failed to remove premium user' });
      } else {
        const body: PremiumUsersResponse & { ok: true } = await res.json();
        setEntries(body.users);
      }
    } catch {
      setEntries(previous);
      showToast({ message: 'Failed to remove premium user' });
    }
  }

  if (loading) return null;

  return (
    <div className="mt-8">
      <h2 className="text-sm font-bold uppercase tracking-wider text-stone-500 dark:text-stone-400 mb-3">
        Premium Users
      </h2>

      <div className="bg-white dark:bg-stone-900 rounded-lg shadow-sm dark:shadow-stone-950/50 border border-stone-200 dark:border-stone-700 p-4 space-y-3">
        <UserCombobox
          mode="single"
          onCommit={(sel: SelectedUser) => handleAdd(selectionToPremiumRef(sel))}
          placeholder="GitHub username or provider:id"
          ariaLabel="Add premium user"
          // Fill the panel width so the full placeholder is readable — the
          // combobox wrapper is content-width (inline-block) by default.
          wrapperClassName="w-full"
          inputClassName="w-full px-3 py-1.5 text-sm rounded border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900 text-stone-800 dark:text-stone-200 focus:outline-none focus:ring-2 focus:ring-teal-500"
        />

        {entries.length === 0 ? (
          <p className="text-sm text-stone-600 dark:text-stone-300 italic">No premium users yet.</p>
        ) : (
          // Scrollable wrapped pill list — works for a handful of pills
          // up to several hundred without virtualisation. If the list
          // grows beyond that, swap in a virtualised renderer.
          <ul aria-label="Premium users" className="flex flex-wrap gap-2 max-h-64 overflow-y-auto">
            {entries.map(({ ref, user }) => (
              // Pill styling intentionally matches the chair-list pill in
              // `AgendaPanel.tsx` (ChairsSection) — same rounded shape,
              // background, and remove-icon affordance, so admin users see
              // a single consistent "removable user pill" look across
              // the app.
              <li
                key={ref}
                className="inline-flex items-center gap-1 bg-stone-200 dark:bg-stone-700 rounded-full pl-1 py-1 pr-1"
              >
                <UserBadge user={user} size={18} />
                <button
                  type="button"
                  onClick={() => handleRemove(ref)}
                  aria-label={`Remove ${ref}`}
                  className="text-red-400 hover:text-red-600 dark:hover:text-red-400 transition-colors cursor-pointer"
                >
                  <CircleXIcon />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
