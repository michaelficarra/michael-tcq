import type { MeetingState } from './types.js';

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
}
