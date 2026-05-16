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
import type { PremiumUsersResponse } from '@tcq/shared';
import { UserBadge } from './UserBadge.js';
import { UserCombobox } from './UserCombobox.js';
import { CircleXIcon } from './icons.js';

export function PremiumUsersPanel({ refreshTick }: { refreshTick: number }) {
  const [usernames, setUsernames] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Monotonic generation counter for response ordering. Bumped on every
  // mutation (add / remove); GET responses that resolve with an older
  // generation than the latest mutation are discarded — they would
  // otherwise overwrite a freshly-applied canonical list with stale
  // data from a poll that was in flight before the mutation fired.
  const generationRef = useRef(0);

  // GET the canonical list from the server. Called on mount and on
  // every shared refresh tick — same pattern as AdminPanel so any
  // optimistic local divergence is reconciled within ~10 s.
  const fetchUsernames = useCallback(async () => {
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
        setUsernames(body.usernames);
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
    fetchUsernames();
  }, [fetchUsernames, refreshTick]);

  /** Add a username — called when the combobox commits. */
  async function handleAdd(rawUsername: string) {
    const canonical = rawUsername.trim().toLowerCase();
    if (canonical === '' || usernames.includes(canonical)) return;
    // Optimistic insert: prepend the canonical form locally so the user
    // sees the pill immediately. Re-sort to match server order (sorted
    // lexicographically) so a subsequent poll doesn't reshuffle.
    const optimistic = [...usernames, canonical].sort();
    generationRef.current++;
    setUsernames(optimistic);
    setError(null);
    try {
      const res = await fetch('/api/admin/premium-users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: canonical }),
      });
      if (res.ok) {
        const body: PremiumUsersResponse & { ok: true } = await res.json();
        // Replace with the canonical list — this lets server-side
        // canonicalisation (case, whitespace) take effect immediately
        // rather than waiting for the next poll.
        setUsernames(body.usernames);
      } else {
        // Roll back the optimistic add and surface the server message.
        setUsernames(usernames);
        const body = await res.json().catch(() => ({}));
        setError(typeof body.error === 'string' ? body.error : 'Failed to add premium user');
      }
    } catch {
      setUsernames(usernames);
      setError('Failed to add premium user');
    }
  }

  /** Remove a username via the × button on a pill. */
  async function handleRemove(username: string) {
    const previous = usernames;
    generationRef.current++;
    setUsernames(usernames.filter((u) => u !== username));
    setError(null);
    try {
      const res = await fetch(`/api/admin/premium-users/${encodeURIComponent(username)}`, { method: 'DELETE' });
      if (!res.ok) {
        setUsernames(previous);
        const body = await res.json().catch(() => ({}));
        setError(typeof body.error === 'string' ? body.error : 'Failed to remove premium user');
      } else {
        const body: PremiumUsersResponse & { ok: true } = await res.json();
        setUsernames(body.usernames);
      }
    } catch {
      setUsernames(previous);
      setError('Failed to remove premium user');
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
          onCommit={handleAdd}
          placeholder="Add GitHub username"
          ariaLabel="Add premium user"
          inputClassName="w-full px-3 py-1.5 text-sm rounded border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900 text-stone-800 dark:text-stone-200 focus:outline-none focus:ring-2 focus:ring-teal-500"
        />

        {error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}

        {usernames.length === 0 ? (
          <p className="text-sm text-stone-600 dark:text-stone-300 italic">No premium users yet.</p>
        ) : (
          // Scrollable wrapped pill list — works for a handful of pills
          // up to several hundred without virtualisation. If the list
          // grows beyond that, swap in a virtualised renderer.
          <ul aria-label="Premium users" className="flex flex-wrap gap-2 max-h-64 overflow-y-auto">
            {usernames.map((username) => (
              // Pill styling intentionally matches the chair-list pill in
              // `AgendaPanel.tsx` (ChairsSection) — same rounded shape,
              // background, and remove-icon affordance, so admin users see
              // a single consistent "removable user pill" look across
              // the app.
              <li
                key={username}
                className="inline-flex items-center gap-1 bg-stone-200 dark:bg-stone-700 rounded-full pl-1 py-1 pr-1"
              >
                <UserBadge user={{ ghid: 0, ghUsername: username, name: username, organisation: '' }} size={18} />
                <button
                  type="button"
                  onClick={() => handleRemove(username)}
                  aria-label={`Remove ${username}`}
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
