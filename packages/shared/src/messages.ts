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
import { normaliseGithubUsername, canonicalUserRef } from './helpers.js';
import {
  sanitiseBlockMarkdown,
  sanitiseInlineMarkdown,
  validateBlockMarkdown,
  validateInlineMarkdown,
} from './markdown.js';
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

/**
 * Payload for `agenda:added` — new agenda item or session header.
 *
 * When the meeting is in the past-final state (the chair has advanced
 * past the last item, so `current.agendaItemId` is undefined while
 * `current.startedAt` is set), adding an agenda item auto-activates
 * it. In that case the server bundles the fresh `current` and reset
 * `queue` into this same delta — clients apply them atomically so they
 * never observe a torn state where the new item exists but isn't yet
 * current. `lastAdvancementBy` mirrors the same field on
 * `agenda:advanced` so the cooldown heuristic kicks in identically.
 * All three fields are absent for the normal "added but not activated"
 * case (which includes session headers, which never auto-activate).
 */
export type AgendaAddedDelta = DeltaEnvelope & {
  entry: AgendaEntry;
  current?: CurrentContext;
  queue?: MeetingQueueState;
  lastAdvancementBy?: UserKey;
};

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
 * Payload for `agenda:prologueSet` — full replacement of the agenda's
 * prologue markdown. `value` is the new string, or `undefined` when the
 * chair cleared the section. Mirrors `agenda:epilogueSet`.
 */
export type AgendaPrologueSetDelta = DeltaEnvelope & { value: string | undefined };

/** Payload for `agenda:epilogueSet` — same shape as `agenda:prologueSet`. */
export type AgendaEpilogueSetDelta = DeltaEnvelope & { value: string | undefined };

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
 * Non-empty trimmed string that must also parse as inline markdown using
 * only the supported subset (see `markdown.ts`). Used for fields whose
 * value is rendered back through `InlineMarkdown` on the client.
 *
 * The pipeline is: trim → require non-empty → sanitise (escape any
 * disallowed HTML / image / bad-URL link to its literal source) →
 * validate residual markdown-level issues. Sanitisation runs first so
 * the validator never sees HTML-shaped problems — those become visible
 * text, not save failures. The validator still surfaces a specific
 * reason — e.g. *"Headings are not supported"* — for the issues it
 * does catch (block constructs in inline context).
 */
const markdownString = (field: string, requiredMsg = `${field} is required`) =>
  z
    .string()
    .trim()
    .min(1, requiredMsg)
    .transform((val) => sanitiseInlineMarkdown(val))
    .superRefine((val, ctx) => {
      const r = validateInlineMarkdown(val);
      if (!r.ok) ctx.addIssue({ code: 'custom', message: `${field}: ${r.reason}` });
    });

/**
 * Optional markdown string used by edit-style payloads: when the field
 * is provided it must be non-empty AND valid markdown; when omitted the
 * existing value is left unchanged.
 */
const optionalMarkdownString = (field: string) =>
  z
    .string()
    .trim()
    .min(1, `${field} cannot be empty`)
    .transform((val) => sanitiseInlineMarkdown(val))
    .superRefine((val, ctx) => {
      const r = validateInlineMarkdown(val);
      if (!r.ok) ctx.addIssue({ code: 'custom', message: `${field}: ${r.reason}` });
    })
    .optional();

/**
 * Optional markdown string that also accepts the empty string as a way
 * to clear the value (used for `conclusion` and the poll `topic`).
 * Sanitisation + validation are skipped when empty. `.optional()` wraps
 * the whole transform chain so the property type stays optional in
 * inferred `z.object` shapes.
 */
const clearableMarkdownString = (field: string) =>
  z
    .string()
    .trim()
    .transform((val) => (val.length === 0 ? val : sanitiseInlineMarkdown(val)))
    .superRefine((val, ctx) => {
      if (val.length === 0) return;
      const r = validateInlineMarkdown(val);
      if (!r.ok) ctx.addIssue({ code: 'custom', message: `${field}: ${r.reason}` });
    })
    .optional();

/**
 * Optional *block* markdown string that also accepts the empty string
 * as a way to clear the value. Used for the agenda prologue/epilogue,
 * which support multi-paragraph + lists + headings + the rest of the
 * block allowlist (see `markdown.ts`). Sanitisation + validation are
 * skipped when empty; `.optional()` wraps the chain so the property
 * type stays optional.
 */
