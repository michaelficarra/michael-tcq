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

  // -- Agenda mutations --

  describe('addAgendaItem', () => {
    it('adds an item to the agenda', () => {
      const meeting = manager.create([testUser]);
      const item = manager.addAgendaItem(meeting.id, 'Item One', testUser, 20);

      expect(item).not.toBeNull();
      expect(item!.name).toBe('Item One');
      expect(item!.owner).toEqual(testUser);
      expect(item!.timebox).toBe(20);
      expect(meeting.agenda).toHaveLength(1);
      expect(meeting.agenda[0].id).toBe(item!.id);
    });

    it('adds items in order', () => {
      const meeting = manager.create([testUser]);
      manager.addAgendaItem(meeting.id, 'First', testUser);
      manager.addAgendaItem(meeting.id, 'Second', testUser);

      expect(meeting.agenda[0].name).toBe('First');
      expect(meeting.agenda[1].name).toBe('Second');
    });

    it('returns null for non-existent meeting', () => {
      const item = manager.addAgendaItem('no-such-meeting', 'Item', testUser);
      expect(item).toBeNull();
    });

    it('assigns a unique ID to each item', () => {
      const meeting = manager.create([testUser]);
      const item1 = manager.addAgendaItem(meeting.id, 'A', testUser);
      const item2 = manager.addAgendaItem(meeting.id, 'B', testUser);
      expect(item1!.id).not.toBe(item2!.id);
    });

    it('allows omitting timebox', () => {
      const meeting = manager.create([testUser]);
      const item = manager.addAgendaItem(meeting.id, 'No timebox', testUser);
      expect(item!.timebox).toBeUndefined();
    });
  });

  describe('deleteAgendaItem', () => {
    it('removes an item from the agenda', () => {
      const meeting = manager.create([testUser]);
      const item = manager.addAgendaItem(meeting.id, 'To delete', testUser)!;

      const deleted = manager.deleteAgendaItem(meeting.id, item.id);
      expect(deleted).toBe(true);
      expect(meeting.agenda).toHaveLength(0);
    });

    it('returns false for non-existent item', () => {
      const meeting = manager.create([testUser]);
      expect(manager.deleteAgendaItem(meeting.id, 'no-such-id')).toBe(false);
    });

    it('returns false for non-existent meeting', () => {
      expect(manager.deleteAgendaItem('no-such-meeting', 'any-id')).toBe(false);
    });

    it('preserves other items when deleting one', () => {
      const meeting = manager.create([testUser]);
      manager.addAgendaItem(meeting.id, 'Keep', testUser);
      const toDelete = manager.addAgendaItem(meeting.id, 'Delete', testUser)!;
      manager.addAgendaItem(meeting.id, 'Also keep', testUser);

      manager.deleteAgendaItem(meeting.id, toDelete.id);
      expect(meeting.agenda).toHaveLength(2);
      expect(meeting.agenda[0].name).toBe('Keep');
      expect(meeting.agenda[1].name).toBe('Also keep');
    });
  });

  describe('reorderAgendaItem', () => {
    it('moves an item to the beginning when afterId is null', () => {
      const meeting = manager.create([testUser]);
      const a = manager.addAgendaItem(meeting.id, 'A', testUser)!;
      manager.addAgendaItem(meeting.id, 'B', testUser);
      const c = manager.addAgendaItem(meeting.id, 'C', testUser)!;

      // Move C to the beginning
      const result = manager.reorderAgendaItem(meeting.id, c.id, null);
      expect(result).toBe(true);
      expect(meeting.agenda.map((i) => i.name)).toEqual(['C', 'A', 'B']);
    });

    it('moves an item after another item', () => {
      const meeting = manager.create([testUser]);
      const a = manager.addAgendaItem(meeting.id, 'A', testUser)!;
      const b = manager.addAgendaItem(meeting.id, 'B', testUser)!;
      const c = manager.addAgendaItem(meeting.id, 'C', testUser)!;

      // Move A to after C (i.e. to the end)
      const result = manager.reorderAgendaItem(meeting.id, a.id, c.id);
      expect(result).toBe(true);
      expect(meeting.agenda.map((i) => i.name)).toEqual(['B', 'C', 'A']);
    });

    it('moves an item to the middle', () => {
      const meeting = manager.create([testUser]);
      const a = manager.addAgendaItem(meeting.id, 'A', testUser)!;
      const b = manager.addAgendaItem(meeting.id, 'B', testUser)!;
      const c = manager.addAgendaItem(meeting.id, 'C', testUser)!;

      // Move C after A (between A and B)
      const result = manager.reorderAgendaItem(meeting.id, c.id, a.id);
      expect(result).toBe(true);
      expect(meeting.agenda.map((i) => i.name)).toEqual(['A', 'C', 'B']);
    });

    it('returns false for non-existent item', () => {
      const meeting = manager.create([testUser]);
      manager.addAgendaItem(meeting.id, 'A', testUser);
      expect(manager.reorderAgendaItem(meeting.id, 'no-such-id', null)).toBe(false);
    });

    it('returns false for non-existent afterId', () => {
      const meeting = manager.create([testUser]);
      const a = manager.addAgendaItem(meeting.id, 'A', testUser)!;
      expect(manager.reorderAgendaItem(meeting.id, a.id, 'no-such-id')).toBe(false);
      // Item should be back in its original position
      expect(meeting.agenda[0].id).toBe(a.id);
    });

    it('returns false for non-existent meeting', () => {
      expect(manager.reorderAgendaItem('no-such-meeting', 'any', null)).toBe(false);
    });
  });

  // -- Meeting flow --

  describe('nextAgendaItem', () => {
    it('starts the meeting by setting the first agenda item', () => {
      const meeting = manager.create([testUser]);
      manager.addAgendaItem(meeting.id, 'First', testUser);
      manager.addAgendaItem(meeting.id, 'Second', testUser);

      const result = manager.nextAgendaItem(meeting.id);
      expect(result).not.toBeNull();
      expect(result!.name).toBe('First');
      expect(meeting.currentAgendaItem?.name).toBe('First');
    });

    it('sets the item owner as the current speaker', () => {
      const meeting = manager.create([testUser]);
      manager.addAgendaItem(meeting.id, 'Proposal', otherUser);

      manager.nextAgendaItem(meeting.id);

      expect(meeting.currentSpeaker).toBeDefined();
      expect(meeting.currentSpeaker!.user.ghid).toBe(otherUser.ghid);
      expect(meeting.currentSpeaker!.topic).toBe('Introducing: Proposal');
      expect(meeting.currentSpeaker!.type).toBe('topic');
    });

    it('advances to the next agenda item', () => {
      const meeting = manager.create([testUser]);
      manager.addAgendaItem(meeting.id, 'First', testUser);
      manager.addAgendaItem(meeting.id, 'Second', otherUser);

      // Start meeting (first item)
      manager.nextAgendaItem(meeting.id);
      expect(meeting.currentAgendaItem?.name).toBe('First');

      // Advance to second item
      const result = manager.nextAgendaItem(meeting.id);
      expect(result?.name).toBe('Second');
      expect(meeting.currentAgendaItem?.name).toBe('Second');
      expect(meeting.currentSpeaker!.user.ghid).toBe(otherUser.ghid);
    });

    it('returns null when advancing past the last item', () => {
      const meeting = manager.create([testUser]);
      manager.addAgendaItem(meeting.id, 'Only item', testUser);

      manager.nextAgendaItem(meeting.id); // first
      const result = manager.nextAgendaItem(meeting.id); // past the end
      expect(result).toBeNull();
    });

    it('returns null for an empty agenda', () => {
      const meeting = manager.create([testUser]);
      expect(manager.nextAgendaItem(meeting.id)).toBeNull();
    });

    it('returns null for non-existent meeting', () => {
      expect(manager.nextAgendaItem('no-such-meeting')).toBeNull();
    });

    it('clears the queue and current topic when advancing', () => {
      const meeting = manager.create([testUser]);
      manager.addAgendaItem(meeting.id, 'First', testUser);
      manager.addAgendaItem(meeting.id, 'Second', testUser);

      // Start, then simulate some queue state
      manager.nextAgendaItem(meeting.id);
      meeting.queuedSpeakers = [{
        id: 'q1', type: 'topic', topic: 'old topic',
        user: otherUser,
      }];
      meeting.currentTopic = {
        id: 'ct1', type: 'topic', topic: 'old topic',
        user: otherUser,
      };

      // Advance — queue and topic should be cleared
      manager.nextAgendaItem(meeting.id);
      expect(meeting.queuedSpeakers).toHaveLength(0);
      expect(meeting.currentTopic).toBeUndefined();
    });
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
