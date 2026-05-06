import type { LogEntry, MeetingState } from '@tcq/shared';
import type { MeetingStore } from '../store.js';

/**
 * No-op in-memory implementation of MeetingStore for unit tests.
 * `save` clones the input so tests can mutate the live state without
 * the persisted "snapshot" mutating with it.
 */
export class InMemoryStore implements MeetingStore {
  private data = new Map<string, MeetingState>();
  private logs = new Map<string, LogEntry[]>();

  async save(meeting: MeetingState): Promise<void> {
    this.data.set(meeting.id, structuredClone(meeting));
  }
  async load(meetingId: string): Promise<MeetingState | null> {
    return this.data.get(meetingId) ?? null;
  }
  async loadAll(): Promise<MeetingState[]> {
    return [...this.data.values()];
  }
  async remove(meetingId: string): Promise<void> {
    this.data.delete(meetingId);
    this.logs.delete(meetingId);
  }
  async appendLog(meetingId: string, entry: LogEntry): Promise<void> {
    const existing = this.logs.get(meetingId) ?? [];
    existing.push(entry);
    this.logs.set(meetingId, existing);
  }
  async loadLog(meetingId: string): Promise<LogEntry[]> {
    return [...(this.logs.get(meetingId) ?? [])];
  }
  async loadAllLogs(): Promise<Map<string, LogEntry[]>> {
    return new Map([...this.logs.entries()].map(([k, v]) => [k, [...v]]));
  }
}
