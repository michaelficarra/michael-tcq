import type { Server, Socket } from 'socket.io';
import type { ZodType } from 'zod';
import type {
  AgendaItem,
  ClientToServerEvents,
  LogEntry,
  ServerToClientEvents,
  User,
  UserKey,
  MeetingState,
} from '@tcq/shared';
import type { SessionUser } from './session.js';
import {
  QUEUE_ENTRY_LABELS,
  userKey,
  buildUserRefIndex,
  userMatchesIndex,
  AgendaAddPayloadSchema,
  AgendaDeletePayloadSchema,
  AgendaEditPayloadSchema,
  AgendaReorderPayloadSchema,
  AgendaSetEpiloguePayloadSchema,
  AgendaSetProloguePayloadSchema,
  SessionAddPayloadSchema,
  SessionDeletePayloadSchema,
  SessionEditPayloadSchema,
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
  QUEUE_ENTRY_DEFAULT_TOPICS,
} from '@tcq/shared';
import type { MeetingManager } from './meetings.js';
import { ensureUser } from './meetings.js';
import { resolveSelections, resolveHandle, selectionIsSelf } from './resolveUser.js';
import type { AppSettingsManager } from './appSettingsManager.js';
import { info, warning, error as logError, serialiseError, formatLatency } from './logger.js';
import { denormalisePayload, attributionFields } from './socketLogger.js';
import { recordStateResync } from './socketCounters.js';

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

// Presenter/chair selection resolution lives in `resolveUser.ts`
// (`resolveSelections`), provider-neutrally. The handlers below feed it the
// `UserSelection[]` from the wire.

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
 * Returns the appended entry, or null if there was no topic group to
 * finalise.
 */
async function finaliseTopicGroup(
  meetingManager: MeetingManager,
  meeting: MeetingState,
  chairId: UserKey,
  now: string,
): Promise<LogEntry | null> {
  if (meeting.current.topicSpeakers.length === 0) return null;

  finaliseLastSpeakerDuration(meeting, now);

  const speakers = meeting.current.topicSpeakers;
  const firstStart = new Date(speakers[0].startTime).getTime();
  const duration = new Date(now).getTime() - firstStart;

  const stored = await meetingManager.appendLog(meeting.id, {
    type: 'topic-discussed',
    timestamp: speakers[0].startTime,
    chairId,
    topicName: speakers[0].topic,
    speakers: [...speakers],
    duration,
  });

  meeting.current.topicSpeakers = [];
  return stored;
}

/**
 * Collect distinct participant user IDs from topic-discussed log entries
 * that occurred after a given timestamp (the agenda item start).
 * Excludes Point of Order speakers.
 */
