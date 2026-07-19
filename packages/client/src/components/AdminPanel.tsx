/**
 * Admin panel — shown on the home page below the join/create cards
 * for users with admin privileges. Lists all active meetings with
 * connection statistics and a delete button for each.
 */

import { useState, useEffect, useCallback, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { RelativeTime } from '../lib/RelativeTime.js';
import { useNativeDialog, dialogAutoFocus } from '../hooks/useNativeDialog.js';

interface MeetingInfo {
  id: string;
  createdAt: string;
  participantUsernames: string[];
  currentConnections: number;
  lastConnection: string;
  /** ISO timestamp of the soft-delete, or null when the meeting is live. */
  deletedAt: string | null;
}

export function AdminPanel({ refreshTick }: { refreshTick: number }) {
  const [meetings, setMeetings] = useState<MeetingInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  // Native modal <dialog> lifecycle for the delete-confirmation dialog.
  const { dialogRef: deleteDialogRef, renderContents: showDeleteContents } = useNativeDialog(
    deleteConfirm !== null,
    () => setDeleteConfirm(null),
  );
  // The contents linger through the close animation, but `deleteConfirm` is
  // nulled on close — retain the last id (store-info-from-previous-render
  // state) so the message doesn't blank out mid-fade.
  const [retainedDeleteId, setRetainedDeleteId] = useState<string | null>(null);
  if (deleteConfirm !== null && deleteConfirm !== retainedDeleteId) setRetainedDeleteId(deleteConfirm);
  const deleteId = deleteConfirm ?? retainedDeleteId;

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

  // Refresh cadence is owned by the parent AdminSection so this panel and
  // the DiagnosticsPanel beside it actually fetch on the same tick rather
  // than drifting apart on independent intervals.
  useEffect(() => {
    // Intentional polled fetch; the eventual setState updates are async,
    // not synchronous within the effect body.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchMeetings();
  }, [fetchMeetings, refreshTick]);

  /** Delete a meeting after confirmation. Soft-delete server-side: the
   *  row stays in the list but flips to a struck-through "deleted" state. */
  async function handleDelete(meetingId: string) {
    const res = await fetch(`/api/admin/meetings/${encodeURIComponent(meetingId)}`, {
      method: 'DELETE',
    });
    if (res.ok) {
      // Stamp a client-side `deletedAt` so the row updates immediately;
      // the next poll will overwrite with the server-canonical timestamp.
      const now = new Date().toISOString();
      setMeetings((prev) => prev.map((m) => (m.id === meetingId ? { ...m, deletedAt: now } : m)));
    }
    setDeleteConfirm(null);
  }

  /** Restore a soft-deleted meeting — flips it back to live without confirmation. */
  async function handleRestore(meetingId: string) {
    const res = await fetch(`/api/admin/meetings/${encodeURIComponent(meetingId)}/restore`, {
      method: 'POST',
    });
    if (res.ok) {
      setMeetings((prev) => prev.map((m) => (m.id === meetingId ? { ...m, deletedAt: null } : m)));
    }
  }

  /** Format the last connection time for display. */
  function formatLastConnection(m: MeetingInfo): ReactNode {
    if (!m.lastConnection) return 'never';
    if (m.lastConnection === 'now') return `now (${m.currentConnections})`;
    return <RelativeTime timestamp={m.lastConnection} />;
  }

  if (loading) {
    return null;
  }

  return (
    <div className="mt-8">
      <h2 className="text-sm font-bold uppercase tracking-wider text-stone-500 dark:text-stone-400 mb-3">
        Active Meetings
      </h2>

      {meetings.length === 0 ? (
        <p className="text-sm text-stone-600 dark:text-stone-300 italic">No active meetings.</p>
      ) : (
        <div className="bg-white dark:bg-stone-900 rounded-lg shadow-sm dark:shadow-stone-950/50 border border-stone-200 dark:border-stone-700 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-stone-200 dark:border-stone-700 bg-stone-50 dark:bg-stone-800 text-left">
                <th className="px-4 py-2 font-medium text-stone-600 dark:text-stone-400">Meeting ID</th>
                <th className="px-4 py-2 font-medium text-stone-600 dark:text-stone-400">Created</th>
                <th className="px-4 py-2 font-medium text-stone-600 dark:text-stone-400">Last Connection</th>
                <th className="px-4 py-2 font-medium text-stone-600 dark:text-stone-400">Participants</th>
                <th className="px-4 py-2 font-medium text-stone-600 dark:text-stone-400"></th>
              </tr>
            </thead>
            <tbody>
              {meetings.map((m) => {
                const isDeleted = m.deletedAt !== null;
                // `line-through` is applied to each data cell (not the
                // <tr>) on purpose: CSS text-decoration painted on an
                // ancestor renders *through* descendants and can't be
                // undone by `no-underline` on the child, so striking
                // the row would strike the Restore button too. Cell-
                // level decoration leaves the action column clean.
                const struck = isDeleted ? 'line-through text-stone-600 dark:text-stone-300' : '';
                return (
                  <tr
                    key={m.id}
                    className="border-b border-stone-100 dark:border-stone-700 last:border-b-0 hover:bg-stone-100 dark:hover:bg-stone-800/50 transition-colors"
                  >
                    <td className={`px-4 py-2 ${struck}`}>
                      {isDeleted ? (
                        <span className="font-medium">{m.id}</span>
                      ) : (
                        <Link
                          to={`/meeting/${m.id}`}
                          className="text-teal-700 dark:text-teal-400 hover:text-teal-800 dark:hover:text-teal-300 font-medium transition-colors"
                        >
                          {m.id}
                        </Link>
                      )}
                    </td>
                    <td className={`px-4 py-2 text-stone-600 dark:text-stone-400 ${struck}`}>
                      {m.createdAt ? <RelativeTime timestamp={m.createdAt} /> : '—'}
                    </td>
                    <td className={`px-4 py-2 text-stone-600 dark:text-stone-400 ${struck}`}>
                      {formatLastConnection(m)}
                    </td>
                    <td
                      className={`px-4 py-2 text-stone-600 dark:text-stone-400 cursor-help ${struck}`}
                      title={m.participantUsernames.join('\n')}
                    >
                      {m.participantUsernames.length}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {isDeleted ? (
                        <button
                          onClick={() => handleRestore(m.id)}
                          className="text-xs text-stone-600 dark:text-stone-300 hover:text-teal-600 dark:hover:text-teal-400
                                     transition-colors cursor-pointer"
                        >
                          Restore
                        </button>
                      ) : (
                        <button
                          onClick={() => setDeleteConfirm(m.id)}
                          className="text-xs text-stone-600 dark:text-stone-300 hover:text-red-600 dark:hover:text-red-400
                                     transition-colors cursor-pointer"
                        >
                          Delete
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Delete confirmation modal */}
      <dialog
        ref={deleteDialogRef}
        aria-label="Confirm deletion"
        className="tcq-dialog w-[min(24rem,calc(100vw-2rem))] max-h-[calc(100dvh-6rem)] overflow-y-auto rounded-lg
                   border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 p-6 text-left
                   shadow-lg dark:shadow-stone-950/50"
      >
        {showDeleteContents && deleteId && (
          <>
            <h3 className="text-lg font-semibold text-stone-800 dark:text-stone-200 mb-2">Delete Meeting</h3>
            <p className="text-sm text-stone-600 dark:text-stone-400 mb-4">
              Are you sure you want to delete meeting <strong>{deleteId}</strong>? This will disconnect all participants
              and hide it from their meeting lists. You can restore it from this panel until the meeting eventually ages
              out via the standard retention policy.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="text-sm text-stone-600 dark:text-stone-300 hover:text-stone-800 dark:hover:text-stone-100
                           transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDelete(deleteId)}
                ref={dialogAutoFocus}
                className="bg-red-600 text-white px-4 py-1.5 rounded text-sm font-medium
                           hover:bg-red-700 transition-colors cursor-pointer
                           focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 dark:focus:ring-offset-stone-900"
              >
                Delete
              </button>
            </div>
          </>
        )}
      </dialog>
    </div>
  );
}
