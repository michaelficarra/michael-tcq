import { useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import msgpackParser from 'socket.io-msgpack-parser';
import type { TypedSocket } from '../contexts/SocketContext.js';
import { useMeetingDispatch, type MeetingAction } from '../contexts/MeetingContext.js';

/**
 * Discriminated-action types that mirror the server's delta event names.
 * Listed here so the gap-detection wiring stays declarative.
 */
const DELTA_EVENT_TYPES = [
  'chairs:updated',
  'agenda:added',
  'agenda:edited',
  'agenda:deleted',
  'agenda:reordered',
  'queue:added',
  'queue:edited',
  'queue:removed',
  'queue:reordered',
  'queue:closedChanged',
  'speaker:advanced',
  'agenda:advanced',
  'poll:started',
  'poll:stopped',
  'poll:reacted',
] as const satisfies readonly Extract<MeetingAction, { delta: unknown }>['type'][];

/**
 * Connect to the server via Socket.IO, join a meeting room, and dispatch
 * state updates into MeetingContext.
 *
 * Returns the socket instance (or null before connection) so it can be
 * provided to SocketContext for use by other components.
 *
 * The socket connects on mount and disconnects on unmount. When the server
 * emits a `state` event, the full meeting state is dispatched to the reducer.
 *
 * `userGhid` is included in the dependency array so that a cross-tab auth
 * change (handled in AuthContext) tears down the existing socket and opens
 * a fresh one. WebSocket auth is captured at handshake from the session
 * cookie, so a soft identity swap requires a reconnect for the server-side
 * socket to bind to the new user.
 */
export function useSocketConnection(meetingId: string, userGhid: number | null): TypedSocket | null {
  const dispatch = useMeetingDispatch();
  const socketRef = useRef<TypedSocket | null>(null);
  // The version cursor lives in a ref rather than React state so the
  // socket listeners can both read it and *write* it synchronously. If
  // we mirrored `lastSeenVersion` from context via a useEffect, deltas
  // arriving in the same JS turn as the bootstrap `state` event (very
  // common on localhost) would see a stale ref — the effect doesn't run
  // until after React commits the dispatch, but the next listener fires
  // immediately when its frame is decoded. Owning the cursor in the ref
  // avoids that race entirely. The reducer still tracks lastSeenVersion
  // in state so other components can read it, but the cursor used for
  // gap detection is what's in this ref.
  const lastSeenVersionRef = useRef<number | null>(null);

  useEffect(() => {
    // Connect to the server. In development, the Vite proxy forwards
    // /socket.io requests to the Express server, so no explicit URL is needed.
    // The MessagePack parser must match the server's choice — see
    // `packages/server/src/index.ts`.
    const socket: TypedSocket = io({
      transports: ['websocket', 'polling'],
      parser: msgpackParser,
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      dispatch({ type: 'setConnected', connected: true });
      // Join the meeting room once connected
      socket.emit('join', meetingId);
    });

    socket.on('disconnect', () => {
      dispatch({ type: 'setConnected', connected: false });
    });

    // Detect network loss immediately via the browser's offline event,
    // rather than waiting for Socket.IO's ping timeout.
    function handleOffline() {
      dispatch({ type: 'setConnected', connected: false });
    }
    function handleOnline() {
      // Socket.IO will reconnect automatically; the connect event
      // will set connected back to true.
    }
    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);

    // The server sends the full meeting state on initial join, on
    // automatic reconnect, and in response to a `state:resync` request.
    // The bootstrap payload's `operational.version` reseeds the local
    // version cursor used for gap detection on subsequent deltas.
    socket.on('state', (meeting) => {
      // Reseed synchronously so any delta decoded in the same JS turn
      // as this state event sees the up-to-date cursor.
      lastSeenVersionRef.current = meeting.operational.version;
      dispatch({ type: 'state', meeting });
    });

    // Wire up a gap-detecting listener for each typed delta event.
    // Each listener:
    //  - Drops the delta if no bootstrap `state` has arrived yet.
    //  - Applies the delta if `version === lastSeen + 1`, advancing the
    //    cursor *synchronously* so a back-to-back delta in the same
    //    turn sees the new cursor before its own check runs.
    //  - On a forward gap (`version > lastSeen + 1`), drops the delta
    //    and asks the server for a fresh `state` snapshot — the replayed
    //    snapshot reseeds the cursor and resumes streaming.
    //  - Drops late or duplicate deltas silently.
    for (const eventType of DELTA_EVENT_TYPES) {
      socket.on(eventType, (delta: { version: number }) => {
        const lastSeen = lastSeenVersionRef.current;
        if (lastSeen === null) return;
        const expected = lastSeen + 1;
        if (delta.version === expected) {
          lastSeenVersionRef.current = delta.version;
          dispatch({ type: eventType, delta } as MeetingAction);
          return;
        }
        if (delta.version > expected) {
          socket.emit('state:resync');
        }
      });
    }

    // The server broadcasts the current socket-connection count for
    // this meeting after each join/disconnect so the connection-status
    // dot can show the count on hover.
    socket.on('activeConnections', (count) => {
      dispatch({ type: 'setActiveConnections', count });
    });

    // Server-side validation errors (e.g. "Meeting not found",
    // "Only chairs can..." etc.)
    socket.on('error', (message) => {
      dispatch({ type: 'setError', error: message });
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
    };
  }, [meetingId, dispatch, userGhid]);

  // eslint-disable-next-line react-hooks/refs -- Ref is synchronised by the effect above; reading it here is safe.
  return socketRef.current;
}
