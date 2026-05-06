/**
 * Wire payload schemas and event-shape types for the Socket.IO transport.
 *
 * Every client-to-server payload is described as a Zod schema so the server
 * can validate at the boundary with `Schema.safeParse(payload)` and the
 * TypeScript types are derived via `z.infer`. Authority checks (isChair,
 * isOwner) live in the handlers — they aren't shape validation.
 *
 * Keep the Zod messages user-facing: they're shown as-is in the UI when
 * the server emits an `error` event after a rejected parse.
 */

import { z } from 'zod';
import { normaliseGithubUsername } from './helpers.js';
import type {
  ActivePoll,
  AgendaEntry,
  AgendaItem,
  CurrentContext,
  MeetingQueueState,
  MeetingState,
  QueueEntry,
  Reaction,
  Session,
  User,
  UserKey,
} from './types.js';
import { QueueEntryTypeSchema } from './types.js';

/**
 * Common envelope for every typed state-mutation delta. The `version`
 * lets clients detect missed deltas (gap between expected and received)
 * and request a `state:resync`. The `users` slot piggy-backs newly-
 * introduced user records onto whatever delta first referenced them so
 * the client can render badges immediately without an extra fetch.
 */
interface DeltaEnvelope {
  version: number;
  users?: Record<UserKey, User>;
}

/** Payload for `chairs:updated` — chair list replaced wholesale. */
export type ChairsUpdatedDelta = DeltaEnvelope & { chairIds: UserKey[] };

/** Payload for `agenda:added` — new agenda item or session header. */
export type AgendaAddedDelta = DeltaEnvelope & { entry: AgendaEntry };

/**
 * Payload for `agenda:edited` — replacement entry for an existing
 * agenda position. Sending the whole entry (rather than a partial diff)
 * keeps the client reducer simple and the wire size is still small
 * (~100 B) since the data shape is shallow.
 */
export type AgendaEditedDelta = DeltaEnvelope & {
  id: string;
  entry: AgendaEntry;
};

/**
 * Payload for `agenda:deleted`. `currentCleared` is true when the
 * deleted entry was the meeting's current agenda item — the server
 * clears `current.agendaItemId` in that case and the client must too.
 */
export type AgendaDeletedDelta = DeltaEnvelope & { id: string; currentCleared: boolean };

/** Payload for `agenda:reordered` — full new ordering of agenda entry ids. */
export type AgendaReorderedDelta = DeltaEnvelope & { orderedIds: string[] };

/**
 * Payload for `queue:added`. `position` is the index into
 * `queue.orderedIds` where the entry was inserted (priority-corrected
 * by the server).
 */
export type QueueAddedDelta = DeltaEnvelope & { entry: QueueEntry; position: number };

/** Payload for `queue:edited` — replacement entry for an existing queue id. */
export type QueueEditedDelta = DeltaEnvelope & {
  id: string;
  entry: QueueEntry;
};

/** Payload for `queue:removed`. */
export type QueueRemovedDelta = DeltaEnvelope & { id: string };

/**
 * Payload for `queue:reordered`. `updatedEntries` carries any entries
 * whose `type` changed because the reorder crossed a priority boundary
 * (see `MeetingManager.reorderQueueEntry`).
 */
export type QueueReorderedDelta = DeltaEnvelope & {
  orderedIds: string[];
  updatedEntries?: Record<string, Partial<QueueEntry>>;
};

/** Payload for `queue:closedChanged`. */
export type QueueClosedChangedDelta = DeltaEnvelope & { closed: boolean };

/**
 * Payload for `speaker:advanced`. `current` and `queue` change together
 * (next-speaker pops the queue head and updates current), so they
 * travel as one delta to avoid the client observing a torn state.
 * `lastAdvancementBy` mirrors the same field on `OperationalState` —
 * it's per-event metadata clients use for cooldown heuristics, so we
 * carry it on the delta rather than persisting it.
 */
export type SpeakerAdvancedDelta = DeltaEnvelope & {
  current: CurrentContext;
  queue: MeetingQueueState;
  lastAdvancementBy: UserKey;
};