const clearableBlockMarkdownString = (field: string) =>
  z
    .string()
    .trim()
    .transform((val) => (val.length === 0 ? val : sanitiseBlockMarkdown(val)))
    .superRefine((val, ctx) => {
      if (val.length === 0) return;
      const r = validateBlockMarkdown(val);
      if (!r.ok) ctx.addIssue({ code: 'custom', message: `${field}: ${r.reason}` });
    })
    .optional();

/**
 * GitHub-username field: accepts an optional leading `@` and surrounding
 * whitespace, normalises to the bare username, then enforces non-empty.
 * The error `msg` surfaces in the UI when the field is empty after
 * normalisation (e.g. the user sent only whitespace or a bare `@`).
 */
const githubUsername = (msg = 'Username is required') =>
  z.string().transform(normaliseGithubUsername).pipe(z.string().min(1, msg));

/**
 * A user reference committed from a user selector (chair/presenter inputs).
 * Two shapes:
 *   - `{ provider, accountId }` — a concrete account picked from the
 *     provider directory. Identity only: the server re-resolves it to a
 *     full profile (via the provider), so we never trust client-supplied
 *     display fields or avatar URLs.
 *   - `{ handle }` — free text the user typed without picking a suggestion.
 *     The server resolves it via the searcher's provider's handle lookup
 *     (GitHub today), falling back to an unverified placeholder.
 */
export const UserSelectionSchema = z.union([
  z.object({
    provider: z.string().min(1).max(64),
    accountId: z.string().min(1).max(256),
  }),
  z.object({ handle: githubUsername() }),
]);
export type UserSelection = z.infer<typeof UserSelectionSchema>;

// -- Payloads for client-to-server events --

/** Payload for adding a new agenda item. */
export const AgendaAddPayloadSchema = z.object({
  name: markdownString('Agenda item name'),
  presenters: z.array(UserSelectionSchema),
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
  name: optionalMarkdownString('Agenda item name'),
  // Omitted = unchanged; an empty array explicitly clears the presenter list.
  presenters: z.array(UserSelectionSchema).optional(),
  duration: z.number().int().nullable().optional(),
});
export type AgendaEditPayload = z.infer<typeof AgendaEditPayloadSchema>;

/**
 * Payload for setting (or clearing) the agenda prologue (chair only).
 * Empty string clears the section — server normalises empty/whitespace
 * to "no prologue" and broadcasts the cleared state to all clients.
 */
export const AgendaSetProloguePayloadSchema = z.object({
  prologue: clearableBlockMarkdownString('Prologue'),
});
export type AgendaSetProloguePayload = z.infer<typeof AgendaSetProloguePayloadSchema>;

/** Payload for setting (or clearing) the agenda epilogue (chair only). */
export const AgendaSetEpiloguePayloadSchema = z.object({
  epilogue: clearableBlockMarkdownString('Epilogue'),
});
export type AgendaSetEpiloguePayload = z.infer<typeof AgendaSetEpiloguePayloadSchema>;

/**
 * Payload for adding a new session header (chair only). Sessions are
 * always appended to the end of the agenda; move them into position
 * via `agenda:reorder` afterwards.
 */
export const SessionAddPayloadSchema = z.object({
  name: markdownString('Session name'),
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
  name: optionalMarkdownString('Session name'),
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
  topic: optionalMarkdownString('Topic'),
  type: QueueEntryTypeSchema.optional(),
});
export type QueueEditPayload = z.infer<typeof QueueEditPayloadSchema>;

