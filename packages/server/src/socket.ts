import type { Server, Socket } from 'socket.io';
import type { ZodType } from 'zod';
import type { ClientToServerEvents, ServerToClientEvents, User, UserKey, MeetingState } from '@tcq/shared';
import type { SessionUser } from './session.js';
import {
  QUEUE_ENTRY_LABELS,
  userKey,
  asUserKey,
  AgendaAddPayloadSchema,
  AgendaDeletePayloadSchema,
  AgendaEditPayloadSchema,
  AgendaReorderPayloadSchema,
  ChairsUpdatePayloadSchema,
  NextAgendaItemPayloadSchema,
  NextSpeakerPayloadSchema,
  PollReactPayloadSchema,
  PollStartPayloadSchema,
  QueueAddPayloadSchema,
  QueueEditPayloadSchema,
  QueueRemovePayloadSchema,
  QueueReorderPayloadSchema,
  QueueSetClosedPayloadSchema,
} from '@tcq/shared';
import type { MeetingManager } from './meetings.js';
import { ensureUser } from './meetings.js';
import { fetchGitHubUser } from './auth.js';
import { isOAuthConfigured } from './mockAuth.js';

/**
 * Validate a wire payload against its Zod schema. On failure, emit an
 * `error` event to the socket (surfaced as a user-facing message) and
 * return null so the caller can early-return.
 */
function parsePayload<T>(
  schema: ZodType<T>,
  payload: unknown,
  socket: Socket<ClientToServerEvents, ServerToClientEvents>,
): T | null {
  const result = schema.safeParse(payload);
  if (!result.success) {
    socket.emit('error', result.error.issues[0]?.message ?? 'Invalid payload');
    return null;
  }
  return result.data;
}

// -- Log helpers --

/**
 * Finalise the duration of the last speaker in the current topic group.
 * Called before advancing to the next speaker or changing agenda items.
 */
function finaliseLastSpeakerDuration(meeting: MeetingState, now: string): void {
  const speakers = meeting.current.topicSpeakers;
  if (speakers.length > 0) {
    const last = speakers[speakers.length - 1];
    if (last.duration === undefined) {
      last.duration = new Date(now).getTime() - new Date(last.startTime).getTime();
    }
  }
}

/**
 * Finalise the current topic group into a TopicDiscussedLog entry
 * and append it to the meeting log. Resets the topic-group accumulator.
 */
function finaliseTopicGroup(meeting: MeetingState, chairId: UserKey, now: string): void {
  if (meeting.current.topicSpeakers.length === 0) return;

  finaliseLastSpeakerDuration(meeting, now);

  const speakers = meeting.current.topicSpeakers;
  const firstStart = new Date(speakers[0].startTime).getTime();
  const duration = new Date(now).getTime() - firstStart;

  meeting.log.push({
    type: 'topic-discussed',
    timestamp: speakers[0].startTime,
    chairId,
    topicName: speakers[0].topic,
    speakers: [...speakers],
    duration,
  });

  meeting.current.topicSpeakers = [];
}

/**
 * Collect distinct participant user IDs from topic-discussed log entries
 * that occurred after a given timestamp (the agenda item start).
 * Excludes Point of Order speakers.
 */
function collectParticipantIds(meeting: MeetingState, sinceTimestamp: string): UserKey[] {
  const seen = new Set<UserKey>();

  // Gather from finalised topic groups
  for (const entry of meeting.log) {
    if (entry.type !== 'topic-discussed') continue;
    if (entry.timestamp < sinceTimestamp) continue;
    for (const speaker of entry.speakers) {
      if (speaker.type === 'point-of-order') continue;
      seen.add(speaker.userId);
    }
  }

  // Also include speakers from the current (not yet finalised) topic group
  for (const speaker of meeting.current.topicSpeakers) {
    if (speaker.type === 'point-of-order') continue;
    seen.add(speaker.userId);
  }

  return [...seen];
}

