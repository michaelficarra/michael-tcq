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
import type { MeetingState } from './types.js';
import { QueueEntryTypeSchema } from './types.js';

/** Non-empty trimmed string with a human-readable "required" message. */
const requiredTrimmed = (field: string) => z.string().trim().min(1, `${field} is required`);

// -- Payloads for client-to-server events --

/** Payload for adding a new agenda item. */
export const AgendaAddPayloadSchema = z.object({
  name: requiredTrimmed('Agenda item name'),
  presenterUsernames: z.array(z.string().trim().min(1)).min(1, 'At least one presenter is required'),
  /** Duration in minutes; omit or 0 for no timebox. */
  timebox: z.number().int().positive().optional(),
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
 * optional; omitted fields leave that attribute unchanged. `timebox: null`
 * explicitly clears a previously-set timebox.
 */
export const AgendaEditPayloadSchema = z.object({
  id: z.string(),
  name: z.string().trim().min(1, 'Agenda item name cannot be empty').optional(),
  presenterUsernames: z.array(z.string().trim().min(1)).min(1, 'At least one presenter is required').optional(),
  timebox: z.number().int().nullable().optional(),
});
export type AgendaEditPayload = z.infer<typeof AgendaEditPayloadSchema>;

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
  asUsername: z.string().trim().min(1).optional(),
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
  usernames: z.array(z.string().trim().min(1)),
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
  chairs: z.array(z.string().trim().min(1)).min(1, 'At least one chair username is required'),
});
export type CreateMeetingBody = z.infer<typeof CreateMeetingBodySchema>;

/** POST /api/dev/switch-user — switch the mock identity (dev mode only). */
export const SwitchUserBodySchema = z.object({
  username: requiredTrimmed('Username'),
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
  /** Full meeting state — sent on join and after every mutation. */
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
}

/** Events clients send to the server. */
export interface ClientToServerEvents {
  /** Join a meeting room by ID. */
  join: (meetingId: string) => void;

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

  /** Reorder an agenda item to a new position (chair only). */
  'agenda:reorder': (payload: AgendaReorderPayload) => void;

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
   * authenticated user can do this.
   */
  'queue:add': (payload: QueueAddPayload) => void;

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
