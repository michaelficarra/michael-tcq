import type { Server, Socket } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents, User, MeetingState } from '@tcq/shared';
import { QUEUE_ENTRY_LABELS, userKey } from '@tcq/shared';
import type { MeetingManager } from './meetings.js';
import { ensureUser } from './meetings.js';
import { fetchGitHubUser } from './auth.js';
import { isOAuthConfigured } from './mockAuth.js';
import { isAdmin } from './admin.js';

// -- Log helpers --

/**
 * Finalise the duration of the last speaker in the current topic group.
 * Called before advancing to the next speaker or changing agenda items.
 */
function finaliseLastSpeakerDuration(meeting: MeetingState, now: string): void {
  const speakers = meeting.currentTopicSpeakers;
  if (speakers.length > 0) {
    const last = speakers[speakers.length - 1];
    if (last.duration === undefined) {
      last.duration = new Date(now).getTime() - new Date(last.startTime).getTime();
    }
  }
}

/**
 * Finalise the current topic group into a TopicDiscussedLog entry
 * and append it to the meeting log. Resets currentTopicSpeakers.
 */
function finaliseTopicGroup(meeting: MeetingState, chairId: string, now: string): void {
  if (meeting.currentTopicSpeakers.length === 0) return;

  finaliseLastSpeakerDuration(meeting, now);

  const speakers = meeting.currentTopicSpeakers;
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

  meeting.currentTopicSpeakers = [];
}

/**
 * Collect distinct participant user IDs from topic-discussed log entries
 * that occurred after a given timestamp (the agenda item start).
 * Excludes Point of Order speakers.
 */
