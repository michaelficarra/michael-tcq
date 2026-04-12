import { describe, it, expect, beforeEach } from 'vitest';
import type { MeetingState } from '@tcq/shared';
import type { MeetingStore } from './store.js';
import { MeetingManager } from './meetings.js';

/** A no-op in-memory store for unit tests. */
class InMemoryStore implements MeetingStore {
  private data = new Map<string, MeetingState>();

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
  }
}

const testUser = {
  ghid: 1,
  ghUsername: 'alice',
  name: 'Alice',
  organisation: 'Test Org',
};

const otherUser = {
  ghid: 2,
  ghUsername: 'bob',
  name: 'Bob',
  organisation: 'Other Org',
};

describe('MeetingManager', () => {
  let manager: MeetingManager;

  beforeEach(() => {
    manager = new MeetingManager(new InMemoryStore());
  });

  it('creates a meeting with a valid ID and empty state', () => {
    const meeting = manager.create([testUser]);

    expect(meeting.id).toMatch(/^[a-z]+(-[a-z]+)+$/);
    expect(meeting.chairs).toEqual([testUser]);
    expect(meeting.agenda).toEqual([]);
    expect(meeting.queuedSpeakers).toEqual([]);
    expect(meeting.currentAgendaItem).toBeUndefined();
    expect(meeting.currentSpeaker).toBeUndefined();
    expect(meeting.trackTemperature).toBe(false);
  });

  it('get returns the created meeting', () => {
    const meeting = manager.create([testUser]);
    const retrieved = manager.get(meeting.id);
    expect(retrieved).toBe(meeting); // same reference (in-memory)
  });

  it('get returns undefined for unknown ID', () => {
    expect(manager.get('no-such-meeting')).toBeUndefined();
  });

  it('has returns true for existing meeting, false otherwise', () => {
    const meeting = manager.create([testUser]);
    expect(manager.has(meeting.id)).toBe(true);
    expect(manager.has('no-such-meeting')).toBe(false);
  });

  it('remove deletes a meeting', async () => {
    const meeting = manager.create([testUser]);
    await manager.remove(meeting.id);
    expect(manager.has(meeting.id)).toBe(false);
  });

  it('isChair returns true for chairs, false for others', () => {
    const meeting = manager.create([testUser]);
    expect(manager.isChair(meeting.id, testUser)).toBe(true);
    expect(manager.isChair(meeting.id, otherUser)).toBe(false);
  });

  it('isChair returns false for non-existent meeting', () => {
    expect(manager.isChair('no-such-meeting', testUser)).toBe(false);
  });

  it('sync writes dirty meetings to the store', async () => {
    const store = new InMemoryStore();
    const mgr = new MeetingManager(store);
    const meeting = mgr.create([testUser]);

    // Meeting is dirty after creation
    await mgr.sync();

    // Should now be in the store
    const loaded = await store.load(meeting.id);
    expect(loaded).toBeDefined();
    expect(loaded!.id).toBe(meeting.id);
  });

  it('restore recovers meetings from the store', async () => {
    const store = new InMemoryStore();

    // Save a meeting directly to the store
    await store.save({
      id: 'test-meeting',
      chairs: [testUser],
      agenda: [],
      currentAgendaItem: undefined,
      currentSpeaker: undefined,
      currentTopic: undefined,
      queuedSpeakers: [],
      reactions: [],
      trackTemperature: false,
    });

    // Create a new manager and restore from the store
    const mgr = new MeetingManager(store);
    await mgr.restore();

    expect(mgr.has('test-meeting')).toBe(true);
    expect(mgr.get('test-meeting')?.chairs).toEqual([testUser]);
  });

  it('creates meetings with unique IDs', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const meeting = manager.create([testUser]);
      ids.add(meeting.id);
    }
    // All 50 should be unique
    expect(ids.size).toBe(50);
  });
});
