/**
 * Admin panel — shown on the home page below the join/create cards
 * for users with admin privileges. Lists all active meetings with
 * connection statistics and a delete button for each.
 */

import { useState, useEffect, useCallback, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { RelativeTime } from '../lib/RelativeTime.js';

interface MeetingInfo {
  id: string;
  chairCount: number;
  agendaItemCount: number;
  queuedSpeakerCount: number;
  maxConcurrent: number;
  currentConnections: number;
  lastConnection: string;
}

export function AdminPanel() {
  const [meetings, setMeetings] = useState<MeetingInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  /** Fetch the list of meetings from the admin endpoint. */
  const fetchMeetings = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/meetings');
      if (res.ok) {
        setMeetings(await res.json());
      }
    } catch {
      // Silently fail
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMeetings();
    // Refresh every 10 seconds
    const interval = setInterval(fetchMeetings, 10_000);
    return () => clearInterval(interval);
  }, [fetchMeetings]);

  /** Delete a meeting after confirmation. */
  async function handleDelete(meetingId: string) {
    const res = await fetch(`/api/admin/meetings/${encodeURIComponent(meetingId)}`, {
      method: 'DELETE',
    });
    if (res.ok) {
      setMeetings((prev) => prev.filter((m) => m.id !== meetingId));
    }
    setDeleteConfirm(null);
  }

  /** Format the last connection time for display. */
  function formatLastConnection(m: MeetingInfo): ReactNode {
    if (!m.lastConnection) return 'never';
    if (m.lastConnection === 'now') return `now (${m.currentConnections})`;
    // `lastConnection` is already an ISO string from the server; surface
    // it verbatim in the tooltip so hovering shows the exact timestamp.
    return <RelativeTime timestamp={m.lastConnection} title={m.lastConnection} />;
  }

  if (loading) {
    return null;
  }

  return (
    <div className="mt-8">
      <h2 className="text-sm font-bold uppercase tracking-wider text-stone-500 dark:text-stone-400 mb-3">
        Admin — Active Meetings
      </h2>

      {meetings.length === 0 ? (
        <p className="text-sm text-stone-400 dark:text-stone-500 italic">No active meetings.</p>
      ) : (
        <div className="bg-white dark:bg-stone-900 rounded-lg shadow-sm dark:shadow-stone-950/50 border border-stone-200 dark:border-stone-700 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-stone-200 dark:border-stone-700 bg-stone-50 dark:bg-stone-800 text-left">
                <th className="px-4 py-2 font-medium text-stone-600 dark:text-stone-400">Meeting ID</th>
                <th className="px-4 py-2 font-medium text-stone-600 dark:text-stone-400">Chairs</th>
                <th className="px-4 py-2 font-medium text-stone-600 dark:text-stone-400">Agenda</th>
                <th className="px-4 py-2 font-medium text-stone-600 dark:text-stone-400">Queue</th>
                <th className="px-4 py-2 font-medium text-stone-600 dark:text-stone-400">Max Connections</th>
                <th className="px-4 py-2 font-medium text-stone-600 dark:text-stone-400">Last Connection</th>
                <th className="px-4 py-2 font-medium text-stone-600 dark:text-stone-400"></th>
              </tr>
            </thead>
            <tbody>
              {meetings.map((m) => (
                <tr key={m.id} className="border-b border-stone-100 dark:border-stone-700 last:border-b-0">
                  <td className="px-4 py-2">
                    <Link
                      to={`/meeting/${m.id}`}
                      className="text-teal-600 dark:text-teal-400 hover:text-teal-800 dark:hover:text-teal-300 font-medium transition-colors"
                    >
                      {m.id}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-stone-600 dark:text-stone-400">{m.chairCount}</td>
                  <td className="px-4 py-2 text-stone-600 dark:text-stone-400">{m.agendaItemCount}</td>
                  <td className="px-4 py-2 text-stone-600 dark:text-stone-400">{m.queuedSpeakerCount}</td>
                  <td className="px-4 py-2 text-stone-600 dark:text-stone-400">{m.maxConcurrent}</td>
                  <td className="px-4 py-2 text-stone-600 dark:text-stone-400">{formatLastConnection(m)}</td>
                  <td className="px-4 py-2 text-right">
                    <button
                      onClick={() => setDeleteConfirm(m.id)}
                      className="text-xs text-stone-400 dark:text-stone-500 hover:text-red-600 dark:hover:text-red-400
                                 transition-colors cursor-pointer"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Delete confirmation modal */}
      {deleteConfirm && (
        <div
          className="fixed inset-0 top-[3rem] bg-black/30 flex items-center justify-center z-40"
          onClick={() => setDeleteConfirm(null)}
          role="dialog"
          aria-label="Confirm deletion"
          aria-modal="true"
        >
          <div
            className="bg-white dark:bg-stone-900 rounded-lg shadow-lg dark:shadow-stone-950/50 border border-stone-200 dark:border-stone-700 p-6 max-w-sm w-full mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-stone-800 dark:text-stone-200 mb-2">Delete Meeting</h3>
            <p className="text-sm text-stone-600 dark:text-stone-400 mb-4">
              Are you sure you want to delete meeting <strong>{deleteConfirm}</strong>? This will disconnect all
              participants and cannot be undone.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="text-sm text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-300
                           transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDelete(deleteConfirm)}
                autoFocus
                className="bg-red-500 text-white px-4 py-1.5 rounded text-sm font-medium
                           hover:bg-red-600 transition-colors cursor-pointer
                           focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 dark:focus:ring-offset-stone-900"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
