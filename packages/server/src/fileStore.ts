import { readFile, writeFile, readdir, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { MeetingState } from '@tcq/shared';
import type { MeetingStore } from './store.js';

/**
 * Filesystem-backed meeting store for local development.
 *
 * Each meeting is stored as a JSON file in the configured directory
 * (e.g. `.data/meetings/bright-pine.json`). This makes meeting state
 * easy to inspect during development.
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
        if (!file.endsWith('.json')) continue;
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
    try {
      await unlink(filePath);
    } catch (err: unknown) {
      // Ignore if file doesn't exist
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw err;
    }
  }
}