/** Payload for adding a queue entry. */
export const QueueAddPayloadSchema = z.object({
  type: QueueEntryTypeSchema,
  /**
   * The entry's topic. Optional: when omitted, the server uses the default
   * topic for the type (see `QUEUE_ENTRY_DEFAULT_TOPICS`). The interactive
   * add path leaves this off because the author hasn't typed anything yet;
   * the chair `asUsername` restore path passes it explicitly.
   */
  topic: optionalMarkdownString('Topic'),
  /**
   * When true, the entry is added in the "pending initial edit" state — its
   * topic is shown to all participants as a typing-indicator (bouncing dots)
   * until the author finalises via `queue:finalize`. Only honoured for the
   * interactive add path; ignored when `asUsername` is set (bulk restore
   * always produces finished entries).
   */
  pending: z.boolean().optional(),
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
  topic: clearableMarkdownString('Poll topic'),
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
  chairs: z.array(UserSelectionSchema),
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
  conclusion: clearableMarkdownString('Conclusion'),
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
  chairs: z.array(UserSelectionSchema).min(1, 'At least one chair is required'),
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

/**
 * An admin/premium user reference. Accepts either:
 *   - a bare GitHub handle (GitHub's login rules: 1–39 chars, alphanumeric
 *     or hyphen, no leading/trailing hyphen; a leading `@` is stripped), or
 *   - a provider-qualified id `provider:rest` (provider is `[a-z][a-z0-9-]*`;
 *     `rest` is a non-empty, whitespace-free account id — or, for `github:`,
 *     a handle).
 * Rejects obvious garbage at the API boundary; outputs the canonical form
 * (`canonicalUserRef`) stored and compared server-side.
 */
const userRef = z
  .string()
  .max(256)
  .superRefine((raw, ctx) => {
    const ref = canonicalUserRef(raw);
    if (ref === null) {
      ctx.addIssue({ code: 'custom', message: 'A username or provider:id is required' });
      return;
    }
    const colon = ref.indexOf(':');
    if (colon === -1) {
      if (ref.length > 39 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(ref)) {
        ctx.addIssue({ code: 'custom', message: 'Invalid GitHub username' });
      }
      return;
    }
    const provider = ref.slice(0, colon);
    const rest = ref.slice(colon + 1);
    if (!/^[a-z][a-z0-9-]*$/.test(provider)) ctx.addIssue({ code: 'custom', message: 'Invalid provider' });
    if (rest.length === 0 || /\s/.test(rest)) ctx.addIssue({ code: 'custom', message: 'Invalid account id' });
  })
  .transform((raw) => canonicalUserRef(raw) as string);

/**
 * POST /api/admin/premium-users — add a user to the premium tier list.
 * Admin only; idempotent (re-adding an existing entry is a no-op success).
 * Accepts a GitHub handle or a provider-qualified id (see `userRef`).
 */
export const PremiumUserBodySchema = z.object({
  username: userRef,
});
export type PremiumUserBody = z.infer<typeof PremiumUserBodySchema>;

/**
 * Shape of the responses from the admin premium-user endpoints. `usernames`
 * is sorted lexicographically over the canonical lowercased form so
 * clients can use referential/stringified equality for change detection.
 */
export interface PremiumUsersResponse {
  usernames: string[];
}

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
   * The Cloud Run revision (`K_REVISION`) this server process is running
   * under, sent once per socket on join. The client uses it as the
   * baseline for a periodic `/api/version` poll: if the polled revision
   * later differs from this one, the WebSocket is pinned to a drained
   * old revision (Cloud Run keeps the previous instance alive only to
   * serve in-flight requests, which includes the long-lived WebSocket),
   * and the page reloads to migrate to the new revision.
   *
   * Sourcing the baseline from the WebSocket — rather than from the
   * client's own first `/api/version` request — closes a race: an HTTP
   * request and the WebSocket handshake can land on different revisions
   * if a deploy straddles them, and the WebSocket revision is the
   * authoritative one because that's where the long-lived connection
   * actually lives.
   *
   * `revision` is `null` when the server isn't running on Cloud Run
   * (local dev, tests) — the client treats `null` as "no staleness
   * check applies".
   */
  'server:revision': (info: { revision: string | null }) => void;

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
  'agenda:prologueSet': (delta: AgendaPrologueSetDelta) => void;
  'agenda:epilogueSet': (delta: AgendaEpilogueSetDelta) => void;
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

  /**
   * Edit an existing queue entry (owner or chair). When the targeted
   * entry is in the "pending initial-edit" state, the server additionally
   * clears the `pending` flag — editing the topic constitutes finalising.
   */
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

  /**
   * Set (or clear, by sending an empty string) the agenda prologue —
   * free-form chair-authored markdown displayed above the agenda. Chair
   * only. The server normalises empty/whitespace-only input to "cleared"
   * and broadcasts an `agenda:prologueSet` delta with `value: undefined`.
   */
  'agenda:setPrologue': (payload: AgendaSetProloguePayload) => void;

  /** Set (or clear) the agenda epilogue. Same shape as `agenda:setPrologue`. */
  'agenda:setEpilogue': (payload: AgendaSetEpiloguePayload) => void;

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