/**
 * Payload for `agenda:advanced`. Bundles every field the agenda-advance
 * handler mutates: a fresh `current`, a reset `queue`, and any
 * `agendaUpdates` (the outgoing item gets its realised duration and
 * conclusion written back). `log:dirty` fires alongside this for the
 * accompanying log-entry appends.
 */
export type AgendaAdvancedDelta = DeltaEnvelope & {
  current: CurrentContext;
  queue: MeetingQueueState;
  agendaUpdates?: Record<string, Partial<AgendaItem>>;
  lastAdvancementBy: UserKey;
};

/** Payload for `poll:started`. */
export type PollStartedDelta = DeltaEnvelope & { poll: ActivePoll };

/** Payload for `poll:stopped`. */
export type PollStoppedDelta = DeltaEnvelope;

/** Payload for `poll:reacted` — full updated reactions array. */
export type PollReactedDelta = DeltaEnvelope & { reactions: Reaction[] };

/** Non-empty trimmed string with a human-readable "required" message. */
const requiredTrimmed = (field: string) => z.string().trim().min(1, `${field} is required`);

/**
 * GitHub-username field: accepts an optional leading `@` and surrounding
 * whitespace, normalises to the bare username, then enforces non-empty.
 * The error `msg` surfaces in the UI when the field is empty after
 * normalisation (e.g. the user sent only whitespace or a bare `@`).
 */
const githubUsername = (msg = 'Username is required') =>
  z.string().transform(normaliseGithubUsername).pipe(z.string().min(1, msg));

// -- Payloads for client-to-server events --

/** Payload for adding a new agenda item. */
export const AgendaAddPayloadSchema = z.object({
  name: requiredTrimmed('Agenda item name'),
  presenterUsernames: z.array(githubUsername()).min(1, 'At least one presenter is required'),
  /** Estimated duration in minutes; omit or 0 for no estimate. */
  duration: z.number().int().positive().optional(),
});
export type AgendaAddPayload = z.infer<typeof AgendaAddPayloadSchema>;

/** Payload for deleting an agenda item. */
export const AgendaDeletePayloadSchema = z.object({
  id: z.string(),
});
export type AgendaDeletePayload = z.infer<typeof AgendaDeletePayloadSchema>;

/**
 * Payload for reordering an agenda item. The item identified by `id` is
 * moved to the position immediately after `afterId`. If `afterId` is null,
 * the item is moved to the beginning of the agenda.
 */
export const AgendaReorderPayloadSchema = z.object({
  id: z.string(),
  afterId: z.string().nullable(),
});
export type AgendaReorderPayload = z.infer<typeof AgendaReorderPayloadSchema>;

/**
 * Payload for editing an existing agenda item (chair only). All fields are
 * optional; omitted fields leave that attribute unchanged. `duration: null`
 * explicitly clears a previously-set duration.
 */
export const AgendaEditPayloadSchema = z.object({
  id: z.string(),
  name: z.string().trim().min(1, 'Agenda item name cannot be empty').optional(),
  presenterUsernames: z.array(githubUsername()).min(1, 'At least one presenter is required').optional(),
  duration: z.number().int().nullable().optional(),
});
export type AgendaEditPayload = z.infer<typeof AgendaEditPayloadSchema>;

/**
 * Payload for adding a new session header (chair only). Sessions are
 * always appended to the end of the agenda; move them into position
 * via `agenda:reorder` afterwards.
 */
export const SessionAddPayloadSchema = z.object({
  name: requiredTrimmed('Session name'),
  /** Capacity in minutes — positive integer. */
  capacity: z.number().int().positive(),
});
export type SessionAddPayload = z.infer<typeof SessionAddPayloadSchema>;

/**
 * Payload for editing an existing session header (chair only). All fields
 * are optional; omitted fields leave that attribute unchanged.
 */
export const SessionEditPayloadSchema = z.object({
  id: z.string(),
  name: z.string().trim().min(1, 'Session name cannot be empty').optional(),
  capacity: z.number().int().positive().optional(),
});
export type SessionEditPayload = z.infer<typeof SessionEditPayloadSchema>;

