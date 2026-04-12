import type { MeetingState } from '@tcq/shared';

/**
 * Persistence interface for meeting state.
 *
 * The active implementation is selected by the STORE environment variable:
 * - "file" (default) — writes JSON files to disk, used for local development.
 * - "firestore" — reads/writes Firestore documents, used in production.
 */
export interface MeetingStore {
  /** Persist a meeting's current state. */
  save(meeting: MeetingState): Promise<void>;

  /** Load a single meeting by ID, or null if it doesn't exist. */
  load(meetingId: string): Promise<MeetingState | null>;

  /** Load all persisted meetings (used on server startup for recovery). */
  loadAll(): Promise<MeetingState[]>;

  /** Remove a meeting from the persistent store. */
  remove(meetingId: string): Promise<void>;
}
