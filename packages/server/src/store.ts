import type { LogEntry, MeetingState } from '@tcq/shared';

/**
 * Persistence interface for meeting state and per-meeting logs.
 *
 * The active implementation is selected by the STORE environment variable:
 * - "file" (default) — writes JSON files to disk, used for local development.
 * - "firestore" — reads/writes Firestore documents, used in production.
 *
 * The log is persisted alongside the meeting (same backing store) but as
 * a separate stream of entries, not as a field on the `MeetingState`
 * document. This keeps state broadcasts on the realtime channel small
 * and lets the log accumulate without bloating every wire payload.
 */
export interface MeetingStore {
  /** Persist a meeting's current state. */
  save(meeting: MeetingState): Promise<void>;

  /** Load a single meeting by ID, or null if it doesn't exist. */
  load(meetingId: string): Promise<MeetingState | null>;

  /** Load all persisted meetings (used on server startup for recovery). */
  loadAll(): Promise<MeetingState[]>;

  /**
   * Remove a meeting from the persistent store. Implementations must
   * also remove any persisted log entries for the meeting.
   */
  remove(meetingId: string): Promise<void>;

  /** Append a single log entry for a meeting. */
  appendLog(meetingId: string, entry: LogEntry): Promise<void>;

  /**
   * Load the full log for a meeting, in append order. Returns an empty
   * array if no entries are persisted.
   */
  loadLog(meetingId: string): Promise<LogEntry[]>;

  /**
   * Load logs for every persisted meeting (used on server startup for
   * recovery alongside `loadAll`). Returns a map keyed by meeting id.
   */
  loadAllLogs(): Promise<Map<string, LogEntry[]>>;
}