/** Payload for deleting a session header. */
export const SessionDeletePayloadSchema = z.object({
  id: z.string(),
});
export type SessionDeletePayload = z.infer<typeof SessionDeletePayloadSchema>;

/** Payload for editing an existing queue entry. */
export const QueueEditPayloadSchema = z.object({
  id: z.string(),
  topic: z.string().trim().min(1, 'Topic cannot be empty').optional(),
  type: QueueEntryTypeSchema.optional(),
});
export type QueueEditPayload = z.infer<typeof QueueEditPayloadSchema>;

/** Payload for adding a queue entry. */
export const QueueAddPayloadSchema = z.object({
  type: QueueEntryTypeSchema,
  topic: requiredTrimmed('Topic'),
  /**
   * Optional: GitHub username to add the entry as. Chair only. When omitted,
   * the entry is added as the current session user.
   */
  asUsername: githubUsername().optional(),
  /**
   * Precondition for `type: 'reply'` — the `speakerId` of the CurrentTopic
   * the client saw when the user initiated the reply. The server rejects the
   * add when this doesn't match the current topic's speakerId (i.e. the
   * chair advanced to a different topic, or the agenda moved on and cleared
   * the topic). `null` means the client saw no topic. Ignored for non-reply
   * types.
   */
  currentTopicSpeakerId: z.string().nullable().optional(),
});
export type QueueAddPayload = z.infer<typeof QueueAddPayloadSchema>;

/** Payload for removing a queue entry. */
export const QueueRemovePayloadSchema = z.object({
  id: z.string(),
});
export type QueueRemovePayload = z.infer<typeof QueueRemovePayloadSchema>;

/** Payload for opening or closing the queue to non-chair entries. */
export const QueueSetClosedPayloadSchema = z.object({
  closed: z.boolean(),
});
export type QueueSetClosedPayload = z.infer<typeof QueueSetClosedPayloadSchema>;

/**
 * Payload for reordering a queue entry. Chair (or self, downward-only) only.
 * When an entry crosses a type priority boundary the handler rewrites its
 * type to match its new neighbours.
 */
export const QueueReorderPayloadSchema = z.object({
  id: z.string(),
  afterId: z.string().nullable(),
});
export type QueueReorderPayload = z.infer<typeof QueueReorderPayloadSchema>;

/**
 * Payload for starting a poll with custom options. Each option has an emoji
 * and a human-readable label. The server assigns unique IDs. Minimum 2
 * options are required.
 */
export const PollStartPayloadSchema = z.object({
  topic: z.string().trim().optional(),
  multiSelect: z.boolean().optional(),
  options: z
    .array(
      z.object({
        emoji: requiredTrimmed('Each option must have an emoji and a label'),
        label: requiredTrimmed('Each option must have an emoji and a label'),
      }),
    )
    .min(2, 'At least 2 poll options are required'),
});
export type PollStartPayload = z.infer<typeof PollStartPayloadSchema>;

/**
 * Payload for toggling a poll reaction. References the option by its ID.
 * Each user can have at most one reaction per option; sending the same
 * option again removes it (toggle).
 */
export const PollReactPayloadSchema = z.object({
  optionId: z.string(),
});
export type PollReactPayload = z.infer<typeof PollReactPayloadSchema>;

/**
 * Payload for updating the list of meeting chairs. Chair/admin only. At
 * least one chair must remain (except when an admin performs the update).
 */
export const ChairsUpdatePayloadSchema = z.object({
  usernames: z.array(githubUsername()),
});
export type ChairsUpdatePayload = z.infer<typeof ChairsUpdatePayloadSchema>;

/**
 * Payload for advancing to the next speaker. Includes the CurrentSpeaker
 * id seen by the client as a precondition — the server rejects if another
 * chair already advanced (the current speaker changed).
 */
export const NextSpeakerPayloadSchema = z.object({
  currentSpeakerEntryId: z.string().nullable(),
});
export type NextSpeakerPayload = z.infer<typeof NextSpeakerPayloadSchema>;

/**
 * Payload for advancing to the next agenda item. Includes the current
 * agenda item id as a precondition — the server rejects if another chair
 * already advanced to a different agenda item.
 */
