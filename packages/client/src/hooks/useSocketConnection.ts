import { useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import type { TypedSocket } from '../contexts/SocketContext.js';
import { useMeetingDispatch } from '../contexts/MeetingContext.js';

/**
 * Connect to the server via Socket.IO, join a meeting room, and dispatch
 * state updates into MeetingContext.
 *
 * Returns the socket instance (or null before connection) so it can be
 * provided to SocketContext for use by other components.
 *
 * The socket connects on mount and disconnects on unmount. When the server
 * emits a `state` event, the full meeting state is dispatched to the reducer.
 */
export function useSocketConnection(meetingId: string): TypedSocket | null {
  const dispatch = useMeetingDispatch();
  const socketRef = useRef<TypedSocket | null>(null);

  useEffect(() => {
    // Connect to the server. In development, the Vite proxy forwards
    // /socket.io requests to the Express server, so no explicit URL is needed.
    const socket: TypedSocket = io({
      transports: ['websocket', 'polling'],
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

    // The server sends the full meeting state whenever it changes
    socket.on('state', (meeting) => {
      dispatch({ type: 'state', meeting });
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
  }, [meetingId, dispatch]);

  // eslint-disable-next-line react-hooks/refs -- Ref is synchronised by the effect above; reading it here is safe.
  return socketRef.current;
}