function collectParticipantIds(
  meetingManager: MeetingManager,
  meeting: MeetingState,
  sinceTimestamp: string,
): UserKey[] {
  const seen = new Set<UserKey>();

  // Gather from finalised topic groups
  for (const entry of meetingManager.getLog(meeting.id)) {
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

/**
 * Notify all sockets in a meeting room that the log has new entries.
 * The payload carries only the latest entry id; clients fetch the
 * actual data via `GET /api/meetings/:id/log?since=<theirCursor>`.
 * No-op when `latestId` is null, which happens when an attempted
 * `appendLog` returned null (e.g. the meeting was just removed).
 */
function emitLogDirty(
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  meetingId: string,
  latestId: string | null,
): void {
  if (latestId === null) return;
  io.to(meetingId).emit('log:dirty', latestId);
}

/** A Socket with our typed events and session user attached. */
type TypedSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

/**
 * Tracks how many sockets are connected to each meeting. Ephemeral — reset
 * when the process restarts. Persisted connection statistics (max
 * concurrent, last connection time) live on `meeting.operational` so they
 * survive restarts.
 */
const meetingClientCounts = new Map<string, number>();

/** Current active-connection count for a meeting (0 if unknown). */
export function getActiveConnectionCount(meetingId: string): number {
  return meetingClientCounts.get(meetingId) ?? 0;
}

/**
 * Broadcast the full `MeetingState` to all sockets in a meeting's room.
 * Reserved for the resync path: bulk operations like agenda import
 * where a single full-state emit is cheaper than dozens of typed deltas.
 * The initial-join and `state:resync` replies use `socket.emit('state',
 * ...)` directly to send to a single socket rather than the whole room.
 *
 * Mutation handlers should use `emitDelta` instead so connected clients
 * receive only the changed fields rather than the entire `MeetingState`.
 */
export function emitFullState(
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  meetingManager: MeetingManager,
  meetingId: string,
  appSettings: AppSettingsManager,
): void {
  const meeting = meetingManager.get(meetingId);
  if (meeting) {
    io.to(meetingId).emit('state', decorateMeetingForClient(meeting, appSettings));
    // Clear after broadcasting so it only applies to the broadcast that
    // immediately follows the handler that set it. Without this, a stale
    // value could be misattributed if a future code path changes the
    // current speaker without explicitly setting operational.lastAdvancementBy.
    delete meeting.operational.lastAdvancementBy;
  }
}

/**
 * Broadcast the consequences of an admin add/remove on the premium-user
 * list to every meeting room where the affected user is present.
 *
 * Scoped, not global: only rooms whose `meeting.users` map contains the
 * username are re-broadcast, so a list change affecting a user not in
 * any meeting fires no socket traffic at all. We ride on `emitFullState`
 * (rather than introducing a bespoke delta event) because:
 *   - `decorateMeetingForClient` already re-runs `stampPremium` from the
 *     manager on every emit, so a full-state broadcast naturally picks
 *     up the new flag for every user in the room.
 *   - Adding a new delta variant would touch the shared event interface,
 *     `applyDelta`, and three call sites for a feature that fires only
 *     when an admin toggles the list — too much surface for too little
 *     benefit.
 *
 * Note: `emitFullState` clears `lastAdvancementBy` as a side effect. Fine
 * for this code path because we never set it here; mentioned because
 * future readers might wonder why we picked the bulk path.
 */
export function broadcastPremiumChange(
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  meetingManager: MeetingManager,
  appSettings: AppSettingsManager,
  // The canonical premium reference whose flag changed (a GitHub handle or a
  // `provider:id`). Re-broadcast every meeting that contains a matching user.
  premiumRef: string,
): void {
  const index = buildUserRefIndex([premiumRef]);
  for (const meeting of meetingManager.listAll()) {
    if (Object.values(meeting.users).some((u) => userMatchesIndex(u, index))) {
      emitFullState(io, meetingManager, meeting.id, appSettings);
    }
  }
}

/** The set of `ServerToClientEvents` that participate in version sequencing. */
type DeltaEventName =
  | 'chairs:updated'
  | 'agenda:added'
  | 'agenda:edited'
  | 'agenda:deleted'
  | 'agenda:reordered'
  | 'agenda:prologueSet'
  | 'agenda:epilogueSet'
  | 'queue:added'
  | 'queue:edited'
  | 'queue:removed'
  | 'queue:reordered'
  | 'queue:closedChanged'
  | 'speaker:advanced'
  | 'agenda:advanced'
  | 'poll:started'
  | 'poll:stopped'
  | 'poll:reacted';

type DeltaEventPayload<E extends DeltaEventName> = Parameters<ServerToClientEvents[E]>[0];

/**
 * Emit a versioned state-mutation delta to every socket in a meeting's
 * room. Handles the per-meeting version bump and short-circuits if the
 * meeting has been removed in the time between the handler starting
 * and reaching the emit.
 */
function emitDelta<E extends DeltaEventName>(
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  meetingManager: MeetingManager,
  meetingId: string,
  event: E,
  payload: Omit<DeltaEventPayload<E>, 'version'>,
): void {
  const version = meetingManager.bumpVersion(meetingId);
  if (version === null) return;
  // Socket.IO's typed `emit` resolves to a per-event signature derived
  // from `ServerToClientEvents[E]`, and TypeScript can't reconcile the
  // 15-arm discriminated union here. The public `payload` type above
  // still gives the call site full type safety; we route through `any`
  // only at the emit boundary.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (io.to(meetingId).emit as (event: E, payload: any) => void)(event, { ...payload, version });
}

/**
 * Stamp `isPremium: true` on a User if and only if they belong to the
 * premium tier (per the admin-managed list held by `AppSettingsManager`).
 * Non-premium users pass through by reference unchanged — we never write
 * `isPremium: false`, since absence is the default and keeps state/delta
 * payloads small (client treats absent as false).
 */
function stampPremium(u: User, appSettings: AppSettingsManager): User {
  return appSettings.isPremium(u) ? { ...u, isPremium: true } : u;
}

/**
 * Produce a wire-shaped copy of the meeting state for broadcast: same
 * structure, but each User in `users` is decorated via `stampPremium` so
 * premium-tier membership is visible to every connected client. The
 * source meeting is never mutated — important because it's the live
 * in-memory record. Non-premium users are reused by reference, so this
 * is cheap when no premium participants are present.
 */
function decorateMeetingForClient(meeting: MeetingState, appSettings: AppSettingsManager): MeetingState {
  const decoratedUsers: Record<UserKey, User> = {};
  for (const [k, u] of Object.entries(meeting.users)) {
    decoratedUsers[k as UserKey] = stampPremium(u, appSettings);
  }
  return { ...meeting, users: decoratedUsers };
}

/**
 * Build a small `users` map containing just the User records relevant to
 * a delta — used to piggy-back newly-introduced user records onto the
 * delta that first referenced them. The client merges these into its
 * locally-cached `users` so it can render badges immediately without an
 * extra fetch. Idempotent; passing already-known users is harmless.
 *
 * Each User is run through `stampPremium` so deltas carry the premium
 * flag on the same broadcast boundary as full-state emits.
 */
function usersRecordFor(users: User[], appSettings: AppSettingsManager): Record<UserKey, User> {
  const out: Record<UserKey, User> = {};
  for (const u of users) {
    out[userKey(u)] = stampPremium(u, appSettings);
  }
  return out;
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
  appSettings: AppSettingsManager,
): void {
  io.on('connection', (socket: TypedSocket) => {
    // The user was attached to the session by the mock auth (or real OAuth later).
    // Socket.IO shares the Express session via middleware configured in index.ts.
    const user = getSocketUser(socket);
    if (!user) {
      warning('socket_unauthenticated', { socketId: socket.id });
      socket.disconnect(true);
      return;
    }

    info('socket_connected', {
      socketId: socket.id,
      ...attributionFields(user),
    });

    // Per-event logger — fires once per inbound packet before dispatch.
    // Logs the event name, the full payload arguments (minus any ack
    // callbacks, which aren't serialisable), and a convenience top-level
    // `meetingId`. Entity IDs inside the payload are denormalised — we
    // look each one up in the meeting state and substitute the entity
    // itself, so a line like `agenda:reorder` shows the full agenda item
    // being moved rather than an opaque UUID.
    socket.use((packet, next) => {
      const [event, ...args] = packet as [string, ...unknown[]];
      // Drop functions (ack callbacks) from the serialised payload.
      const rawArgs = args.filter((a) => typeof a !== 'function');
      const firstArg = rawArgs[0];
      const meetingId =
        typeof firstArg === 'string'
          ? firstArg
          : firstArg && typeof firstArg === 'object' && 'meetingId' in firstArg
            ? (firstArg as { meetingId?: string }).meetingId
            : undefined;
      // Resolve the meeting: prefer the already-joined room, fall back
      // to the meetingId on the payload (covers the initial `join`).
      const meeting =
        (joinedMeetingId ? meetingManager.get(joinedMeetingId) : undefined) ??
        (meetingId ? meetingManager.get(meetingId) : undefined);
      const loggedArgs = rawArgs.map((a) => denormalisePayload(event, a, meeting));
      const start = process.hrtime.bigint();
      next();
      // `next()` is synchronous for middleware — handler dispatch happens
      // after middleware chain completes. We log the event here; handler
      // latency isn't measurable from this vantage point since handlers
      // are registered via socket.on and run asynchronously.
      const latency = formatLatency(process.hrtime.bigint() - start);
      info('socket_event', {
        event,
        socketId: socket.id,
        ...attributionFields(user),
        ...(meetingId ? { meetingId } : {}),
        // Single-arg events (like `join: meetingId`) flatten to one value;
        // multi-arg events keep the array form so positional relationships
        // are preserved.
        args: loggedArgs.length === 1 ? loggedArgs[0] : loggedArgs,
        middlewareLatency: latency,
      });
    });

    // Track which meeting this socket has joined (at most one).
    let joinedMeetingId: string | null = null;

    // Queue entries this socket added via the interactive (pending) path
    // and which haven't been finalised yet. On disconnect we finalise any
    // still-pending entries with the default-for-type topic so the row
    // doesn't get stuck on a bouncing-dots typing indicator for every
    // remaining participant. Entries are removed from this set when the
    // socket finalises them or when they're noticed to be no longer
    // pending (edit/remove from elsewhere clears the flag).
    const pendingEntryIds = new Set<string>();

    // --- join ---
    // Client sends the meeting ID it wants to join. The socket is added to
    // that meeting's Socket.IO room and receives the full current state.
    socket.on('join', (meetingId: string) => {
      const meeting = meetingManager.get(meetingId);
      // Soft-deleted meetings are indistinguishable from non-existent
      // ones over the socket transport — the admin DELETE handler
      // proactively boots any sockets that were already joined, so the
      // only callers that hit this branch are clients deep-linking to
      // a stale id.
      if (!meeting || meeting.deletedAt !== undefined) {
        socket.emit('error', 'Meeting not found');
        return;
      }

      // Leave any previously joined meeting room
      if (joinedMeetingId) {
        socket.leave(joinedMeetingId);
        decrementClientCount(io, joinedMeetingId, meetingManager);
      }

      // Join the new meeting room
      joinedMeetingId = meetingId;
      socket.join(meetingId);
      incrementClientCount(io, meetingId, meetingManager);

      // Record this user in the persisted participants list if they
      // haven't already joined. Distinct from `users`, which also grows
      // when someone is referenced in an agenda item or queue entry even
      // without connecting.
      const joinerKey = userKey(user);
      if (!meeting.participantIds.includes(joinerKey)) {
        meeting.participantIds.push(joinerKey);
        meetingManager.markDirty(meetingId);
      }

      // Also record the joining user in `meeting.users` so they surface in
      // the username-autocomplete tier-1 candidates (people in the same
      // meeting). Without this, a user who connects but never grabs the
      // floor / is named on an agenda item / enters the queue would be
      // invisible to tier 1 even though they're sitting in the room.
      // `ensureUser` overwrites in place, so refreshing on every join also
      // picks up display-name / company changes between sessions.
      ensureUser(meeting, user);

      // Tell the client which Cloud Run revision this socket is bound to.
      // Sent before `state` so the client's revision baseline is set
      // before any other meeting traffic flows. `K_REVISION` is injected
      // by Cloud Run; absent in local dev / tests, in which case the
      // client's staleness check is a no-op.
      socket.emit('server:revision', { revision: process.env.K_REVISION ?? null });

      // Send the full current state to this socket only
      socket.emit('state', decorateMeetingForClient(meeting, appSettings));
    });

    // --- state:resync ---
    // Client noticed a gap in the delta-version sequence and wants a
    // fresh full-state snapshot. Reply only to the requesting socket so
    // we don't re-broadcast to clients that are already up to date.
    // Also bumps a server-wide counter — in steady state this should be
    // near-zero per meeting; a rising count is the canary for a delta
    // reducer silently mis-applying state on the client side.
    socket.on('state:resync', () => {
      if (!joinedMeetingId) return;
      const meeting = meetingManager.get(joinedMeetingId);
      if (!meeting) return;
      recordStateResync();
      socket.emit('state', decorateMeetingForClient(meeting, appSettings));
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
      const selections = parsed.chairs;

      // Non-admin chairs: at least one chair required, cannot remove self
      if (!userIsAdmin) {
        if (selections.length === 0) {
          socket.emit('error', 'At least one chair is required');
          return;
        }

        const selfIncluded = selections.some((sel) => selectionIsSelf(user, sel));
        if (!selfIncluded) {
          socket.emit('error', 'You cannot remove yourself from the chair list');
          return;
        }
      }

      // Resolve each selection to a User (provider-neutral).
      const meeting = meetingManager.get(joinedMeetingId);
      const resolvedChairs = resolveSelections(user, meeting, selections);
      const chairs = resolvedChairs instanceof Promise ? await resolvedChairs : resolvedChairs;
      // Non-admins must end up with at least one chair (the self-inclusion
      // guard above already required it among the selections); admins may
      // deliberately set an empty list.
      if (!userIsAdmin && chairs.length === 0) {
        socket.emit('error', 'At least one valid chair is required');
        return;
      }

      meetingManager.updateChairs(joinedMeetingId, chairs);
      const updated = meetingManager.get(joinedMeetingId);
      if (!updated) return;
      emitDelta(io, meetingManager, joinedMeetingId, 'chairs:updated', {
        chairIds: updated.chairIds,
        users: usersRecordFor(chairs, appSettings),
      });
    });

    // --- agenda:add ---
    // Chair adds a new agenda item. Presenters arrive as `UserSelection`s and
    // are resolved provider-neutrally via `resolveSelections` (picked accounts
    // re-resolved against the provider; unmatched free text → placeholders).
    socket.on('agenda:add', async (payload) => {
      if (!joinedMeetingId) return;
      if (!meetingManager.isChair(joinedMeetingId, user)) {
        socket.emit('error', 'Only chairs can add agenda items');
        return;
      }

      const parsed = parsePayload(AgendaAddPayloadSchema, payload, socket);
      if (!parsed) return;
      const { name, presenters: presenterSelections } = parsed;

      const meeting = meetingManager.get(joinedMeetingId);
      const resolved = resolveSelections(user, meeting, presenterSelections);
      // Sync-when-possible: the await is only paid when at least one
      // presenter required a provider lookup, preserving the synchronous
      // handler ordering everywhere else.
      const presenters = resolved instanceof Promise ? await resolved : resolved;

      // The schema already constrains duration to a positive integer; undefined = no estimate.
      const entry = meetingManager.addAgendaItem(joinedMeetingId, name, presenters, parsed.duration);
      if (!entry) return;

      // Past-final auto-activation: the manager mutates `current`/`queue`
      // atomically with the add when the meeting was past-final. Detect
      // it by checking whether the new item is now the current one —
      // then mirror the advance handler's side-effects (log
      // `agenda-item-started`, stamp `lastAdvancementBy`, bundle the
      // fresh state into the delta so clients apply it atomically).
      const meetingAfter = meetingManager.get(joinedMeetingId);
      const autoActivated = meetingAfter !== undefined && meetingAfter.current.agendaItemId === entry.id;

      let logIdToEmit: string | null = null;
      let chairId: UserKey | undefined;
      if (autoActivated) {
        chairId = ensureUser(meetingAfter, user);
        const startedEntry = await meetingManager.appendLog(joinedMeetingId, {
          type: 'agenda-item-started',
          timestamp: meetingAfter.current.agendaItemStartTime ?? new Date().toISOString(),
          chairId,
          itemName: entry.name,
          itemPresenterIds: entry.presenterIds,
        });
        if (startedEntry) logIdToEmit = startedEntry.id;
        meetingAfter.operational.lastAdvancementBy = chairId;
      }

      // The chair's User record always rides along on auto-activation so
      // any field upgrades (e.g. acquiring `isAdmin` on first connect)
      // propagate to client caches. Plain presenter records cover the
      // standard "added an item with new presenters" case.
      const usersForDelta: Record<UserKey, User> = usersRecordFor(presenters, appSettings);
      if (autoActivated && chairId) usersForDelta[chairId] = meetingAfter.users[chairId];

      emitDelta(io, meetingManager, joinedMeetingId, 'agenda:added', {
        entry,
        current: autoActivated ? meetingAfter.current : undefined,
        queue: autoActivated ? meetingAfter.queue : undefined,
        lastAdvancementBy: autoActivated ? chairId : undefined,
        users: usersForDelta,
      });
      if (autoActivated) {
        delete meetingAfter.operational.lastAdvancementBy;
        emitLogDirty(io, joinedMeetingId, logIdToEmit);
        // Auto-activation is a high-value event (it transitions the
        // meeting from past-final back into in-progress) — persist
        // immediately like the advance handler.
        meetingManager.syncOne(joinedMeetingId).catch((err) => {
          logError('meeting_sync_failed', {
            meetingId: joinedMeetingId,
            trigger: 'agenda_added_auto_activated',
            error: serialiseError(err),
          });
        });
      }
    });

    // --- agenda:edit ---
    // Chair edits an existing agenda item's name, presenters, or duration.
    socket.on('agenda:edit', async (payload) => {
      if (!joinedMeetingId) return;
      if (!meetingManager.isChair(joinedMeetingId, user)) {
        socket.emit('error', 'Only chairs can edit agenda items');
        return;
      }

      const parsed = parsePayload(AgendaEditPayloadSchema, payload, socket);
      if (!parsed) return;

      const updates: { name?: string; presenters?: User[]; duration?: number | null } = {};

      if (parsed.name !== undefined) updates.name = parsed.name;

      if (parsed.presenters !== undefined) {
        const meeting = meetingManager.get(joinedMeetingId);
        const resolved = resolveSelections(user, meeting, parsed.presenters);
        updates.presenters = resolved instanceof Promise ? await resolved : resolved;
      }

      if (parsed.duration !== undefined) {
        // null clears the duration; 0 or negative also clears it
        updates.duration = parsed.duration === null || parsed.duration <= 0 ? null : parsed.duration;
      }

      const edited = meetingManager.editAgendaItem(joinedMeetingId, parsed.id, updates);
      if (!edited) {
        socket.emit('error', 'Agenda item not found');
        return;
      }

      const meeting = meetingManager.get(joinedMeetingId);
      const entry = meeting?.agenda.find((e) => e.id === parsed.id);
      if (!entry) return;
      emitDelta(io, meetingManager, joinedMeetingId, 'agenda:edited', {
        id: parsed.id,
        entry,
        users: updates.presenters ? usersRecordFor(updates.presenters, appSettings) : undefined,
      });
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

      // The current agenda item is off-limits — the chair must advance
      // (Next Agenda Item) to move off it before it can be deleted.
      // Emit a distinct error so the UI can explain why if it somehow
      // sends the request despite hiding the button.
      const meetingBefore = meetingManager.get(joinedMeetingId);
      if (meetingBefore?.current.agendaItemId === parsed.id) {
        socket.emit('error', 'Cannot delete the current agenda item');
        return;
      }

      const deleted = meetingManager.deleteAgendaItem(joinedMeetingId, parsed.id);
      if (!deleted) {
        socket.emit('error', 'Agenda item not found');
        return;
      }

      emitDelta(io, meetingManager, joinedMeetingId, 'agenda:deleted', {
        id: parsed.id,
        currentCleared: false,
      });
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

      const meeting = meetingManager.get(joinedMeetingId);
      if (!meeting) return;
      emitDelta(io, meetingManager, joinedMeetingId, 'agenda:reordered', {
        orderedIds: meeting.agenda.map((e) => e.id),
      });
    });

    // --- agenda:setPrologue ---
    // Chair sets or clears the agenda prologue (block markdown shown
    // above the agenda list). Empty or whitespace-only input is
    // normalised to "cleared" — saving with an empty editor is the
    // documented way to delete.
    socket.on('agenda:setPrologue', (payload) => {
      if (!joinedMeetingId) return;
      if (!meetingManager.isChair(joinedMeetingId, user)) {
        socket.emit('error', 'Only chairs can edit the agenda prologue');
        return;
      }
      const parsed = parsePayload(AgendaSetProloguePayloadSchema, payload, socket);
      if (!parsed) return;
      const value = parsed.prologue && parsed.prologue.length > 0 ? parsed.prologue : undefined;
      const ok = meetingManager.setPrologue(joinedMeetingId, value);
      if (!ok) return;
      emitDelta(io, meetingManager, joinedMeetingId, 'agenda:prologueSet', { value });
    });

    // --- agenda:setEpilogue ---
    // Same shape as `agenda:setPrologue` but for the epilogue section.
    socket.on('agenda:setEpilogue', (payload) => {
      if (!joinedMeetingId) return;
      if (!meetingManager.isChair(joinedMeetingId, user)) {
        socket.emit('error', 'Only chairs can edit the agenda epilogue');
        return;
      }
      const parsed = parsePayload(AgendaSetEpiloguePayloadSchema, payload, socket);
      if (!parsed) return;
      const value = parsed.epilogue && parsed.epilogue.length > 0 ? parsed.epilogue : undefined;
      const ok = meetingManager.setEpilogue(joinedMeetingId, value);
      if (!ok) return;
      emitDelta(io, meetingManager, joinedMeetingId, 'agenda:epilogueSet', { value });
    });

    // --- session:add ---
    // Chair adds a new session header. Appended to the end of the agenda;
    // the chair reorders it into position via `agenda:reorder`.
    socket.on('session:add', (payload) => {
      if (!joinedMeetingId) return;
      if (!meetingManager.isChair(joinedMeetingId, user)) {
        socket.emit('error', 'Only chairs can add sessions');
        return;
      }

      const parsed = parsePayload(SessionAddPayloadSchema, payload, socket);
      if (!parsed) return;

      const session = meetingManager.addSession(joinedMeetingId, parsed.name, parsed.capacity);
      if (!session) return;
      // Sessions are agenda entries — they share the `agenda:added` channel.
      emitDelta(io, meetingManager, joinedMeetingId, 'agenda:added', { entry: session });
    });

    // --- session:edit ---
    // Chair edits an existing session's name or capacity.
    socket.on('session:edit', (payload) => {
      if (!joinedMeetingId) return;
      if (!meetingManager.isChair(joinedMeetingId, user)) {
        socket.emit('error', 'Only chairs can edit sessions');
        return;
      }

      const parsed = parsePayload(SessionEditPayloadSchema, payload, socket);
      if (!parsed) return;

      const updates: { name?: string; capacity?: number } = {};
      if (parsed.name !== undefined) updates.name = parsed.name;
      if (parsed.capacity !== undefined) updates.capacity = parsed.capacity;

      const edited = meetingManager.editSession(joinedMeetingId, parsed.id, updates);
      if (!edited) {
        socket.emit('error', 'Session not found');
        return;
      }

      const meeting = meetingManager.get(joinedMeetingId);
      const entry = meeting?.agenda.find((e) => e.id === parsed.id);
      if (!entry) return;
      emitDelta(io, meetingManager, joinedMeetingId, 'agenda:edited', { id: parsed.id, entry });
    });

    // --- session:delete ---
    // Chair removes a session header. Contained agenda items are left
    // alone — containment is a client-side display concept.
    socket.on('session:delete', (payload) => {
      if (!joinedMeetingId) return;
      if (!meetingManager.isChair(joinedMeetingId, user)) {
        socket.emit('error', 'Only chairs can delete sessions');
        return;
      }

      const parsed = parsePayload(SessionDeletePayloadSchema, payload, socket);
      if (!parsed) return;

      const deleted = meetingManager.deleteSession(joinedMeetingId, parsed.id);
      if (!deleted) {
        socket.emit('error', 'Session not found');
        return;
      }

      // Sessions can't be the current agenda item (only items can), so
      // `currentCleared` is always false here.
      emitDelta(io, meetingManager, joinedMeetingId, 'agenda:deleted', {
        id: parsed.id,
        currentCleared: false,
      });
    });

    // --- queue:add ---
    // Any authenticated user can add themselves to the speaker queue.
    // Chairs can optionally specify `asUsername` to add an entry on
    // behalf of another user (used by the "Restore Queue" feature).
    //
    // For `type: 'reply'`, the client sends the speakerId of the CurrentTopic
    // it saw as a precondition. This guards the race where the chair advances
    // the agenda (which clears the topic) or advances onto a different topic
    // between the user clicking Reply and this handler running — we reject
    // rather than attach the reply to the wrong topic.
    socket.on('queue:add', async (payload, ack?) => {
      // ack is optional — older clients may emit without a callback.
      const respond = typeof ack === 'function' ? ack : () => {};

      if (!joinedMeetingId) return;

      const parsed = parsePayload(QueueAddPayloadSchema, payload, socket);
      if (!parsed) {
        respond({ ok: false, error: 'Invalid payload' });
        return;
      }

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
        respond({ ok: false, error: 'The queue is closed' });
        return;
      }

      // Precondition check for replies: the topic the user intended to reply
      // to must still be the current topic. `undefined` in the payload means
      // the client didn't send the precondition — treat that as a mismatch
      // for replies so stale clients can't silently bypass the guard. There
      // must also actually be a current topic — a reply with no topic to
      // reply to is nonsensical regardless of what the client claimed. The
      // asUsername path (chair-driven bulk restore) bypasses this — it's a
      // deliberate admin operation, not a UI race.
      if (parsed.type === 'reply' && !parsed.asUsername) {
        const currentSpeakerId = addMeeting?.current.topic?.speakerId ?? null;
        const claimedSpeakerId = parsed.currentTopicSpeakerId ?? null;
        const noActiveTopic = currentSpeakerId === null;
        const preconditionMismatch =
          parsed.currentTopicSpeakerId === undefined || currentSpeakerId !== claimedSpeakerId;
        if (noActiveTopic || preconditionMismatch) {
          // Re-broadcast state to the stale client so it reconciles.
          if (addMeeting) socket.emit('state', decorateMeetingForClient(addMeeting, appSettings));
          const message = noActiveTopic
            ? 'No topic is currently active - you can not reply'
            : 'Topic has changed — your reply was not added';
          socket.emit('error', message);
          respond({ ok: false, error: message });
          return;
        }
      }

      // Determine who the entry is for: the current user, or a specified
      // user if the chair provided asUsername. Typed as User (not SessionUser)
      // so the placeholder / looked-up branches don't need an isAdmin flag.
      let entryUser: User = user;
      if (parsed.asUsername) {
        if (!meetingManager.isChair(joinedMeetingId, user)) {
          socket.emit('error', 'Only chairs can add entries on behalf of others');
          respond({ ok: false, error: 'Only chairs can add entries on behalf of others' });
          return;
        }
        // `asUsername` is a typed handle (parsed from a chair command), so
        // resolve it via the free-text path: known participant → provider
        // handle lookup → placeholder.
        const meeting = meetingManager.get(joinedMeetingId);
        entryUser = await resolveHandle(user, meeting, parsed.asUsername);
      }

      // Decide whether this is a "pending initial-edit" add or a finished
      // add. The asUsername (chair restore) path never creates pending
      // entries — those represent already-saved entries being re-added, not
      // a user composing a topic in real time. For the interactive path we
      // honour the client's `pending` flag; when set, we also stamp the
      // default-for-type topic so the entry has a sensible value to fall
      // back to if the author cancels (Escape/empty Save).
      const isPendingAdd = parsed.pending === true && !parsed.asUsername;
      const topic = parsed.topic ?? (isPendingAdd ? QUEUE_ENTRY_DEFAULT_TOPICS[parsed.type] : '');
      if (!topic) {
        // Non-pending adds without a topic are invalid (the schema lets it
        // through because pending omits it, but a chair-restore must supply
        // one). Surface a clear error rather than persisting an empty topic.
        socket.emit('error', 'Topic is required');
        respond({ ok: false, error: 'Topic is required' });
        return;
      }

      const entry = meetingManager.addQueueEntry(joinedMeetingId, parsed.type, topic, entryUser, isPendingAdd);
      if (!entry) {
        socket.emit('error', 'Failed to add queue entry');
        respond({ ok: false, error: 'Failed to add queue entry' });
        return;
      }

      // Track for disconnect-finalise. Only the socket that created the
      // pending entry tracks it; if the user has another tab open with the
      // editor, that other tab is unaffected by this socket's disconnect.
      if (isPendingAdd) pendingEntryIds.add(entry.id);

      const meeting = meetingManager.get(joinedMeetingId);
      if (!meeting) return;
      const position = meeting.queue.orderedIds.indexOf(entry.id);
      emitDelta(io, meetingManager, joinedMeetingId, 'queue:added', {
        entry,
        position,
        users: usersRecordFor([entryUser], appSettings),
      });
      respond({ ok: true });
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

      // `editQueueEntry` clears the `pending` flag for us when the entry
      // was in the initial-edit state — editing the topic constitutes
      // finalising the composition. We still need to drop the id from the
      // per-socket disconnect-cleanup set so the eventual disconnect
      // doesn't try to delete the now-finalised entry.
      if (entry.pending) pendingEntryIds.delete(parsed.id);

      const updatedEntry = meetingManager.getQueueEntry(joinedMeetingId, parsed.id);
      if (!updatedEntry) return;
      emitDelta(io, meetingManager, joinedMeetingId, 'queue:edited', {
        id: parsed.id,
        entry: updatedEntry,
      });
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
      emitDelta(io, meetingManager, joinedMeetingId, 'queue:removed', { id: parsed.id });
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

      // Non-chair owners may move their entry downward freely (defer), and
      // upward only across other entries they themselves own — i.e. they may
      // reorder among their own contiguous block but never jump ahead of
      // someone else.
      if (isOwner && !isChairUser) {
        const meeting = meetingManager.get(joinedMeetingId);
        if (meeting) {
          const currentIndex = meeting.queue.orderedIds.indexOf(parsed.id);
          // Compute the target index after the move, mirroring the math in
          // meetingManager.reorderQueueEntry: the entry is removed first,
          // then inserted just after `afterId` (or at index 0 if null).
          let targetIndex: number;
          if (parsed.afterId === null) {
            targetIndex = 0;
          } else {
            const afterIndex = meeting.queue.orderedIds.indexOf(parsed.afterId);
            if (afterIndex === -1) {
              // afterId isn't in the queue; let reorderQueueEntry below
              // produce the canonical "Invalid queue reorder" error.
              targetIndex = currentIndex;
            } else {
              targetIndex = afterIndex < currentIndex ? afterIndex + 1 : afterIndex;
            }
          }
          // Only upward moves require validation; downward and no-op moves
          // are always allowed for an owner.
          if (targetIndex < currentIndex) {
            const ownerKey = userKey(user);
            // Every entry being jumped over (the slice the moving entry
            // would pass through) must belong to the same owner.
            const jumpedOver = meeting.queue.orderedIds.slice(targetIndex, currentIndex);
            const allOwned = jumpedOver.every((id) => meeting.queue.entries[id]?.userId === ownerKey);
            if (!allOwned) {
              socket.emit('error', 'You can only move your entry above your own entries');
              return;
            }
          }
        }
      }

      // Snapshot the moved entry's type so we can tell the client about
      // any priority-crossing type change applied by the manager.
      const typeBefore = entry.type;

      const reordered = meetingManager.reorderQueueEntry(joinedMeetingId, parsed.id, parsed.afterId);
      if (!reordered) {
        socket.emit('error', 'Invalid queue reorder');
        return;
      }

      const meeting = meetingManager.get(joinedMeetingId);
      if (!meeting) return;
      const movedAfter = meeting.queue.entries[parsed.id];
      // Only include `updatedEntries` if the manager mutated the entry's
      // type — clients can otherwise infer the new shape from existing
      // local state plus the new ordering.
      const updatedEntries = movedAfter && movedAfter.type !== typeBefore ? { [parsed.id]: movedAfter } : undefined;
      emitDelta(io, meetingManager, joinedMeetingId, 'queue:reordered', {
        orderedIds: [...meeting.queue.orderedIds],
        updatedEntries,
      });
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
      emitDelta(io, meetingManager, joinedMeetingId, 'queue:closedChanged', {
        closed: parsed.closed,
      });
    });

    // --- queue:next ---
    // Advances to the next speaker (chair-only). Uses a precondition check on
    // the current speaker entry ID to prevent double-advancement. Uses an ack
    // callback so the client can detect conflicts.
    socket.on('queue:next', async (payload, ack?) => {
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

      const actorId = userKey(user);
      if (!meetingManager.isChair(joinedMeetingId, user)) {
        respond({ ok: false, error: 'Only chairs can advance the speaker' });
        return;
      }

      // Precondition check: reject if someone already advanced the speaker.
      // The client sends the CurrentSpeaker id it saw; if it doesn't match
      // the server's current speaker, the view is stale.
      if (parsed.currentSpeakerEntryId !== (meeting.current.speaker?.id ?? null)) {
        // Client's view is stale — send current state so it can update
        socket.emit('state', decorateMeetingForClient(meeting, appSettings));
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
      let topicLogId: string | null = null;
      if (nextEntry && nextEntry.type === 'topic') {
        const topicEntry = await finaliseTopicGroup(meetingManager, meeting, actorId, now);
        if (topicEntry) topicLogId = topicEntry.id;
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
      emitDelta(io, meetingManager, joinedMeetingId, 'speaker:advanced', {
        current: meeting.current,
        queue: meeting.queue,
        lastAdvancementBy: actorId,
        // The actor's User record may have just been refreshed by
        // `ensureUser` above (e.g. acquiring the session-only `isAdmin`
        // flag), so carry it on the delta so the client cache picks up
        // the latest fields rather than retaining an older placeholder.
        users: { [actorId]: meeting.users[actorId] },
      });
      // Mirror the historical full-state broadcast behaviour: clear
      // `lastAdvancementBy` after the emit so it only ever rides on the
      // immediately-following delta.
      delete meeting.operational.lastAdvancementBy;
      emitLogDirty(io, joinedMeetingId, topicLogId);
      respond({ ok: true });

      // Persist immediately — speaker changes are high-value events
      meetingManager.syncOne(joinedMeetingId).catch((err) => {
        logError('meeting_sync_failed', {
          meetingId: joinedMeetingId,
          trigger: 'speaker_advanced',
          error: serialiseError(err),
        });
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

      const updated = meetingManager.get(joinedMeetingId);
      if (!updated?.poll) return;
      emitDelta(io, meetingManager, joinedMeetingId, 'poll:started', { poll: updated.poll });
    });

    // --- poll:stop ---
    // Chair stops the poll. Clears all reactions and appends a poll-ran log entry.
    socket.on('poll:stop', async () => {
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
      let pollLog: LogEntry | null = null;
      if (poll) {
        // Single pass over reactions: tally distinct voters and per-option
        // counts together. The previous form filtered reactions once per
        // option, which is O(reactions × options) — a one-pass aggregation
        // is O(reactions + options) and behaves better as polls scale.
        const voterSet = new Set<string>();
        const counts = new Map<string, number>();
        for (const r of poll.reactions) {
          voterSet.add(r.userId);
          counts.set(r.optionId, (counts.get(r.optionId) ?? 0) + 1);
        }

        // Build results sorted by count descending
        const results = poll.options
          .map((opt) => ({
            emoji: opt.emoji,
            label: opt.label,
            count: counts.get(opt.id) ?? 0,
          }))
          .sort((a, b) => b.count - a.count);

        pollLog = await meetingManager.appendLog(joinedMeetingId, {
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

      emitDelta(io, meetingManager, joinedMeetingId, 'poll:stopped', {});
      emitLogDirty(io, joinedMeetingId, pollLog?.id ?? null);
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

      const meeting = meetingManager.get(joinedMeetingId);
      if (!meeting?.poll) return;
      emitDelta(io, meetingManager, joinedMeetingId, 'poll:reacted', {
        reactions: [...meeting.poll.reactions],
      });
    });

    // --- meeting:nextAgendaItem ---
    // Chair starts the meeting (first agenda item) or advances to the next one.
    // Uses a precondition check on the current agenda item ID to prevent
    // double-advancement, and persists immediately as a high-value mutation.
    // Uses an ack callback so the client can detect conflicts.
    socket.on('meeting:nextAgendaItem', async (payload, ack?) => {
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
        socket.emit('state', decorateMeetingForClient(meeting, appSettings));
        respond({ ok: false, error: 'Another chair already advanced the agenda' });
        return;
      }

      const now = new Date().toISOString();
      const chairId = ensureUser(meeting, user);
      const isFirstItem = !meeting.current.agendaItemId;
      const outgoingItem = meetingManager.getCurrentAgendaItem(joinedMeetingId);
      const outgoingStartTime = meeting.current.agendaItemStartTime;

      // Track the most recently appended log entry id so we can emit a
      // single log:dirty at the end with the final cursor — clients
      // catch up on every prior append in one fetch.
      let latestLogId: string | null = null;
      // Collect any agenda items the handler mutates so we can carry
      // them in the `agenda:advanced` delta's `agendaUpdates` map.
      const agendaUpdates: Record<string, Partial<AgendaItem>> = {};

      // Finalise log entries for the outgoing agenda item
      if (outgoingItem && outgoingStartTime) {
        // Finalise the current topic group
        const topicEntry = await finaliseTopicGroup(meetingManager, meeting, chairId, now);
        if (topicEntry) latestLogId = topicEntry.id;

        // Collect participants from all topic groups during this item
        const participantIds = collectParticipantIds(meetingManager, meeting, outgoingStartTime);

        // Serialise the remaining queue if non-empty
        const remainingQueue =
          meeting.queue.orderedIds.length > 0
            ? meeting.queue.orderedIds
                .map((id) => {
                  const e = meeting.queue.entries[id];
                  const u = meeting.users[e.userId];
                  return `${QUEUE_ENTRY_LABELS[e.type]}: ${e.topic} (${u?.handle ?? u?.accountId ?? e.userId})`;
                })
                .join('\n')
            : undefined;

        const durationMs = new Date(now).getTime() - new Date(outgoingStartTime).getTime();

        // Replace the outgoing item's duration with the actual elapsed time,
        // rounded up to the nearest minute. An item's estimated duration
        // becomes its realised duration on completion.
        outgoingItem.duration = Math.ceil(durationMs / 60000);

        // Persist the chair's conclusion onto the outgoing item, if provided.
        // Trim and treat empty as "no conclusion" so revisits start from a
        // clean slate when cleared. `undefined` (field omitted) leaves any
        // existing conclusion untouched — but in the dialog flow the client
        // always sends the field, so this branch only matters for callers
        // that emit without a conclusion (e.g. tests).
        let conclusionForLog: string | undefined;
        if (parsed.conclusion !== undefined) {
          const trimmed = parsed.conclusion.trim();
          outgoingItem.conclusion = trimmed.length > 0 ? trimmed : undefined;
          conclusionForLog = outgoingItem.conclusion;
        } else {
          conclusionForLog = outgoingItem.conclusion;
        }

        // Capture the outgoing item's mutated fields for the delta.
        agendaUpdates[outgoingItem.id] = {
          duration: outgoingItem.duration,
          conclusion: outgoingItem.conclusion,
        };

        // Append agenda-item-finished
        const finishedEntry = await meetingManager.appendLog(joinedMeetingId, {
          type: 'agenda-item-finished',
          timestamp: now,
          chairId,
          itemName: outgoingItem.name,
          duration: durationMs,
          participantIds,
          remainingQueue,
          conclusion: conclusionForLog,
        });
        if (finishedEntry) latestLogId = finishedEntry.id;
      }

      // nextAgendaItem seeds current.speaker, current.topicSpeakers (with the
      // first presenter introducing), and resets the queue. Its internal
      // timestamp may be a few ms off from `now` captured above — acceptable
      // for display / duration purposes.
      const advanceResult = meetingManager.nextAgendaItem(joinedMeetingId);
      if (advanceResult.kind === 'none') {
        respond({ ok: false, error: 'No more agenda items' });
        // Even if we can't advance, prior appendLog calls (topic group
        // finalisation, agenda-item-finished) may have produced log
        // entries that connected clients should learn about.
        emitLogDirty(io, joinedMeetingId, latestLogId);
        return;
      }

      // Past-final transition: the chair advanced past the last item to
      // record its conclusion. No new agenda-item-started log (no item
      // to introduce) — the outgoing item's conclusion is the only
      // signal. The cleared `current` rides on the same delta as the
      // outgoing item's agendaUpdates.
      if (advanceResult.kind === 'advanced') {
        // Append meeting-started or agenda-item-started
        if (isFirstItem) {
          const startedEntry = await meetingManager.appendLog(joinedMeetingId, {
            type: 'meeting-started',
            timestamp: now,
            chairId,
          });
          if (startedEntry) latestLogId = startedEntry.id;
        }

        const itemStartedEntry = await meetingManager.appendLog(joinedMeetingId, {
          type: 'agenda-item-started',
          timestamp: now,
          chairId,
          itemName: advanceResult.item.name,
          itemPresenterIds: advanceResult.item.presenterIds,
        });
        if (itemStartedEntry) latestLogId = itemStartedEntry.id;
      }

      meeting.operational.lastAdvancementBy = chairId;
      meetingManager.markDirty(joinedMeetingId);
      emitDelta(io, meetingManager, joinedMeetingId, 'agenda:advanced', {
        current: meeting.current,
        queue: meeting.queue,
        agendaUpdates: Object.keys(agendaUpdates).length > 0 ? agendaUpdates : undefined,
        lastAdvancementBy: chairId,
        // Carry the chair's current User record so any field upgrades
        // (e.g. promoting from a placeholder to a session-flagged
        // record with `isAdmin`) propagate to client caches.
        users: { [chairId]: meeting.users[chairId] },
      });
      delete meeting.operational.lastAdvancementBy;
      emitLogDirty(io, joinedMeetingId, latestLogId);
      respond({ ok: true });

      // Persist immediately — agenda advancement is a high-value event
      meetingManager.syncOne(joinedMeetingId).catch((err) => {
        logError('meeting_sync_failed', {
          meetingId: joinedMeetingId,
          trigger: 'agenda_advanced',
          error: serialiseError(err),
        });
      });
    });

    // --- disconnect ---
    socket.on('disconnect', (reason) => {
      info('socket_disconnected', {
        socketId: socket.id,
        ...attributionFields(user),
        reason,
        ...(joinedMeetingId ? { meetingId: joinedMeetingId } : {}),
      });

      // Remove any queue entries this socket left in the initial-editing
      // state. Without this, an author who closes their tab mid-compose
      // would strand a typing-indicator on every participant's screen
      // forever. This mirrors the Escape/Cancel path (delete the entry).
      // Race guards: skip ids whose entry is already gone or no longer
      // pending (e.g. the author finalised via a queue:edit from this or
      // another tab before the disconnect was processed).
      if (joinedMeetingId && pendingEntryIds.size > 0) {
        for (const entryId of pendingEntryIds) {
          const current = meetingManager.getQueueEntry(joinedMeetingId, entryId);
          if (!current || !current.pending) continue;
          if (meetingManager.removeQueueEntry(joinedMeetingId, entryId)) {
            emitDelta(io, meetingManager, joinedMeetingId, 'queue:removed', {
              id: entryId,
            });
          }
        }
        pendingEntryIds.clear();
      }

      if (joinedMeetingId) {
        decrementClientCount(io, joinedMeetingId, meetingManager);
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
  const next = current + 1;
  meetingClientCounts.set(meetingId, next);

  // Update the persisted last-connection timestamp so the expiry sweep
  // knows when the meeting was last active, and bump the persisted
  // max-concurrent high-water mark if this connection sets a new record.
  // maxConcurrent isn't currently surfaced in the UI but continues to
  // accumulate so it's available if we decide to expose it again later.
  const meeting = meetingManager.get(meetingId);
  if (meeting) {
    meeting.operational.lastConnectionTime = new Date().toISOString();
    if (meeting.operational.maxConcurrent < next) {
      meeting.operational.maxConcurrent = next;
    }
    meetingManager.markDirty(meetingId);
  }

  broadcastActiveConnections(io, meetingId);
}

/** Decrement the count of connected clients for a meeting. */
function decrementClientCount(
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  meetingId: string,
  meetingManager: MeetingManager,
): void {
  const current = meetingClientCounts.get(meetingId) ?? 0;
  const next = Math.max(0, current - 1);

  if (next === 0) {
    meetingClientCounts.delete(meetingId);
    // The room is now empty — stamp the last-connection timestamp so the
    // admin dashboard can display when activity ended and the expiry sweep
    // restarts its 90-day window from this moment.
    const meeting = meetingManager.get(meetingId);
    if (meeting) {
      meeting.operational.lastConnectionTime = new Date().toISOString();
      meetingManager.markDirty(meetingId);
    }
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