export const NextAgendaItemPayloadSchema = z.object({
  currentAgendaItemId: z.string().nullable(),
  /**
   * Conclusion text for the outgoing agenda item, captured from the
   * confirmation dialog. Empty string clears any previously stored
   * conclusion. Omitted when the meeting is being started (no outgoing
   * item) — the server ignores it in that case.
   */
  conclusion: z.string().optional(),
});
export type NextAgendaItemPayload = z.infer<typeof NextAgendaItemPayloadSchema>;

/**
 * Response sent back via Socket.IO acknowledgement callback for advancement
 * events. On success, `ok` is true. On rejection, `ok` is false with an
 * error message.
 */
export interface AdvanceResponse {
  ok: boolean;
  /** Error message — present when ok is false. */
  error?: string;
}

// -- REST payloads --

/** POST /api/meetings — create a new meeting. */
export const CreateMeetingBodySchema = z.object({
  chairs: z.array(githubUsername()).min(1, 'At least one chair username is required'),
});
export type CreateMeetingBody = z.infer<typeof CreateMeetingBodySchema>;

/** POST /api/dev/switch-user — switch the mock identity (dev mode only). */
export const SwitchUserBodySchema = z.object({
  username: githubUsername('Username is required'),
});
export type SwitchUserBody = z.infer<typeof SwitchUserBodySchema>;

/** POST /api/meetings/:id/import-agenda — import an agenda from a URL. */
export const ImportAgendaBodySchema = z.object({
  url: requiredTrimmed('URL'),
});
export type ImportAgendaBody = z.infer<typeof ImportAgendaBodySchema>;

// -- Event interfaces --

/** Events the server sends to connected clients. */
export interface ServerToClientEvents {
  /**
   * Full meeting state — sent on initial join, on automatic reconnect,
   * and in response to a client-initiated `state:resync` request. The
   * realtime mutation path uses the typed delta events further down
   * this interface; `state` is reserved for the resync codepath.
   */
  state: (state: MeetingState) => void;

  /** Error message — sent when a client action fails validation. */
  error: (message: string) => void;

  /**
   * Current socket-connection count for the meeting room. Sent to every
   * socket in the room after a join or disconnect. Counts socket
   * connections (not unique users), so multiple tabs from the same user
   * each contribute 1.
   */
  activeConnections: (count: number) => void;

  /**
   * Notification that the meeting log has new entries. Carries the id
   * of the latest entry so a client that has already fetched up to that
   * id can short-circuit. Emitted to every socket in the meeting room
   * each time `MeetingManager.appendLog` runs. The payload is tiny by
   * design — clients fetch the actual entries via
   * `GET /api/meetings/:id/log?since=<theirCursor>` so the realtime
   * channel never carries log bodies. This event is *not* part of the
   * versioned delta stream — it has its own cursor (the latest entry id)
   * and is independent of `MeetingState` versioning.
   */
  'log:dirty': (latestId: string) => void;

  // ---- Versioned state-mutation deltas ----
  // Each carries a per-meeting monotonic `version` (see
  // `OperationalState.version`). Clients drop deltas whose version is
  // not exactly `lastSeen + 1` and request `state:resync` on a gap.

  'chairs:updated': (delta: ChairsUpdatedDelta) => void;
  'agenda:added': (delta: AgendaAddedDelta) => void;
  'agenda:edited': (delta: AgendaEditedDelta) => void;
  'agenda:deleted': (delta: AgendaDeletedDelta) => void;
  'agenda:reordered': (delta: AgendaReorderedDelta) => void;
  'queue:added': (delta: QueueAddedDelta) => void;
  'queue:edited': (delta: QueueEditedDelta) => void;
  'queue:removed': (delta: QueueRemovedDelta) => void;
  'queue:reordered': (delta: QueueReorderedDelta) => void;
  'queue:closedChanged': (delta: QueueClosedChangedDelta) => void;
  'speaker:advanced': (delta: SpeakerAdvancedDelta) => void;
  'agenda:advanced': (delta: AgendaAdvancedDelta) => void;
  'poll:started': (delta: PollStartedDelta) => void;
  'poll:stopped': (delta: PollStoppedDelta) => void;
  'poll:reacted': (delta: PollReactedDelta) => void;
}