/** A Socket with our typed events and session user attached. */
type TypedSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

/**
 * Tracks how many sockets are connected to each meeting, used for
 * admin dashboard statistics and connection tracking.
 */
const meetingClientCounts = new Map<string, number>();

/** Per-meeting connection statistics for the admin dashboard. */
export interface MeetingStats {
  /** Maximum number of concurrent non-admin connections observed. */
  maxConcurrent: number;
  /** ISO timestamp of the most recent non-admin connection, or 'now' if connected. */
  lastConnection: string;
  /** Current number of non-admin connections. */
  currentConnections: number;
}

/** Tracks connection stats per meeting for admin reporting. */
const meetingStats = new Map<string, MeetingStats>();

/** Get the stats for a meeting, creating a default entry if needed. */
function getStats(meetingId: string): MeetingStats {
  let stats = meetingStats.get(meetingId);
  if (!stats) {
    stats = { maxConcurrent: 0, lastConnection: '', currentConnections: 0 };
    meetingStats.set(meetingId, stats);
  }
  return stats;
}

/** Get stats for all meetings. */
export function getAllMeetingStats(): Map<string, MeetingStats> {
  return meetingStats;
}

/** Remove stats for a meeting (called on cleanup). */
export function removeMeetingStats(meetingId: string): void {
  meetingStats.delete(meetingId);
}

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
    // Clear after broadcasting so it only applies to the broadcast that
    // immediately follows the handler that set it. Without this, a stale
    // value could be misattributed if a future code path changes the
    // current speaker without explicitly setting operational.lastAdvancementBy.
    delete meeting.operational.lastAdvancementBy;
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
        if (!user.isAdmin) {
          const prevStats = getStats(joinedMeetingId);
          prevStats.currentConnections = Math.max(0, prevStats.currentConnections - 1);
          if (prevStats.currentConnections === 0) {
            prevStats.lastConnection = new Date().toISOString();
          }
        }
        socket.leave(joinedMeetingId);
        decrementClientCount(io, joinedMeetingId);
      }

      // Join the new meeting room
      joinedMeetingId = meetingId;
      socket.join(meetingId);
      incrementClientCount(io, meetingId, meetingManager);

      // Track connection stats for admin dashboard (non-admin only)
      if (!user.isAdmin) {
        const stats = getStats(meetingId);
        stats.currentConnections++;
        stats.lastConnection = 'now';
        if (stats.currentConnections > stats.maxConcurrent) {
          stats.maxConcurrent = stats.currentConnections;
        }
      }

      // Send the full current state to this socket only
      socket.emit('state', meeting);
    });

    // --- meeting:updateChairs ---
    // Chairs or admins can update the list of chairs. For regular chairs:
    // at least one chair must remain, and they cannot remove themselves.
    // Admins bypass both restrictions — they can set any list, including
    // an empty one or one that excludes themselves.
    socket.on('meeting:updateChairs', async (payload) => {
      if (!joinedMeetingId) return;

      const userIsAdmin = user.isAdmin;
      const userIsChair = meetingManager.isChair(joinedMeetingId, user);

      if (!userIsChair && !userIsAdmin) {
        socket.emit('error', 'Only chairs or admins can update the chair list');
        return;
      }

      const parsed = parsePayload(ChairsUpdatePayloadSchema, payload, socket);
      if (!parsed) return;
      const { usernames } = parsed;

      // Non-admin chairs: at least one chair required, cannot remove self
      if (!userIsAdmin) {
        if (usernames.length === 0) {
          socket.emit('error', 'At least one chair is required');
          return;
        }

        const selfIncluded = usernames.some((u: string) => u.toLowerCase() === user.ghUsername.toLowerCase());
        if (!selfIncluded) {
          socket.emit('error', 'You cannot remove yourself from the chair list');
          return;
        }
      }

      // Resolve each username to a User object
      const meeting = meetingManager.get(joinedMeetingId);
      const chairs: User[] = [];

      for (const username of usernames) {
        const key = asUserKey(username.toLowerCase());

        // Check if this user is already known in the meeting
        const known = meeting?.users[key];

        if (known) {
          chairs.push(known);
        } else if (key === user.ghUsername.toLowerCase()) {
          chairs.push(user);
        } else if (isOAuthConfigured()) {
          // Validate against GitHub API when OAuth is configured
          const ghUser = await fetchGitHubUser(username);
          if (!ghUser) {
            socket.emit('error', `GitHub user "${username}" not found`);
            return;
          }
          chairs.push(ghUser);
        } else {
          // Mock auth mode — create a placeholder
          chairs.push({ ghid: 0, ghUsername: username, name: username, organisation: '' });
        }
      }

      meetingManager.updateChairs(joinedMeetingId, chairs);
      broadcastMeetingState(io, meetingManager, joinedMeetingId);
    });

    // --- agenda:add ---
    // Chair adds a new agenda item. The owner is specified by GitHub username;
    // for now we create a placeholder User object. GitHub API validation will
    // be added when real OAuth is implemented.
    socket.on('agenda:add', async (payload) => {
      if (!joinedMeetingId) return;
      if (!meetingManager.isChair(joinedMeetingId, user)) {
        socket.emit('error', 'Only chairs can add agenda items');
        return;
      }

      const parsed = parsePayload(AgendaAddPayloadSchema, payload, socket);
      if (!parsed) return;
      const { name, ownerUsername } = parsed;

      // Build the owner User object. If the owner is a known user in the
      // meeting, use their full profile. Otherwise, create a placeholder.
      const meeting = meetingManager.get(joinedMeetingId);
      const key = asUserKey(ownerUsername.toLowerCase());
      const owner: User = meeting?.users[key] ??
        (userKey(user) === key ? user : undefined) ?? {
          ghid: 0,
          ghUsername: ownerUsername,
          name: ownerUsername,
          organisation: '',
        };

      // The schema already constrains timebox to a positive integer; undefined = no timebox.
      meetingManager.addAgendaItem(joinedMeetingId, name, owner, parsed.timebox);
      broadcastMeetingState(io, meetingManager, joinedMeetingId);
    });

    // --- agenda:edit ---
    // Chair edits an existing agenda item's name, owner, or timebox.
    socket.on('agenda:edit', (payload) => {
      if (!joinedMeetingId) return;
      if (!meetingManager.isChair(joinedMeetingId, user)) {
        socket.emit('error', 'Only chairs can edit agenda items');
        return;
      }

      const parsed = parsePayload(AgendaEditPayloadSchema, payload, socket);
      if (!parsed) return;

      const updates: { name?: string; owner?: User; timebox?: number | null } = {};

      if (parsed.name !== undefined) updates.name = parsed.name;

      if (parsed.ownerUsername !== undefined) {
        // Resolve owner from known users or create placeholder
        const meeting = meetingManager.get(joinedMeetingId);
        const key = asUserKey(parsed.ownerUsername.toLowerCase());
        updates.owner = meeting?.users[key] ?? {
          ghid: 0,
          ghUsername: parsed.ownerUsername,
          name: parsed.ownerUsername,
          organisation: '',
        };
      }

      if (parsed.timebox !== undefined) {
        // null clears the timebox; 0 or negative also clears it
        updates.timebox = parsed.timebox === null || parsed.timebox <= 0 ? null : parsed.timebox;
      }

      const edited = meetingManager.editAgendaItem(joinedMeetingId, parsed.id, updates);
      if (!edited) {
        socket.emit('error', 'Agenda item not found');
        return;
      }

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

      const parsed = parsePayload(AgendaDeletePayloadSchema, payload, socket);
      if (!parsed) return;

      const deleted = meetingManager.deleteAgendaItem(joinedMeetingId, parsed.id);
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

      const parsed = parsePayload(AgendaReorderPayloadSchema, payload, socket);
      if (!parsed) return;

      const reordered = meetingManager.reorderAgendaItem(joinedMeetingId, parsed.id, parsed.afterId);
      if (!reordered) {
        socket.emit('error', 'Invalid reorder indices');
        return;
      }

      broadcastMeetingState(io, meetingManager, joinedMeetingId);
    });

    // --- queue:add ---
    // Any authenticated user can add themselves to the speaker queue.
    // Chairs can optionally specify `asUsername` to add an entry on
    // behalf of another user (used by the "Restore Queue" feature).
    socket.on('queue:add', (payload) => {
      if (!joinedMeetingId) return;

      const parsed = parsePayload(QueueAddPayloadSchema, payload, socket);
      if (!parsed) return;

      // Reject if queue is closed and user is not a chair. Point of Order is
      // exempt — procedural interruptions are always permitted regardless of
      // queue state.
      const addMeeting = meetingManager.get(joinedMeetingId);
      if (
        addMeeting?.queue.closed &&
        !meetingManager.isChair(joinedMeetingId, user) &&
        parsed.type !== 'point-of-order'
      ) {
        socket.emit('error', 'The queue is closed');
        return;
      }

      // Determine who the entry is for: the current user, or a specified
      // user if the chair provided asUsername. Typed as User (not SessionUser)
      // so the placeholder / looked-up branches don't need an isAdmin flag.
      let entryUser: User = user;
      if (parsed.asUsername) {
        if (!meetingManager.isChair(joinedMeetingId, user)) {
          socket.emit('error', 'Only chairs can add entries on behalf of others');
          return;
        }
        const key = asUserKey(parsed.asUsername.toLowerCase());
        // Look up the user from known meeting participants or create a placeholder.
        const meeting = meetingManager.get(joinedMeetingId);
        entryUser = meeting?.users[key] ?? {
          ghid: 0,
          ghUsername: parsed.asUsername,
          name: parsed.asUsername,
          organisation: '',
        };
      }

      const entry = meetingManager.addQueueEntry(joinedMeetingId, parsed.type, parsed.topic, entryUser);
      if (!entry) {
        socket.emit('error', 'Failed to add queue entry');
        return;
      }

      broadcastMeetingState(io, meetingManager, joinedMeetingId);
    });

    // --- queue:edit ---
    // Edit an existing queue entry's topic or type. The entry owner
    // can edit their own entry; chairs can edit any entry.
    socket.on('queue:edit', (payload) => {
      if (!joinedMeetingId) return;

      const parsed = parsePayload(QueueEditPayloadSchema, payload, socket);
      if (!parsed) return;

      // Check permissions: owner can edit their own, chairs can edit any
      const entry = meetingManager.getQueueEntry(joinedMeetingId, parsed.id);
      if (!entry) {
        socket.emit('error', 'Queue entry not found');
        return;
      }

      const isOwner = entry.userId === userKey(user);
      const isChairUser = meetingManager.isChair(joinedMeetingId, user);
      if (!isOwner && !isChairUser) {
        socket.emit('error', 'You can only edit your own queue entries');
        return;
      }

      const updates: { topic?: string; type?: import('@tcq/shared').QueueEntryType } = {};
      if (parsed.topic !== undefined) updates.topic = parsed.topic;
      if (parsed.type !== undefined) {
        if (!isChairUser) {
          socket.emit('error', 'Only chairs can change entry types');
          return;
        }
        updates.type = parsed.type;
      }

      const edited = meetingManager.editQueueEntry(joinedMeetingId, parsed.id, updates);
      if (!edited) {
        socket.emit('error', 'Queue entry not found');
        return;
      }

      broadcastMeetingState(io, meetingManager, joinedMeetingId);
    });

    // --- queue:remove ---
    // A user can remove their own queue entry; a chair can remove any entry.
    socket.on('queue:remove', (payload) => {
      if (!joinedMeetingId) return;

      const parsed = parsePayload(QueueRemovePayloadSchema, payload, socket);
      if (!parsed) return;

      // Check permissions: user can remove their own entry, chairs can remove any
      const entry = meetingManager.getQueueEntry(joinedMeetingId, parsed.id);
      if (!entry) {
        socket.emit('error', 'Queue entry not found');
        return;
      }

      const isOwner = entry.userId === userKey(user);
      const isChairUser = meetingManager.isChair(joinedMeetingId, user);
      if (!isOwner && !isChairUser) {
        socket.emit('error', 'You can only remove your own queue entries');
        return;
      }

      meetingManager.removeQueueEntry(joinedMeetingId, parsed.id);
      broadcastMeetingState(io, meetingManager, joinedMeetingId);
    });

    // --- queue:reorder ---
    // Reorder a queue entry. Chairs can move any entry anywhere.
    // Participants can move their own entries, but only downward
    // (to a later position) — they can defer but not jump ahead.
    socket.on('queue:reorder', (payload) => {
      if (!joinedMeetingId) return;

      const parsed = parsePayload(QueueReorderPayloadSchema, payload, socket);
      if (!parsed) return;

      const entry = meetingManager.getQueueEntry(joinedMeetingId, parsed.id);
      if (!entry) {
        socket.emit('error', 'Queue entry not found');
        return;
      }

      const isOwner = entry.userId === userKey(user);
      const isChairUser = meetingManager.isChair(joinedMeetingId, user);

      if (!isOwner && !isChairUser) {
        socket.emit('error', 'You can only reorder your own queue entries');
        return;
      }

      // Non-chair owners can only move their entry downward (defer).
      // Validate that the target position (afterId) is at or after
      // the entry's current position.
      if (isOwner && !isChairUser) {
        const meeting = meetingManager.get(joinedMeetingId);
        if (meeting) {
          const currentIndex = meeting.queue.orderedIds.indexOf(parsed.id);
          if (parsed.afterId === null) {
            // Moving to the beginning — that's moving up, not allowed
            socket.emit('error', 'You can only move your entry to a later position');
            return;
          }
          const afterIndex = meeting.queue.orderedIds.indexOf(parsed.afterId);
          if (afterIndex < currentIndex) {
            // Target is above current position — moving up, not allowed
            socket.emit('error', 'You can only move your entry to a later position');
            return;
          }
        }
      }

      const reordered = meetingManager.reorderQueueEntry(joinedMeetingId, parsed.id, parsed.afterId);
      if (!reordered) {
        socket.emit('error', 'Invalid queue reorder');
        return;
      }

      broadcastMeetingState(io, meetingManager, joinedMeetingId);
    });

    // --- queue:setClosed ---
    // Chair opens or closes the queue to new entries from non-chair users.
    socket.on('queue:setClosed', (payload) => {
      if (!joinedMeetingId) return;
      if (!meetingManager.isChair(joinedMeetingId, user)) {
        socket.emit('error', 'Only chairs can open or close the queue');
        return;
      }
      const parsed = parsePayload(QueueSetClosedPayloadSchema, payload, socket);
      if (!parsed) return;
      meetingManager.setQueueClosed(joinedMeetingId, parsed.closed);
      broadcastMeetingState(io, meetingManager, joinedMeetingId);
    });

    // --- queue:next ---
    // Advances to the next speaker. Allowed for chairs and the current speaker
    // ("I'm done speaking"). Uses a precondition check on the current speaker
    // entry ID to prevent double-advancement. Uses an ack callback so the
    // client can detect conflicts.
    socket.on('queue:next', (payload, ack?) => {
      // ack is optional — clients may emit without a callback
      const respond = typeof ack === 'function' ? ack : () => {};

      if (!joinedMeetingId) return;
      const meeting = meetingManager.get(joinedMeetingId);
      if (!meeting) return;

      const parsed = parsePayload(NextSpeakerPayloadSchema, payload, socket);
      if (!parsed) {
        respond({ ok: false, error: 'Invalid payload' });
        return;
      }

      // Allow chairs and the current speaker to advance.
      const actorId = userKey(user);
      const isChair = meetingManager.isChair(joinedMeetingId, user);
      const isCurrentSpeaker = meeting.current.speaker?.userId === actorId;
      if (!isChair && !isCurrentSpeaker) {
        respond({ ok: false, error: 'Only chairs or the current speaker can advance' });
        return;
      }

      // Precondition check: reject if someone already advanced the speaker.
      // The client sends the CurrentSpeaker id it saw; if it doesn't match
      // the server's current speaker, the view is stale.
      if (parsed.currentSpeakerEntryId !== (meeting.current.speaker?.id ?? null)) {
        // Client's view is stale — send current state so it can update
        socket.emit('state', meeting);
        respond({ ok: false, error: 'Speaker already advanced' });
        return;
      }

      const now = new Date().toISOString();
      ensureUser(meeting, user);

      // Peek at the next speaker before advancing (to decide on topic grouping)
      const nextEntryId = meeting.queue.orderedIds[0];
      const nextEntry = nextEntryId ? meeting.queue.entries[nextEntryId] : undefined;

      // Finalise the previous speaker's duration
      finaliseLastSpeakerDuration(meeting, now);

      // If the next speaker starts a new topic, finalise the current topic group
      if (nextEntry && nextEntry.type === 'topic') {
        finaliseTopicGroup(meeting, actorId, now);
      }

      const newSpeaker = meetingManager.nextSpeaker(joinedMeetingId);

      // Add the new speaker to the current topic group (skip point-of-order)
      if (newSpeaker && newSpeaker.type !== 'point-of-order') {
        meeting.current.topicSpeakers.push({
          userId: newSpeaker.userId,
          type: newSpeaker.type,
          topic: newSpeaker.topic,
          startTime: now,
        });
        meetingManager.markDirty(joinedMeetingId);
      }

      meeting.operational.lastAdvancementBy = actorId;
      broadcastMeetingState(io, meetingManager, joinedMeetingId);
      respond({ ok: true });

      // Persist immediately — speaker changes are high-value events
      meetingManager.syncOne(joinedMeetingId).catch((err) => {
        console.error('Failed to sync after speaker advancement:', err);
      });
    });

    // --- poll:start ---
    // Chair starts a poll with custom options.
    // Minimum 2 options required; each must have emoji and label.
    socket.on('poll:start', (payload) => {
      if (!joinedMeetingId) return;
      if (!meetingManager.isChair(joinedMeetingId, user)) {
        socket.emit('error', 'Only chairs can start a poll');
        return;
      }

      const parsed = parsePayload(PollStartPayloadSchema, payload, socket);
      if (!parsed) return;

      const meeting = meetingManager.get(joinedMeetingId);
      if (!meeting) return;

      meetingManager.startPoll(
        joinedMeetingId,
        parsed.options,
        ensureUser(meeting, user),
        parsed.topic || undefined,
        parsed.multiSelect !== false,
      );

      broadcastMeetingState(io, meetingManager, joinedMeetingId);
    });

    // --- poll:stop ---
    // Chair stops the poll. Clears all reactions and appends a poll-ran log entry.
    socket.on('poll:stop', () => {
      if (!joinedMeetingId) return;
      if (!meetingManager.isChair(joinedMeetingId, user)) {
        socket.emit('error', 'Only chairs can stop a poll');
        return;
      }

      const meeting = meetingManager.get(joinedMeetingId);
      if (!meeting) return;

      const now = new Date().toISOString();
      const chairId = ensureUser(meeting, user);

      // Build the log entry before stopPoll clears the active poll
      const poll = meeting.poll;
      if (poll) {
        // Count distinct voters
        const voterSet = new Set<string>();
        for (const r of poll.reactions) {
          voterSet.add(r.userId);
        }

        // Build results sorted by count descending
        const results = poll.options
          .map((opt) => ({
            emoji: opt.emoji,
            label: opt.label,
            count: poll.reactions.filter((r) => r.optionId === opt.id).length,
          }))
          .sort((a, b) => b.count - a.count);

        meeting.log.push({
          type: 'poll-ran',
          timestamp: poll.startTime,
          startChairId: poll.startChairId,
          endChairId: chairId,
          topic: poll.topic,
          duration: new Date(now).getTime() - new Date(poll.startTime).getTime(),
          totalVoters: voterSet.size,
          results,
        });
      }

      meetingManager.stopPoll(joinedMeetingId);

      broadcastMeetingState(io, meetingManager, joinedMeetingId);
    });

    // --- poll:react ---
    // Any authenticated user can toggle a reaction on a poll
    // check option. Sending the same option ID again removes it.
    socket.on('poll:react', (payload) => {
      if (!joinedMeetingId) return;

      const parsed = parsePayload(PollReactPayloadSchema, payload, socket);
      if (!parsed) return;

      const toggled = meetingManager.toggleReaction(joinedMeetingId, parsed.optionId, user);
      if (!toggled) {
        socket.emit('error', 'Poll is not active or option is invalid');
        return;
      }

      broadcastMeetingState(io, meetingManager, joinedMeetingId);
    });

    // --- meeting:nextAgendaItem ---
    // Chair starts the meeting (first agenda item) or advances to the next one.
    // Uses a precondition check on the current agenda item ID to prevent
    // double-advancement, and persists immediately as a high-value mutation.
    // Uses an ack callback so the client can detect conflicts.
    socket.on('meeting:nextAgendaItem', (payload, ack?) => {
      // ack is optional — clients may emit without a callback
      const respond = typeof ack === 'function' ? ack : () => {};

      if (!joinedMeetingId) return;
      if (!meetingManager.isChair(joinedMeetingId, user)) {
        respond({ ok: false, error: 'Only chairs can advance the agenda' });
        return;
      }

      const parsed = parsePayload(NextAgendaItemPayloadSchema, payload, socket);
      if (!parsed) {
        respond({ ok: false, error: 'Invalid payload' });
        return;
      }

      // Precondition check: reject if another chair already advanced the agenda.
      // The client sends the currentAgendaItemId it sees; if it doesn't match
      // the server's current agenda item, another chair has already acted.
      const meeting = meetingManager.get(joinedMeetingId);
      if (!meeting) return;
      if (parsed.currentAgendaItemId !== (meeting.current.agendaItemId ?? null)) {
        socket.emit('state', meeting);
        respond({ ok: false, error: 'Another chair already advanced the agenda' });
        return;
      }

      const now = new Date().toISOString();
      const chairId = ensureUser(meeting, user);
      const isFirstItem = !meeting.current.agendaItemId;
      const outgoingItem = meetingManager.getCurrentAgendaItem(joinedMeetingId);
      const outgoingStartTime = meeting.current.agendaItemStartTime;

      // Finalise log entries for the outgoing agenda item
      if (outgoingItem && outgoingStartTime) {
        // Finalise the current topic group
        finaliseTopicGroup(meeting, chairId, now);

        // Collect participants from all topic groups during this item
        const participantIds = collectParticipantIds(meeting, outgoingStartTime);

        // Serialise the remaining queue if non-empty
        const remainingQueue =
          meeting.queue.orderedIds.length > 0
            ? meeting.queue.orderedIds
                .map((id) => {
                  const e = meeting.queue.entries[id];
                  const u = meeting.users[e.userId];
                  return `${QUEUE_ENTRY_LABELS[e.type]}: ${e.topic} (${u?.ghUsername ?? e.userId})`;
                })
                .join('\n')
            : undefined;

        // Append agenda-item-finished
        meeting.log.push({
          type: 'agenda-item-finished',
          timestamp: now,
          chairId,
          itemName: outgoingItem.name,
          duration: new Date(now).getTime() - new Date(outgoingStartTime).getTime(),
          participantIds,
          remainingQueue,
        });
      }

      // nextAgendaItem seeds current.speaker, current.topicSpeakers (with the
      // introducing owner), and resets the queue. Its internal timestamp may
      // be a few ms off from `now` captured above — acceptable for display /
      // duration purposes.
      const nextItem = meetingManager.nextAgendaItem(joinedMeetingId);
      if (!nextItem) {
        respond({ ok: false, error: 'No more agenda items' });
        return;
      }

      // Append meeting-started or agenda-item-started
      if (isFirstItem) {
        meeting.log.push({
          type: 'meeting-started',
          timestamp: now,
          chairId,
        });
      }

      meeting.log.push({
        type: 'agenda-item-started',
        timestamp: now,
        chairId,
        itemName: nextItem.name,
        itemOwnerId: nextItem.ownerId,
      });

      meeting.operational.lastAdvancementBy = chairId;
      meetingManager.markDirty(joinedMeetingId);
      broadcastMeetingState(io, meetingManager, joinedMeetingId);
      respond({ ok: true });

      // Persist immediately — agenda advancement is a high-value event
      meetingManager.syncOne(joinedMeetingId).catch((err) => {
        console.error('Failed to sync after agenda advancement:', err);
      });
    });

    // --- disconnect ---
    socket.on('disconnect', () => {
      if (joinedMeetingId) {
        // Update connection stats for admin dashboard (non-admin only)
        if (!user.isAdmin) {
          const stats = getStats(joinedMeetingId);
          stats.currentConnections = Math.max(0, stats.currentConnections - 1);
          if (stats.currentConnections === 0) {
            stats.lastConnection = new Date().toISOString();
          }
        }

        decrementClientCount(io, joinedMeetingId);
      }
    });
  });
}