function collectParticipantIds(meeting: MeetingState, sinceTimestamp: string): string[] {
  const seen = new Set<string>();

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
  for (const speaker of meeting.currentTopicSpeakers) {
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
        if (!isAdmin(user)) {
          const prevStats = getStats(joinedMeetingId);
          prevStats.currentConnections = Math.max(0, prevStats.currentConnections - 1);
          if (prevStats.currentConnections === 0) {
            prevStats.lastConnection = new Date().toISOString();
          }
        }
        socket.leave(joinedMeetingId);
        decrementClientCount(joinedMeetingId);
      }

      // Join the new meeting room
      joinedMeetingId = meetingId;
      socket.join(meetingId);
      incrementClientCount(meetingId, meetingManager);

      // Track connection stats for admin dashboard (non-admin only)
      if (!isAdmin(user)) {
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

      const userIsAdmin = isAdmin(user);
      const userIsChair = meetingManager.isChair(joinedMeetingId, user);

      if (!userIsChair && !userIsAdmin) {
        socket.emit('error', 'Only chairs or admins can update the chair list');
        return;
      }

      const usernames = payload.usernames
        ?.map((u: string) => u.trim())
        .filter((u: string) => u.length > 0);

      if (!Array.isArray(usernames)) {
        socket.emit('error', 'Invalid chair list');
        return;
      }

      // Non-admin chairs: at least one chair required, cannot remove self
      if (!userIsAdmin) {
        if (usernames.length === 0) {
          socket.emit('error', 'At least one chair is required');
          return;
        }

        const selfIncluded = usernames.some(
          (u: string) => u.toLowerCase() === user.ghUsername.toLowerCase(),
        );
        if (!selfIncluded) {
          socket.emit('error', 'You cannot remove yourself from the chair list');
          return;
        }
      }

      // Resolve each username to a User object
      const meeting = meetingManager.get(joinedMeetingId);
      const chairs: User[] = [];

      for (const username of usernames) {
        const key = username.toLowerCase();

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

      // Build the owner User object. If the owner is a known user in the
      // meeting, use their full profile. Otherwise, create a placeholder.
      const meeting = meetingManager.get(joinedMeetingId);
      const key = ownerUsername.toLowerCase();
      const owner: User =
        meeting?.users[key] ??
        (user.ghUsername.toLowerCase() === key ? user : undefined) ??
        { ghid: 0, ghUsername: ownerUsername, name: ownerUsername, organisation: '' };

      // Parse timebox: treat 0, negative, and NaN as "no timebox"
      const timebox = payload.timebox && payload.timebox > 0 ? payload.timebox : undefined;

      meetingManager.addAgendaItem(joinedMeetingId, name, owner, timebox);
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

      // Build the updates object, resolving owner username if provided
      const updates: { name?: string; owner?: User; timebox?: number | null } = {};

      if (payload.name !== undefined) {
        const trimmed = payload.name.trim();
        if (!trimmed) {
          socket.emit('error', 'Agenda item name cannot be empty');
          return;
        }
        updates.name = trimmed;
      }

      if (payload.ownerUsername !== undefined) {
        const ownerUsername = payload.ownerUsername.trim();
        if (!ownerUsername) {
          socket.emit('error', 'Owner username cannot be empty');
          return;
        }
        // Resolve owner from known users or create placeholder
        const meeting = meetingManager.get(joinedMeetingId);
        const key = ownerUsername.toLowerCase();
        updates.owner = meeting?.users[key] ?? {
          ghid: 0,
          ghUsername: ownerUsername,
          name: ownerUsername,
          organisation: '',
        };
      }

      if (payload.timebox !== undefined) {
        // null clears the timebox; 0 or negative also clears it
        updates.timebox = payload.timebox === null || payload.timebox <= 0
          ? null
          : payload.timebox;
      }

      const edited = meetingManager.editAgendaItem(joinedMeetingId, payload.id, updates);
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
    // Chairs can optionally specify `asUsername` to add an entry on
    // behalf of another user (used by the "Restore Queue" feature).
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

      // Determine who the entry is for: the current user, or a specified
      // user if the chair provided asUsername.
      let entryUser = user;
      if (payload.asUsername) {
        if (!meetingManager.isChair(joinedMeetingId, user)) {
          socket.emit('error', 'Only chairs can add entries on behalf of others');
          return;
        }
        const username = payload.asUsername.trim();
        const key = username.toLowerCase();
        // Look up the user from known meeting participants or create a placeholder.
        const meeting = meetingManager.get(joinedMeetingId);
        entryUser = meeting?.users[key] ?? {
          ghid: 0,
          ghUsername: username,
          name: username,
          organisation: '',
        };
      }

      const entry = meetingManager.addQueueEntry(joinedMeetingId, payload.type, topic, entryUser);
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

      // Check permissions: owner can edit their own, chairs can edit any
      const entry = meetingManager.getQueueEntry(joinedMeetingId, payload.id);
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

      // Build the updates, validating topic if provided
      const updates: { topic?: string; type?: import('@tcq/shared').QueueEntryType } = {};
      if (payload.topic !== undefined) {
        const trimmed = payload.topic.trim();
        if (!trimmed) {
          socket.emit('error', 'Topic cannot be empty');
          return;
        }
        updates.topic = trimmed;
      }
      if (payload.type !== undefined) {
        updates.type = payload.type;
      }

      const edited = meetingManager.editQueueEntry(joinedMeetingId, payload.id, updates);
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

      // Check permissions: user can remove their own entry, chairs can remove any
      const entry = meetingManager.getQueueEntry(joinedMeetingId, payload.id);
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

      meetingManager.removeQueueEntry(joinedMeetingId, payload.id);
      broadcastMeetingState(io, meetingManager, joinedMeetingId);
    });

    // --- queue:reorder ---
    // Reorder a queue entry. Chairs can move any entry anywhere.
    // Participants can move their own entries, but only downward
    // (to a later position) — they can defer but not jump ahead.
    socket.on('queue:reorder', (payload) => {
      if (!joinedMeetingId) return;

      const entry = meetingManager.getQueueEntry(joinedMeetingId, payload.id);
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
          const currentIndex = meeting.queuedSpeakerIds.indexOf(payload.id);
          if (payload.afterId === null) {
            // Moving to the beginning — that's moving up, not allowed
            socket.emit('error', 'You can only move your entry to a later position');
            return;
          }
          const afterIndex = meeting.queuedSpeakerIds.indexOf(payload.afterId);
          if (afterIndex < currentIndex) {
            // Target is above current position — moving up, not allowed
            socket.emit('error', 'You can only move your entry to a later position');
            return;
          }
        }
      }

      const reordered = meetingManager.reorderQueueEntry(
        joinedMeetingId,
        payload.id,
        payload.afterId,
      );
      if (!reordered) {
        socket.emit('error', 'Invalid queue reorder');
        return;
      }

      broadcastMeetingState(io, meetingManager, joinedMeetingId);
    });

    // --- queue:next ---
    // Chair advances to the next speaker. Includes a version check to
    // prevent double-advancement from concurrent chair clicks. Uses an
    // ack callback so the client can retry on stale version.
    socket.on('queue:next', (payload, ack?) => {
      // ack is optional — clients may emit without a callback
      const respond = typeof ack === 'function' ? ack : () => {};

      if (!joinedMeetingId) return;
      if (!meetingManager.isChair(joinedMeetingId, user)) {
        respond({ ok: false, error: 'Only chairs can advance the speaker' });
        return;
      }

      // Version check: reject if the client's state is stale
      const meeting = meetingManager.get(joinedMeetingId);
      if (!meeting) return;
      if (payload.version !== meeting.version) {
        // Client has a stale view — send current state and the new version
        // so the client can retry immediately
        socket.emit('state', meeting);
        respond({ ok: false, version: meeting.version });
        return;
      }

      const now = new Date().toISOString();
      const chairId = ensureUser(meeting, user);

      // Peek at the next speaker before advancing (to decide on topic grouping)
      const nextEntryId = meeting.queuedSpeakerIds[0];
      const nextEntry = nextEntryId ? meeting.queueEntries[nextEntryId] : undefined;

      // Finalise the previous speaker's duration
      finaliseLastSpeakerDuration(meeting, now);

      // If the next speaker starts a new topic, finalise the current topic group
      if (nextEntry && nextEntry.type === 'topic') {
        finaliseTopicGroup(meeting, chairId, now);
      }

      const newSpeaker = meetingManager.nextSpeaker(joinedMeetingId);

      // Add the new speaker to the current topic group (skip point-of-order)
      if (newSpeaker && newSpeaker.type !== 'point-of-order') {
        meeting.currentTopicSpeakers.push({
          userId: newSpeaker.userId,
          type: newSpeaker.type,
          topic: newSpeaker.topic,
          startTime: now,
        });
        meetingManager.markDirty(joinedMeetingId);
      }

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

      // Validate options
      if (!Array.isArray(payload.options) || payload.options.length < 2) {
        socket.emit('error', 'At least 2 poll options are required');
        return;
      }
      for (const opt of payload.options) {
        if (!opt.emoji?.trim() || !opt.label?.trim()) {
          socket.emit('error', 'Each option must have an emoji and a label');
          return;
        }
      }

      const meeting = meetingManager.get(joinedMeetingId);
      if (!meeting) return;

      meetingManager.startPoll(
        joinedMeetingId,
        payload.options.map((o) => ({ emoji: o.emoji.trim(), label: o.label.trim() })),
      );

      // Record poll start metadata for the log entry when the poll ends
      meeting.pollStartTime = new Date().toISOString();
      meeting.pollStartChairId = ensureUser(meeting, user);
      meetingManager.markDirty(joinedMeetingId);

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

      // Build the log entry before stopPoll clears reactions/options
      if (meeting.pollStartTime) {
        // Count distinct voters
        const voterSet = new Set<string>();
        for (const r of meeting.reactions) {
          voterSet.add(r.userId);
        }

        // Build results sorted by count descending
        const results = meeting.pollOptions.map((opt) => ({
          emoji: opt.emoji,
          label: opt.label,
          count: meeting.reactions.filter((r) => r.optionId === opt.id).length,
        })).sort((a, b) => b.count - a.count);

        meeting.log.push({
          type: 'poll-ran',
          timestamp: meeting.pollStartTime,
          startChairId: meeting.pollStartChairId ?? chairId,
          endChairId: chairId,
          duration: new Date(now).getTime() - new Date(meeting.pollStartTime).getTime(),
          totalVoters: voterSet.size,
          results,
        });
      }

      meetingManager.stopPoll(joinedMeetingId);

      // Clear poll start metadata
      meeting.pollStartTime = undefined;
      meeting.pollStartChairId = undefined;
      meetingManager.markDirty(joinedMeetingId);

      broadcastMeetingState(io, meetingManager, joinedMeetingId);
    });

    // --- poll:react ---
    // Any authenticated user can toggle a reaction on a poll
    // check option. Sending the same option ID again removes it.
    socket.on('poll:react', (payload) => {
      if (!joinedMeetingId) return;

      const toggled = meetingManager.toggleReaction(joinedMeetingId, payload.optionId, user);
      if (!toggled) {
        socket.emit('error', 'Poll is not active or option is invalid');
        return;
      }

      broadcastMeetingState(io, meetingManager, joinedMeetingId);
    });

    // --- meeting:nextAgendaItem ---
    // Chair starts the meeting (first agenda item) or advances to the next one.
    // Includes a version check to prevent double-advancement, and persists
    // immediately as a high-value mutation. Uses an ack callback so the
    // client can retry on stale version.
    socket.on('meeting:nextAgendaItem', (payload, ack?) => {
      // ack is optional — clients may emit without a callback
      const respond = typeof ack === 'function' ? ack : () => {};

      if (!joinedMeetingId) return;
      if (!meetingManager.isChair(joinedMeetingId, user)) {
        respond({ ok: false, error: 'Only chairs can advance the agenda' });
        return;
      }

      // Version check: reject if the client's state is stale
      const meeting = meetingManager.get(joinedMeetingId);
      if (!meeting) return;
      if (payload.version !== meeting.version) {
        socket.emit('state', meeting);
        respond({ ok: false, version: meeting.version });
        return;
      }

      const now = new Date().toISOString();
      const chairId = ensureUser(meeting, user);
      const isFirstItem = !meeting.currentAgendaItemId;
      const outgoingItem = meetingManager.getCurrentAgendaItem(joinedMeetingId);
      const outgoingStartTime = meeting.currentAgendaItemStartTime;

      // Finalise log entries for the outgoing agenda item
      if (outgoingItem && outgoingStartTime) {
        // Finalise the current topic group
        finaliseTopicGroup(meeting, chairId, now);

        // Collect participants from all topic groups during this item
        const participantIds = collectParticipantIds(meeting, outgoingStartTime);

        // Serialise the remaining queue if non-empty
        const remainingQueue = meeting.queuedSpeakerIds.length > 0
          ? meeting.queuedSpeakerIds
              .map((id) => {
                const e = meeting.queueEntries[id];
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

      // Track when this agenda item started
      meeting.currentAgendaItemStartTime = now;

      // Start the introductory topic group with the item owner
      meeting.currentTopicSpeakers = [{
        userId: nextItem.ownerId,
        type: 'topic',
        topic: `Introducing: ${nextItem.name}`,
        startTime: now,
      }];

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
        if (!isAdmin(user)) {
          const stats = getStats(joinedMeetingId);
          stats.currentConnections = Math.max(0, stats.currentConnections - 1);
          if (stats.currentConnections === 0) {
            stats.lastConnection = new Date().toISOString();
          }
        }

        decrementClientCount(joinedMeetingId);
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

/** Increment the count of connected clients for a meeting and record the connection time. */
function incrementClientCount(meetingId: string, meetingManager: MeetingManager): void {
  const current = meetingClientCounts.get(meetingId) ?? 0;
  meetingClientCounts.set(meetingId, current + 1);

  // Update the persisted last-connection timestamp so the expiry
  // sweep knows when the meeting was last active.
  const meeting = meetingManager.get(meetingId);
  if (meeting) {
    meeting.lastConnectionTime = new Date().toISOString();
    meetingManager.markDirty(meetingId);
  }
}

/** Decrement the count of connected clients for a meeting. */
function decrementClientCount(meetingId: string): void {
  const current = meetingClientCounts.get(meetingId) ?? 0;
  const next = Math.max(0, current - 1);

  if (next === 0) {
    meetingClientCounts.delete(meetingId);
  } else {
    meetingClientCounts.set(meetingId, next);
  }
}
