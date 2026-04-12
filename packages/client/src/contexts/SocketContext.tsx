/**
 * Context for the Socket.IO client instance.
 *
 * Components that need to emit events to the server (e.g. agenda:add)
 * use this context to access the socket. The socket is set by the
 * useSocket hook in MeetingPage.
 */

import { createContext, useContext } from 'react';
import type { Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '@tcq/shared';

export type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

// Exported so TestSocketProvider can inject a mock socket.
export const SocketContext = createContext<TypedSocket | null>(null);

/** Get the current Socket.IO client, or null if not connected. */
export function useSocket(): TypedSocket | null {
  return useContext(SocketContext);
}