/**
 * Extract the authenticated user from a socket's handshake session.
 * Returns undefined if no user is set (unauthenticated connection).
 */
function getSocketUser(socket: TypedSocket): SessionUser | undefined {
  // The session is attached to the handshake by the shared session middleware.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const session = (socket.request as any).session;
  return session?.user;
}

/** Increment the count of connected clients for a meeting and record the connection time. */
function incrementClientCount(
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  meetingId: string,
  meetingManager: MeetingManager,
): void {
  const current = meetingClientCounts.get(meetingId) ?? 0;
  meetingClientCounts.set(meetingId, current + 1);

  // Update the persisted last-connection timestamp so the expiry
  // sweep knows when the meeting was last active.
  const meeting = meetingManager.get(meetingId);
  if (meeting) {
    meeting.operational.lastConnectionTime = new Date().toISOString();
    meetingManager.markDirty(meetingId);
  }

  broadcastActiveConnections(io, meetingId);
}

/** Decrement the count of connected clients for a meeting. */
function decrementClientCount(io: Server<ClientToServerEvents, ServerToClientEvents>, meetingId: string): void {
  const current = meetingClientCounts.get(meetingId) ?? 0;
  const next = Math.max(0, current - 1);

  if (next === 0) {
    meetingClientCounts.delete(meetingId);
  } else {
    meetingClientCounts.set(meetingId, next);
  }

  broadcastActiveConnections(io, meetingId);
}

/**
 * Emit the current active-connection count to all sockets in a meeting's room.
 * Called after every increment/decrement so hover tooltips stay up to date.
 * Safe to call after the room has been emptied — socket.io silently
 * no-ops when the room has no members.
 */
function broadcastActiveConnections(io: Server<ClientToServerEvents, ServerToClientEvents>, meetingId: string): void {
  const count = meetingClientCounts.get(meetingId) ?? 0;
  io.to(meetingId).emit('activeConnections', count);
}
