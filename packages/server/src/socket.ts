import type { Server, Socket } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents, User } from '@tcq/shared';
import type { MeetingManager } from './meetings.js';

/** A Socket with our typed events and session user attached. */
type TypedSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

/**
 * Tracks how many sockets are connected to each meeting, so we can
 * clean up meetings after all participants have left.
 */
const meetingClientCounts = new Map<string, number>();

/**
 * Timers for delayed meeting cleanup. When the last client disconnects,
 * we wait before removing the meeting to allow for brief reconnections.
 */
const cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** How long to wait (ms) after the last client disconnects before cleaning up. */
const CLEANUP_DELAY_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Broadcast the full meeting state to all sockets in a meeting's room.
 * Called after every state mutation so all clients stay in sync.
 */
export function broadcastMeetingState(
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  meetingManager: MeetingManager,
  meetingId: string,
): void {
  const meeting = meetingManager.get(meetingId);
  if (meeting) {
    io.to(meetingId).emit('state', meeting);
  }
}

/**
 * Register Socket.IO event handlers.
 *
 * Each socket goes through this flow:
 * 1. Connect — session is available via the shared Express middleware.
 * 2. `join` — client sends a meeting ID; socket joins that room and
 *    receives the full current state.
 * 3. (Future steps add more event handlers here for queue/agenda actions.)
 * 4. Disconnect — decrement the client count; start cleanup timer if zero.
 */
export function registerSocketHandlers(
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  meetingManager: MeetingManager,
): void {
  io.on('connection', (socket: TypedSocket) => {
    // The user was attached to the session by the mock auth (or real OAuth later).
    // Socket.IO shares the Express session via middleware configured in index.ts.
    const user = getSocketUser(socket);
    if (!user) {
      console.warn('Socket connected without authenticated session, disconnecting');
      socket.disconnect(true);
      return;
    }

    // Track which meeting this socket has joined (at most one).
    let joinedMeetingId: string | null = null;

    // --- join ---
    // Client sends the meeting ID it wants to join. The socket is added to
    // that meeting's Socket.IO room and receives the full current state.
    socket.on('join', (meetingId: string) => {
      const meeting = meetingManager.get(meetingId);
      if (!meeting) {
        // TODO: send an error event to the client once we have error handling
        return;
      }

      // Leave any previously joined meeting room
      if (joinedMeetingId) {
        socket.leave(joinedMeetingId);
        decrementClientCount(joinedMeetingId, meetingManager);
      }

      // Join the new meeting room
      joinedMeetingId = meetingId;
      socket.join(meetingId);
      incrementClientCount(meetingId);

      // Send the full current state to this socket only
      socket.emit('state', meeting);
    });

    // --- disconnect ---
    socket.on('disconnect', () => {
      if (joinedMeetingId) {
        decrementClientCount(joinedMeetingId, meetingManager);
      }
    });
  });
}

/**
 * Extract the authenticated user from a socket's handshake session.
 * Returns undefined if no user is set (unauthenticated connection).
 */
function getSocketUser(socket: TypedSocket): User | undefined {
  // The session is attached to the handshake by the shared session middleware.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const session = (socket.request as any).session;
  return session?.user;
}

/** Increment the count of connected clients for a meeting and cancel any pending cleanup. */
function incrementClientCount(meetingId: string): void {
  const current = meetingClientCounts.get(meetingId) ?? 0;
  meetingClientCounts.set(meetingId, current + 1);

  // Cancel any pending cleanup timer — someone reconnected
  const timer = cleanupTimers.get(meetingId);
  if (timer) {
    clearTimeout(timer);
    cleanupTimers.delete(meetingId);
  }
}

/**
 * Decrement the count of connected clients for a meeting.
 * When the count reaches zero, start a delayed cleanup timer.
 */
function decrementClientCount(meetingId: string, meetingManager: MeetingManager): void {
  const current = meetingClientCounts.get(meetingId) ?? 0;
  const next = Math.max(0, current - 1);

  if (next === 0) {
    meetingClientCounts.delete(meetingId);

    // Start a delayed cleanup — if no one reconnects, remove the meeting
    const timer = setTimeout(() => {
      cleanupTimers.delete(meetingId);

      // Only remove if still zero clients
      if (!meetingClientCounts.has(meetingId)) {
        console.log(`Cleaning up meeting ${meetingId} (no connected clients)`);
        meetingManager.remove(meetingId).catch((err) => {
          console.error(`Failed to remove meeting ${meetingId}:`, err);
        });
      }
    }, CLEANUP_DELAY_MS);

    cleanupTimers.set(meetingId, timer);
  } else {
    meetingClientCounts.set(meetingId, next);
  }
}
