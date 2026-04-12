import { useEffect, useRef } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '@tcq/shared';
import { useMeetingDispatch } from '../contexts/MeetingContext.js';

/** A typed Socket.IO client socket. */
type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/**
 * Connect to the server via Socket.IO, join a meeting room, and dispatch
 * state updates into MeetingContext.
 *
 * The socket connects on mount and disconnects on unmount. When the server
 * emits a `state` event, the full meeting state is dispatched to the reducer.
 */
export function useSocket(meetingId: string): TypedSocket | null {
  const dispatch = useMeetingDispatch();
  const socketRef = useRef<TypedSocket | null>(null);

  useEffect(() => {
    // Connect to the server. In development, the Vite proxy forwards
    // /socket.io requests to the Express server, so no explicit URL is needed.
    const socket: TypedSocket = io({
      // Let Socket.IO auto-detect the URL from the current page
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

    // The server sends the full meeting state whenever it changes
    socket.on('state', (meeting) => {
      dispatch({ type: 'state', meeting });
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [meetingId, dispatch]);

  return socketRef.current;
}
