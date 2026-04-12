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
        socket.emit('error', 'Meeting not found');
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

    // --- agenda:add ---
    // Chair adds a new agenda item. The owner is specified by GitHub username;
    // for now we create a placeholder User object. GitHub API validation will
    // be added when real OAuth is implemented.
    socket.on('agenda:add', (payload) => {
      if (!joinedMeetingId) return;
      if (!meetingManager.isChair(joinedMeetingId, user)) {
        socket.emit('error', 'Only chairs can add agenda items');
        return;
      }

      // Validate the payload
      const name = payload.name?.trim();
      if (!name) {
        socket.emit('error', 'Agenda item name is required');
        return;
      }
      const ownerUsername = payload.ownerUsername?.trim();
      if (!ownerUsername) {
        socket.emit('error', 'Owner username is required');
        return;
      }

      // Build the owner User object. If the owner is one of the meeting's
      // chairs, use their full profile; otherwise create a placeholder.
      // TODO: validate username against the GitHub API (Step 9/10).
      const meeting = meetingManager.get(joinedMeetingId);
      const existingUser = meeting?.chairs.find((c) => c.ghUsername === ownerUsername);
      const owner = existingUser ?? {
        ghid: 0,
        ghUsername: ownerUsername,
        name: ownerUsername,
        organisation: '',
      };

      // Parse timebox: treat 0, negative, and NaN as "no timebox"
      const timebox = payload.timebox && payload.timebox > 0 ? payload.timebox : undefined;

      meetingManager.addAgendaItem(joinedMeetingId, name, owner, timebox);
      broadcastMeetingState(io, meetingManager, joinedMeetingId);
    });

    // --- agenda:delete ---
    // Chair removes an agenda item by ID.
    socket.on('agenda:delete', (payload) => {
      if (!joinedMeetingId) return;
      if (!meetingManager.isChair(joinedMeetingId, user)) {
        socket.emit('error', 'Only chairs can delete agenda items');
        return;
      }

      const deleted = meetingManager.deleteAgendaItem(joinedMeetingId, payload.id);
      if (!deleted) {
        socket.emit('error', 'Agenda item not found');
        return;
      }

      broadcastMeetingState(io, meetingManager, joinedMeetingId);
    });

    // --- agenda:reorder ---
    // Chair reorders agenda items by moving one from oldIndex to newIndex.
    socket.on('agenda:reorder', (payload) => {
      if (!joinedMeetingId) return;
      if (!meetingManager.isChair(joinedMeetingId, user)) {
        socket.emit('error', 'Only chairs can reorder agenda items');
        return;
      }

      const reordered = meetingManager.reorderAgendaItem(
        joinedMeetingId,
        payload.id,
        payload.afterId,
      );
      if (!reordered) {
        socket.emit('error', 'Invalid reorder indices');
        return;
      }

      broadcastMeetingState(io, meetingManager, joinedMeetingId);
    });

    // --- queue:add ---
    // Any authenticated user can add themselves to the speaker queue.
    // The entry is automatically inserted at the correct position based
    // on type priority (point-of-order > question > reply > topic).
    socket.on('queue:add', (payload) => {
      if (!joinedMeetingId) return;

      const topic = payload.topic?.trim();
      if (!topic) {
        socket.emit('error', 'Topic is required');
        return;
      }
      if (!payload.type) {
        socket.emit('error', 'Entry type is required');
        return;
      }

      const entry = meetingManager.addQueueEntry(joinedMeetingId, payload.type, topic, user);
      if (!entry) {
        socket.emit('error', 'Failed to add queue entry');
        return;
      }

      broadcastMeetingState(io, meetingManager, joinedMeetingId);
    });

    // --- queue:remove ---
    // A user can remove their own queue entry; a chair can remove any entry.
    socket.on('queue:remove', (payload) => {
      if (!joinedMeetingId) return;

      // Check permissions: user can remove their own entry, chairs can remove any
      const entry = meetingManager.getQueueEntry(joinedMeetingId, payload.id);
      if (!entry) {
        socket.emit('error', 'Queue entry not found');
        return;
      }

      const isOwner = entry.user.ghid === user.ghid;
      const isChairUser = meetingManager.isChair(joinedMeetingId, user);
      if (!isOwner && !isChairUser) {
        socket.emit('error', 'You can only remove your own queue entries');
        return;
      }

      meetingManager.removeQueueEntry(joinedMeetingId, payload.id);
      broadcastMeetingState(io, meetingManager, joinedMeetingId);
    });

    // --- queue:next ---
    // Chair advances to the next speaker. Includes a stale-state check:
    // the client sends the current speaker's ID, and the server rejects
    // the request if it doesn't match (prevents double-advancement).
    socket.on('queue:next', (payload) => {
      if (!joinedMeetingId) return;
      if (!meetingManager.isChair(joinedMeetingId, user)) {
        socket.emit('error', 'Only chairs can advance the speaker');
        return;
      }

      // Stale-state check: verify the client's view of the current topic
      // matches the server's. This prevents double-advancement when two
      // chairs click "Next Speaker" at the same time.
      const meeting = meetingManager.get(joinedMeetingId);
      if (!meeting) return;
      const actualTopicId = meeting.currentTopic?.id ?? null;
      if (payload.currentTopicId !== actualTopicId) {
        // Client has a stale view — broadcast current state so it catches up
        socket.emit('state', meeting);
        return;
      }

      meetingManager.nextSpeaker(joinedMeetingId);
      broadcastMeetingState(io, meetingManager, joinedMeetingId);

      // Persist immediately — speaker changes are high-value events
      meetingManager.syncOne(joinedMeetingId).catch((err) => {
        console.error('Failed to sync after speaker advancement:', err);
      });
    });

    // --- meeting:nextAgendaItem ---
    // Chair starts the meeting (first agenda item) or advances to the next one.
    // This is a high-value mutation, so we persist immediately.
    socket.on('meeting:nextAgendaItem', () => {
      if (!joinedMeetingId) return;
      if (!meetingManager.isChair(joinedMeetingId, user)) {
        socket.emit('error', 'Only chairs can advance the agenda');
        return;
      }

      const nextItem = meetingManager.nextAgendaItem(joinedMeetingId);
      if (!nextItem) {
        socket.emit('error', 'No more agenda items');
        return;
      }

      broadcastMeetingState(io, meetingManager, joinedMeetingId);

      // Persist immediately — agenda advancement is a high-value event
      meetingManager.syncOne(joinedMeetingId).catch((err) => {
        console.error('Failed to sync after agenda advancement:', err);
      });
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