/** Events clients send to the server. */
export interface ClientToServerEvents {
  /** Join a meeting room by ID. */
  join: (meetingId: string) => void;

  /**
   * Request a full-state replay. Sent when a delta event arrives with a
   * `version` greater than `lastSeen + 1` — i.e. the client missed at
   * least one delta and needs to resync. The server responds by emitting
   * `state` with the current full `MeetingState` (including the latest
   * `operational.version`) to just the requesting socket.
   */
  'state:resync': () => void;

  /** Edit an existing agenda item (chair only). */
  'agenda:edit': (payload: AgendaEditPayload) => void;

  /** Update the list of meeting chairs. Chair only. At least one must remain. */
  'meeting:updateChairs': (payload: ChairsUpdatePayload) => void;

  /** Edit an existing queue entry (owner or chair). */
  'queue:edit': (payload: QueueEditPayload) => void;

  /** Add a new agenda item (chair only). */
  'agenda:add': (payload: AgendaAddPayload) => void;

  /** Delete an agenda item by ID (chair only). */
  'agenda:delete': (payload: AgendaDeletePayload) => void;

  /**
   * Reorder an agenda entry (item or session) to a new position (chair
   * only). Items and sessions share the same id-space and the same
   * reorder protocol.
   */
  'agenda:reorder': (payload: AgendaReorderPayload) => void;

  /** Add a new session header (chair only). Appended to the end of the agenda. */
  'session:add': (payload: SessionAddPayload) => void;

  /** Edit an existing session header (chair only). */
  'session:edit': (payload: SessionEditPayload) => void;

  /**
   * Delete a session header by ID (chair only). Does not delete the
   * agenda items that were visually contained within it.
   */
  'session:delete': (payload: SessionDeletePayload) => void;

  /**
   * Start the meeting by advancing to the first agenda item, or advance
   * to the next agenda item if the meeting is already in progress.
   * Chair only. The agenda item's first presenter becomes the current speaker.
   * Includes precondition (current agenda item ID) to prevent double-advancement.
   */
  'meeting:nextAgendaItem': (payload: NextAgendaItemPayload, ack: (response: AdvanceResponse) => void) => void;

  /**
   * Add the current user to the speaker queue. The entry is automatically
   * inserted at the correct position based on type priority. Any
   * authenticated user can do this. For `type: 'reply'`, the server uses
   * `currentTopicSpeakerId` as a precondition and rejects when the topic
   * has moved on — callers pass an ack to detect this.
   */
  'queue:add': (payload: QueueAddPayload, ack?: (response: AdvanceResponse) => void) => void;

  /**
   * Remove an entry from the speaker queue. A user can remove their own
   * entry; a chair can remove any entry.
   */
  'queue:remove': (payload: QueueRemovePayload) => void;

  /**
   * Reorder a queue entry to a new position. Chair only. When the entry
   * crosses a type priority boundary, its type changes to match its
   * neighbours at the new position.
   */
  'queue:reorder': (payload: QueueReorderPayload) => void;

  /**
   * Open or close the queue to new entries from non-chair users.
   * Chair only. When closed, only chairs can add queue entries.
   */
  'queue:setClosed': (payload: QueueSetClosedPayload) => void;

  /**
   * Advance to the next speaker. Chair only. Pops the first entry from
   * the queue and makes that person the current speaker. If the entry
   * type is "topic", it also becomes the current topic. If the queue is
   * empty, clears the current speaker.
   * Includes precondition (current speaker entry ID) to prevent double-advancement.
   */
  'queue:next': (payload: NextSpeakerPayload, ack: (response: AdvanceResponse) => void) => void;

  /**
   * Start a poll with custom options (chair only).
   * Clears any existing reactions. Minimum 2 options required.
   */
  'poll:start': (payload: PollStartPayload) => void;

  /** Stop a poll (chair only). Clears all reactions. */
  'poll:stop': () => void;

  /**
   * Toggle a reaction during an active poll. Any authenticated
   * user can react. Sending the same reaction again removes it.
   */
  'poll:react': (payload: PollReactPayload) => void;
}
