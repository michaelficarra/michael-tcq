/**
 * My Meetings panel — shown on the home page below the join/create cards
 * for any authenticated user. Lists meetings the caller is associated with
 * (chair, presenter, queued, or has joined via socket) along with the
 * live participant count, so a returning user can re-discover and link
 * back into meetings they've previously taken part in.
 */

import { useState, useEffect, useCallback, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.js';
import { RelativeTime } from '../lib/RelativeTime.js';

interface MyMeetingInfo {
  id: string;
  /**
   * Either the literal `'now'` while at least one socket is connected to the
   * meeting, the ISO timestamp of the last time a socket was open, or the
   * empty string when nobody has ever connected (rendered as "never").
   * Mirrors the `lastConnection` shape on `/api/admin/meetings`.
   */
  lastActivity: string;
  /** Live socket count — only meaningful when `lastActivity === 'now'`. */
  currentConnections: number;
}

export function MyMeetingsPanel() {
  // The dev user-switcher updates the AuthContext in place rather than
  // reloading the page (see AuthContext's BroadcastChannel comment), so
  // we re-key our fetch on the current user's ghid. Without this, the
  // previous user's meetings would linger here until the next 10-s tick.
  const { user } = useAuth();
  const ghid = user?.ghid;
  const [meetings, setMeetings] = useState<MyMeetingInfo[]>([]);
  const [loading, setLoading] = useState(true);

  /** Render the `lastActivity` field using the same conventions as the admin meetings list. */
  function formatLastActivity(m: MyMeetingInfo): ReactNode {
    if (!m.lastActivity) return 'never';
    if (m.lastActivity === 'now') return `now (${m.currentConnections} active)`;
    return <RelativeTime timestamp={m.lastActivity} />;
  }

  /** Fetch the caller's meetings from the server. */
  const fetchMeetings = useCallback(async () => {
    try {
      const res = await fetch('/api/my-meetings');
      if (res.ok) {
        setMeetings(await res.json());
      }
    } catch {
      // Silently fail — the panel is best-effort discovery; a transient
      // network blip shouldn't paint an error onto the home page.
    } finally {
      setLoading(false);
    }
  }, []);

  // Re-fetch on mount, on each identity change, and every 10 s while
  // mounted. Resetting `meetings` and `loading` synchronously when the
  // identity changes hides the previous user's rows for the brief window
  // before the new user's data arrives, instead of letting them flash
  // through.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMeetings([]);
    setLoading(true);
    if (ghid === undefined) return;
    fetchMeetings();
    const interval = setInterval(fetchMeetings, 10_000);
    return () => clearInterval(interval);
  }, [ghid, fetchMeetings]);

  // Hide the section entirely until the first fetch resolves and when the
  // caller has no associated meetings — an empty section is just noise on
  // the join screen for a brand-new user.
  if (loading || meetings.length === 0) {
    return null;
  }

  return (
    <div className="mt-8">
      <h2 className="text-sm font-bold uppercase tracking-wider text-stone-500 dark:text-stone-400 mb-3">
        My Meetings
      </h2>

      <div className="bg-white dark:bg-stone-900 rounded-lg shadow-sm dark:shadow-stone-950/50 border border-stone-200 dark:border-stone-700 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-stone-200 dark:border-stone-700 bg-stone-50 dark:bg-stone-800 text-left">
              <th className="px-4 py-2 font-medium text-stone-600 dark:text-stone-400">Meeting ID</th>
              <th className="px-4 py-2 font-medium text-stone-600 dark:text-stone-400">Last Activity</th>
            </tr>
          </thead>
          <tbody>
            {meetings.map((m) => (
              <tr
                key={m.id}
                className="border-b border-stone-100 dark:border-stone-700 last:border-b-0 hover:bg-stone-100 dark:hover:bg-stone-800/50 transition-colors"
              >
                <td className="px-4 py-2">
                  <Link
                    to={`/meeting/${m.id}`}
                    className="text-teal-700 dark:text-teal-400 hover:text-teal-800 dark:hover:text-teal-300 font-medium transition-colors"
                  >
                    {m.id}
                  </Link>
                </td>
                <td className="px-4 py-2 text-stone-600 dark:text-stone-400">{formatLastActivity(m)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
