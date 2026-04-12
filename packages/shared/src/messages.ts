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

/** Payload for adding a queue entry. */
export interface QueueAddPayload {
  type: QueueEntryType;
  topic: string;
}

/** Payload for removing a queue entry. */
export interface QueueRemovePayload {
  id: string;
}

/**
 * Payload for advancing to the next speaker.
 * Includes the current topic ID to prevent double-advancement from
 * concurrent chair actions. A single speaker can have multiple topics
 * in a row, so tracking the topic (which changes on each advancement
 * of a topic-type entry) is the correct staleness check.
 */
export interface QueueNextPayload {
  currentTopicId: string | null;
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
   */
  'meeting:nextAgendaItem': () => void;

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
   * Advance to the next speaker. Chair only. Pops the first entry from
   * the queue and makes that person the current speaker. If the entry
   * type is "topic", it also becomes the current topic. If the queue is
   * empty, clears the current speaker.
   *
   * The `currentTopicId` field is the UUID of the topic the client
   * believes is current. The server rejects the request if this doesn't
   * match, preventing double-advancement from concurrent clicks. The
   * topic (not the speaker) is used because a single speaker can have
   * multiple topics in a row.
   */
  'queue:next': (payload: QueueNextPayload) => void;
}
