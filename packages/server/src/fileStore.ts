import { readFile, writeFile, readdir, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { LogEntry, MeetingState } from '@tcq/shared';
import type { MeetingStore } from './store.js';

/**
 * Filesystem-backed meeting store for local development.
 *
 * Each meeting is stored as a JSON file in the configured directory
 * (e.g. `.data/meetings/bright-pine.json`). Each meeting's log is
 * stored alongside it as `bright-pine.log.json` — a separate file so
 * the realtime meeting state stays small and log appends don't have to
 * rewrite the whole meeting document. This makes meeting state easy to
 * inspect during development.
 */
export class FileMeetingStore implements MeetingStore {
  private dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  /** Ensure the storage directory exists. */
  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  async save(meeting: MeetingState): Promise<void> {
    const filePath = join(this.dir, `${meeting.id}.json`);
    await writeFile(filePath, JSON.stringify(meeting, null, 2), 'utf-8');
  }

  async load(meetingId: string): Promise<MeetingState | null> {
    const filePath = join(this.dir, `${meetingId}.json`);
    try {
      const data = await readFile(filePath, 'utf-8');
      return JSON.parse(data) as MeetingState;
    } catch (err: unknown) {
      // File doesn't exist — not an error, just no meeting found
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }

  async loadAll(): Promise<MeetingState[]> {
    try {
      const files = await readdir(this.dir);
      const meetings: MeetingState[] = [];

      for (const file of files) {
        // Only main meeting documents — skip the parallel `.log.json`
        // files (which are loaded by `loadAllLogs`).
        if (!file.endsWith('.json')) continue;
        if (file.endsWith('.log.json')) continue;
        const data = await readFile(join(this.dir, file), 'utf-8');
        meetings.push(JSON.parse(data) as MeetingState);
      }

      return meetings;
    } catch (err: unknown) {
      // Directory doesn't exist yet — no meetings to load
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw err;
    }
  }

  async remove(meetingId: string): Promise<void> {
    const filePath = join(this.dir, `${meetingId}.json`);
    const logPath = join(this.dir, `${meetingId}.log.json`);
    for (const path of [filePath, logPath]) {
      try {
        await unlink(path);
      } catch (err: unknown) {
        // Ignore if file doesn't exist
        if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          continue;
        }
        throw err;
      }
    }
  }

  async appendLog(meetingId: string, entry: LogEntry): Promise<void> {
    // Read-modify-write the whole log file. Acceptable for local dev
    // where meetings have at most a few hundred entries; production
    // uses Firestore subcollection writes which are O(1) per append.
    const existing = await this.loadLog(meetingId);
    existing.push(entry);
    const logPath = join(this.dir, `${meetingId}.log.json`);
    await writeFile(logPath, JSON.stringify(existing, null, 2), 'utf-8');
  }

  async loadLog(meetingId: string): Promise<LogEntry[]> {
    const logPath = join(this.dir, `${meetingId}.log.json`);
    try {
      const data = await readFile(logPath, 'utf-8');
      return JSON.parse(data) as LogEntry[];
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw err;
    }
  }

  async loadAllLogs(): Promise<Map<string, LogEntry[]>> {
    const logs = new Map<string, LogEntry[]>();
    try {
      const files = await readdir(this.dir);
      for (const file of files) {
        if (!file.endsWith('.log.json')) continue;
        const meetingId = file.slice(0, -'.log.json'.length);
        const data = await readFile(join(this.dir, file), 'utf-8');
        logs.set(meetingId, JSON.parse(data) as LogEntry[]);
      }
      return logs;
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        return logs;
      }
      throw err;
    }
  }
}
