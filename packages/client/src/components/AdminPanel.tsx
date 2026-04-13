/**
 * Admin panel — shown on the home page below the join/create cards
 * for users with admin privileges. Lists all active meetings with
 * connection statistics and a delete button for each.
 */

import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';

interface MeetingInfo {
  id: string;
  chairCount: number;
  agendaItemCount: number;
  queuedSpeakerCount: number;
  maxConcurrent: number;
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
  function formatLastConnection(value: string): string {
    if (!value) return 'never';
    if (value === 'now') return 'now';
    try {
      const date = new Date(value);
      return date.toLocaleString();
    } catch {
      return value;
    }
  }

  if (loading) {
    return null;
  }

  return (
    <div className="mt-8">
      <h2 className="text-sm font-bold uppercase tracking-wider text-stone-500 mb-3">
        Admin — Active Meetings
      </h2>

      {meetings.length === 0 ? (
        <p className="text-sm text-stone-400 italic">No active meetings.</p>
      ) : (
        <div className="bg-white rounded-lg shadow-sm border border-stone-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-stone-200 bg-stone-50 text-left">
                <th className="px-4 py-2 font-medium text-stone-600">Meeting ID</th>
                <th className="px-4 py-2 font-medium text-stone-600">Chairs</th>
                <th className="px-4 py-2 font-medium text-stone-600">Agenda</th>
                <th className="px-4 py-2 font-medium text-stone-600">Queue</th>
                <th className="px-4 py-2 font-medium text-stone-600">Max Connections</th>
                <th className="px-4 py-2 font-medium text-stone-600">Last Connection</th>
                <th className="px-4 py-2 font-medium text-stone-600"></th>
              </tr>
            </thead>
            <tbody>
              {meetings.map((m) => (
                <tr key={m.id} className="border-b border-stone-100 last:border-b-0">
                  <td className="px-4 py-2">
                    <Link
                      to={`/meeting/${m.id}`}
                      className="text-teal-600 hover:text-teal-800 font-medium transition-colors"
                    >
                      {m.id}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-stone-600">{m.chairCount}</td>
                  <td className="px-4 py-2 text-stone-600">{m.agendaItemCount}</td>
                  <td className="px-4 py-2 text-stone-600">{m.queuedSpeakerCount}</td>
                  <td className="px-4 py-2 text-stone-600">{m.maxConcurrent}</td>
                  <td className="px-4 py-2 text-stone-600">
                    {formatLastConnection(m.lastConnection)}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      onClick={() => setDeleteConfirm(m.id)}
                      className="text-xs text-stone-400 hover:text-red-600
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
          className="fixed inset-0 bg-black/30 flex items-center justify-center z-50"
          onClick={() => setDeleteConfirm(null)}
          role="dialog"
          aria-label="Confirm deletion"
          aria-modal="true"
        >
          <div
            className="bg-white rounded-lg shadow-lg border border-stone-200 p-6 max-w-sm w-full mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-stone-800 mb-2">
              Delete Meeting
            </h3>
            <p className="text-sm text-stone-600 mb-4">
              Are you sure you want to delete meeting{' '}
              <strong>{deleteConfirm}</strong>? This will disconnect all
              participants and cannot be undone.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="text-sm text-stone-500 hover:text-stone-700
                           transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDelete(deleteConfirm)}
                autoFocus
                className="bg-red-500 text-white px-4 py-1.5 rounded text-sm font-medium
                           hover:bg-red-600 transition-colors cursor-pointer
                           focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2"
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
