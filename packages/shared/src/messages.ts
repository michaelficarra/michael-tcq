import type { MeetingState, QueueEntryType } from './types.js';

// -- Payloads for client-to-server events --

/** Payload for adding a new agenda item. */
export interface AgendaAddPayload {
  name: string;
  ownerUsername: string;
  timebox?: number; // duration in minutes; omit or 0 for no timebox
}

/** Payload for deleting an agenda item. */
export interface AgendaDeletePayload {
  id: string;
}

/**
 * Payload for reordering an agenda item.
 *
 * Uses item UUIDs rather than indices to avoid race conditions when
 * two chairs reorder simultaneously. The item identified by `id` is
 * moved to the position immediately after `afterId`. If `afterId` is
 * null, the item is moved to the beginning of the agenda.
 */
export interface AgendaReorderPayload {
  id: string;
  afterId: string | null;
}

/** Payload for editing an existing agenda item (chair only). */
export interface AgendaEditPayload {
  id: string;
  name?: string;
  ownerUsername?: string;
  timebox?: number | null; // null to clear the timebox
}

/** Payload for editing an existing queue entry. */
export interface QueueEditPayload {
  id: string;
  topic?: string;
  type?: QueueEntryType;
}

/** Payload for adding a queue entry. */
export interface QueueAddPayload {
  type: QueueEntryType;
  topic: string;
  /**
   * Optional: GitHub username to add the entry as. Chair only.
   * When omitted, the entry is added as the current session user.
   */
  asUsername?: string;
}

/** Payload for removing a queue entry. */
export interface QueueRemovePayload {
  id: string;
}

/** Payload for opening or closing the queue to non-chair entries. */
export interface QueueSetClosedPayload {
  closed: boolean;
}

/**
 * Payload for reordering a queue entry. Chair only.
 *
 * Uses UUIDs rather than indices to avoid race conditions (same approach
 * as agenda reordering). The entry identified by `id` is moved to the
 * position immediately after `afterId`. If `afterId` is null, the entry
 * is moved to the beginning of the queue.
 *
 * When an entry crosses a type priority boundary, its type is changed
 * to match the entries at its new position. For example, moving a
 * "New Topic" above a "Clarifying Question" changes it to "Clarifying
 * Question".
 */
/**
 * Payload for starting a poll with custom options.
 * Each option has an emoji and a human-readable label. The server
 * assigns unique IDs. Minimum 2 options required.
 */
export interface PollStartPayload {
  /** Optional topic/question for the poll. */
  topic?: string;
  /** Whether participants can select multiple options. Defaults to true. */
  multiSelect?: boolean;
  options: { emoji: string; label: string }[];
}

/**
 * Payload for toggling a poll reaction.
 * References the option by its ID. Each user can have at most one
 * reaction per option. Sending the same option again removes it (toggle).
 */
export interface PollReactPayload {
  optionId: string;
}

export interface QueueReorderPayload {
  id: string;
  afterId: string | null;
}

/**
 * Payload for updating the list of meeting chairs. Chair only.
 * At least one chair must remain.
 */
export interface ChairsUpdatePayload {
  usernames: string[];
}

/**
 * Payload for advancing to the next speaker. Includes the queue entry
 * ID of the current speaker as a precondition — the server rejects if
 * another chair already advanced (i.e. the current speaker changed).
 * This prevents double-advancement without false rejections from
 * unrelated mutations (queue edits, reactions, etc.).
 */
export interface NextSpeakerPayload {
  /** The queue entry ID of the current speaker the client sees, or null if none. */
  currentSpeakerEntryId: string | null;
}

/**
 * Payload for advancing to the next agenda item. Includes the current
 * agenda item ID as a precondition — the server rejects if another
 * chair already advanced to a different agenda item.
 */
export interface NextAgendaItemPayload {
  /** The agenda item ID the client sees as current, or null if meeting hasn't started. */
  currentAgendaItemId: string | null;
}

/**
 * Response sent back via Socket.IO acknowledgement callback for
 * advancement events. On success, `ok` is true. On rejection
 * (conflicting advancement or error), `ok` is false with an error message.
 */
export interface AdvanceResponse {
  ok: boolean;
  /** Error message — present when ok is false. */
  error?: string;
}

// -- Event interfaces --

/** Events the server sends to connected clients. */
export interface ServerToClientEvents {
  /** Full meeting state — sent on join and after every mutation. */
  state: (state: MeetingState) => void;

  /** Error message — sent when a client action fails validation. */
  error: (message: string) => void;
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
   * Chair only. The agenda item's owner becomes the current speaker.
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
