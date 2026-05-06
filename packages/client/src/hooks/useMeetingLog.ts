/**
 * Fetches and live-updates a meeting's log via the REST endpoint
 * `GET /api/meetings/:id/log`, refreshing in response to `log:dirty`
 * Socket.IO events. The log is intentionally *not* on `MeetingState`
 * — keeping it off the realtime channel is the whole point of the
 * decoupled-log architecture, since the log dominates broadcast size
 * for long meetings.
 *
 * Triggers for a fetch:
 *   1. Initial mount (full fetch with no cursor).
 *   2. Receipt of a `log:dirty` event while mounted (incremental fetch
 *      using the cursor + ETag the client already has).
 *   3. Socket reconnect — defensive single fetch in case a `log:dirty`
 *      arrived during the disconnect window.
 *   4. `document.visibilitychange` becoming visible — defensive fetch
 *      covering any `log:dirty` lost to background-tab throttling.
 *
 * The cursor (`?since=<lastEntryId>`) keeps the response body limited
 * to new entries only. The `If-None-Match` header lets the server
 * short-circuit to a 304 when nothing has changed (the racy "two
 * `log:dirty` events for one append" case).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { LogEntry } from '@tcq/shared';
import { useSocket } from '../contexts/SocketContext.js';

export interface UseMeetingLogResult {
  entries: LogEntry[];
  loading: boolean;
}

export function useMeetingLog(meetingId: string | undefined): UseMeetingLogResult {
  const socket = useSocket();
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  // Refs (not state) for cursor/ETag so callbacks are stable and don't
  // tear down/rebuild socket listeners every fetch.
  const cursorRef = useRef<string | null>(null);
  const etagRef = useRef<string | null>(null);

  const fetchLog = useCallback(async () => {
    if (!meetingId) return;
    const url = new URL(`/api/meetings/${meetingId}/log`, window.location.origin);
    if (cursorRef.current !== null) {
      url.searchParams.set('since', cursorRef.current);
    }
    const headers: Record<string, string> = {};
    if (etagRef.current !== null) {
      headers['If-None-Match'] = etagRef.current;
    }
    let res: Response;
    try {
      res = await fetch(url.toString(), { headers, credentials: 'same-origin' });
    } catch {
      // Network errors are transient — the next `log:dirty` or visibility
      // change will retry. We deliberately don't surface this in the UI.
      return;
    }
    // 304: client is up to date; nothing to do.
    if (res.status === 304) return;
    if (!res.ok) return;
    const newEntries = (await res.json()) as LogEntry[];
    if (newEntries.length > 0) {
      setEntries((prev) => [...prev, ...newEntries]);
      cursorRef.current = newEntries[newEntries.length - 1].id;
    }
    const newEtag = res.headers.get('ETag');
    if (newEtag !== null) {
      etagRef.current = newEtag;
    }
  }, [meetingId]);

  // Initial fetch on mount (and whenever the meeting id changes — e.g.
  // a chair switching between meetings in the same tab). Resetting
  // local state synchronously inside the effect is the explicit intent
  // here: the previous meeting's entries should not flash on screen
  // while the new meeting's first fetch is in flight.
  useEffect(() => {
    if (!meetingId) return;
    cursorRef.current = null;
    etagRef.current = null;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional reset on meeting change
    setEntries([]);
    setLoading(true);
    let cancelled = false;
    void fetchLog().finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [meetingId, fetchLog]);

  // Push-driven refetch on `log:dirty` from the server.
  useEffect(() => {
    if (!socket) return;
    const handler = () => {
      void fetchLog();
    };
    socket.on('log:dirty', handler);
    return () => {
      socket.off('log:dirty', handler);
    };
  }, [socket, fetchLog]);

  // Defensive refetch on socket reconnect: covers the window where a
  // `log:dirty` may have been emitted while the socket was disconnected.
  useEffect(() => {
    if (!socket) return;
    const handler = () => {
      void fetchLog();
    };
    socket.on('connect', handler);
    return () => {
      socket.off('connect', handler);
    };
  }, [socket, fetchLog]);

  // Defensive refetch when the tab becomes visible: browsers may throttle
  // background tabs aggressively enough to drop or delay socket-event
  // handlers, so a single visibility-driven fetch guarantees catch-up.
  useEffect(() => {
    const handler = () => {
      if (!document.hidden) void fetchLog();
    };
    document.addEventListener('visibilitychange', handler);
    return () => {
      document.removeEventListener('visibilitychange', handler);
    };
  }, [fetchLog]);

  return { entries, loading };
}
