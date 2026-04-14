import { describe, it, expect, beforeEach } from 'vitest';
import type { MeetingState } from '@tcq/shared';
import { userKey } from '@tcq/shared';
import type { MeetingStore } from './store.js';
import { MeetingManager, ensureUser } from './meetings.js';

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
    expect(meeting.chairIds).toEqual([userKey(testUser)]);
    expect(meeting.users[userKey(testUser)]).toEqual(testUser);
    expect(meeting.agenda).toEqual([]);
    expect(meeting.queuedSpeakerIds).toEqual([]);
    expect(meeting.currentAgendaItemId).toBeUndefined();
    expect(meeting.currentSpeakerEntryId).toBeUndefined();
    expect(meeting.trackPoll).toBe(false);
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
    const testUserKey = userKey(testUser);
    await store.save({
      id: 'test-meeting',
      users: { [testUserKey]: testUser },
      chairIds: [testUserKey],
      agenda: [],
      currentAgendaItemId: undefined,
      currentSpeakerEntryId: undefined,
      currentTopicEntryId: undefined,
      queueEntries: {},
      queuedSpeakerIds: [],
      reactions: [],
      trackPoll: false, pollOptions: [], version: 0,
      log: [], currentTopicSpeakers: [],
    });

    // Create a new manager and restore from the store
    const mgr = new MeetingManager(store);
    await mgr.restore();

    expect(mgr.has('test-meeting')).toBe(true);
    expect(mgr.get('test-meeting')?.chairIds).toEqual([testUserKey]);
  });

  // -- Agenda mutations --

  describe('addAgendaItem', () => {
    it('adds an item to the agenda', () => {
      const meeting = manager.create([testUser]);
      const item = manager.addAgendaItem(meeting.id, 'Item One', testUser, 20);

      expect(item).not.toBeNull();
      expect(item!.name).toBe('Item One');
      expect(meeting.users[item!.ownerId]).toEqual(testUser);
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

  describe('editAgendaItem', () => {
    it('updates the name', () => {
      const meeting = manager.create([testUser]);
      const item = manager.addAgendaItem(meeting.id, 'Old name', testUser)!;

      const result = manager.editAgendaItem(meeting.id, item.id, { name: 'New name' });
      expect(result).toBe(true);
      expect(meeting.agenda[0].name).toBe('New name');
    });

    it('updates the owner', () => {
      const meeting = manager.create([testUser]);
      const item = manager.addAgendaItem(meeting.id, 'Item', testUser)!;

      manager.editAgendaItem(meeting.id, item.id, { owner: otherUser });
      expect(meeting.users[meeting.agenda[0].ownerId]).toEqual(otherUser);
    });

    it('updates the timebox', () => {
      const meeting = manager.create([testUser]);
      const item = manager.addAgendaItem(meeting.id, 'Item', testUser, 10)!;

      manager.editAgendaItem(meeting.id, item.id, { timebox: 30 });
      expect(meeting.agenda[0].timebox).toBe(30);
    });

    it('clears the timebox when set to null', () => {
      const meeting = manager.create([testUser]);
      const item = manager.addAgendaItem(meeting.id, 'Item', testUser, 10)!;

      manager.editAgendaItem(meeting.id, item.id, { timebox: null });
      expect(meeting.agenda[0].timebox).toBeUndefined();
    });

    it('leaves unchanged fields alone', () => {
      const meeting = manager.create([testUser]);
      const item = manager.addAgendaItem(meeting.id, 'Keep me', testUser, 15)!;

      manager.editAgendaItem(meeting.id, item.id, { name: 'Changed' });
      expect(meeting.agenda[0].name).toBe('Changed');
      expect(meeting.users[meeting.agenda[0].ownerId]).toEqual(testUser);
      expect(meeting.agenda[0].timebox).toBe(15);
    });

    it('reflects edits to the current agenda item via the agenda array', () => {
      const meeting = manager.create([testUser]);
      manager.addAgendaItem(meeting.id, 'Current', testUser);
      manager.nextAgendaItem(meeting.id);

      const itemId = meeting.currentAgendaItemId!;
      manager.editAgendaItem(meeting.id, itemId, { name: 'Updated' });
      const currentItem = meeting.agenda.find((i) => i.id === meeting.currentAgendaItemId);
      expect(currentItem!.name).toBe('Updated');
    });

    it('returns false for non-existent item', () => {
      const meeting = manager.create([testUser]);
      expect(manager.editAgendaItem(meeting.id, 'no-such-id', { name: 'X' })).toBe(false);
    });

    it('returns false for non-existent meeting', () => {
      expect(manager.editAgendaItem('no-such-meeting', 'any', { name: 'X' })).toBe(false);
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

    it('clears currentAgendaItemId when the current item is deleted', () => {
      const meeting = manager.create([testUser]);
      manager.addAgendaItem(meeting.id, 'First', testUser);
      manager.addAgendaItem(meeting.id, 'Second', testUser);
      manager.nextAgendaItem(meeting.id);
      expect(meeting.currentAgendaItemId).toBeDefined();

      manager.deleteAgendaItem(meeting.id, meeting.currentAgendaItemId!);
      expect(meeting.currentAgendaItemId).toBeUndefined();
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
      manager.addAgendaItem(meeting.id, 'A', testUser);
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
      manager.addAgendaItem(meeting.id, 'B', testUser);
      const c = manager.addAgendaItem(meeting.id, 'C', testUser)!;

      // Move A to after C (i.e. to the end)
      const result = manager.reorderAgendaItem(meeting.id, a.id, c.id);
      expect(result).toBe(true);
      expect(meeting.agenda.map((i) => i.name)).toEqual(['B', 'C', 'A']);
    });

    it('moves an item to the middle', () => {
      const meeting = manager.create([testUser]);
      const a = manager.addAgendaItem(meeting.id, 'A', testUser)!;
      manager.addAgendaItem(meeting.id, 'B', testUser);
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
      expect(meeting.agenda.find((i) => i.id === meeting.currentAgendaItemId)?.name).toBe('First');
    });

    it('sets the item owner as the current speaker', () => {
      const meeting = manager.create([testUser]);
      manager.addAgendaItem(meeting.id, 'Proposal', otherUser);

      manager.nextAgendaItem(meeting.id);

      expect(meeting.currentSpeakerEntryId).toBeDefined();
      const currentEntry = meeting.queueEntries[meeting.currentSpeakerEntryId!];
      expect(meeting.users[currentEntry.userId].ghid).toBe(otherUser.ghid);
      expect(currentEntry.topic).toBe('Introducing: Proposal');
      expect(currentEntry.type).toBe('topic');
    });

    it('advances to the next agenda item', () => {
      const meeting = manager.create([testUser]);
      manager.addAgendaItem(meeting.id, 'First', testUser);
      manager.addAgendaItem(meeting.id, 'Second', otherUser);

      // Start meeting (first item)
      manager.nextAgendaItem(meeting.id);
      expect(meeting.agenda.find((i) => i.id === meeting.currentAgendaItemId)?.name).toBe('First');

      // Advance to second item
      const result = manager.nextAgendaItem(meeting.id);
      expect(result?.name).toBe('Second');
      expect(meeting.agenda.find((i) => i.id === meeting.currentAgendaItemId)?.name).toBe('Second');
      const currentEntry = meeting.queueEntries[meeting.currentSpeakerEntryId!];
      expect(meeting.users[currentEntry.userId].ghid).toBe(otherUser.ghid);
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
      const otherKey = ensureUser(meeting, otherUser);
      const q1Entry = { id: 'q1', type: 'topic' as const, topic: 'old topic', userId: otherKey };
      meeting.queueEntries['q1'] = q1Entry;
      meeting.queuedSpeakerIds = ['q1'];
      const ct1Entry = { id: 'ct1', type: 'topic' as const, topic: 'old topic', userId: otherKey };
      meeting.queueEntries['ct1'] = ct1Entry;
      meeting.currentTopicEntryId = 'ct1';

      // Advance — queue and topic should be cleared
      manager.nextAgendaItem(meeting.id);
      expect(meeting.queuedSpeakerIds).toHaveLength(0);
      expect(meeting.currentTopicEntryId).toBeUndefined();
    });
  });

  // -- Queue mutations --

  describe('addQueueEntry', () => {
    it('adds an entry to an empty queue', () => {
      const meeting = manager.create([testUser]);
      const entry = manager.addQueueEntry(meeting.id, 'topic', 'My topic', otherUser);

      expect(entry).not.toBeNull();
      expect(entry!.type).toBe('topic');
      expect(entry!.topic).toBe('My topic');
      expect(meeting.users[entry!.userId]).toEqual(otherUser);
      expect(meeting.queuedSpeakerIds).toHaveLength(1);
    });

    it('inserts entries in priority order (point-of-order first)', () => {
      const meeting = manager.create([testUser]);

      manager.addQueueEntry(meeting.id, 'topic', 'Low priority', otherUser);
      manager.addQueueEntry(meeting.id, 'point-of-order', 'Urgent', testUser);

      expect(meeting.queueEntries[meeting.queuedSpeakerIds[0]].type).toBe('point-of-order');
      expect(meeting.queueEntries[meeting.queuedSpeakerIds[1]].type).toBe('topic');
    });

    it('maintains FIFO within the same type', () => {
      const meeting = manager.create([testUser]);

      manager.addQueueEntry(meeting.id, 'topic', 'First topic', testUser);
      manager.addQueueEntry(meeting.id, 'topic', 'Second topic', otherUser);

      expect(meeting.queueEntries[meeting.queuedSpeakerIds[0]].topic).toBe('First topic');
      expect(meeting.queueEntries[meeting.queuedSpeakerIds[1]].topic).toBe('Second topic');
    });

    it('respects full priority ordering', () => {
      const meeting = manager.create([testUser]);

      // Add in reverse priority order
      manager.addQueueEntry(meeting.id, 'topic', 'D', testUser);
      manager.addQueueEntry(meeting.id, 'reply', 'C', testUser);
      manager.addQueueEntry(meeting.id, 'question', 'B', testUser);
      manager.addQueueEntry(meeting.id, 'point-of-order', 'A', testUser);

      const types = meeting.queuedSpeakerIds.map((id) => meeting.queueEntries[id].type);
      expect(types).toEqual(['point-of-order', 'question', 'reply', 'topic']);
    });

    it('inserts between existing types correctly', () => {
      const meeting = manager.create([testUser]);

      manager.addQueueEntry(meeting.id, 'point-of-order', 'First', testUser);
      manager.addQueueEntry(meeting.id, 'topic', 'Last', testUser);
      // Question should go between point-of-order and topic
      manager.addQueueEntry(meeting.id, 'question', 'Middle', otherUser);

      const types = meeting.queuedSpeakerIds.map((id) => meeting.queueEntries[id].type);
      expect(types).toEqual(['point-of-order', 'question', 'topic']);
    });

    it('returns null for non-existent meeting', () => {
      expect(manager.addQueueEntry('no-such-meeting', 'topic', 'X', testUser)).toBeNull();
    });
  });

  describe('editQueueEntry', () => {
    it('updates the topic', () => {
      const meeting = manager.create([testUser]);
      const entry = manager.addQueueEntry(meeting.id, 'topic', 'Old topic', testUser)!;

      const result = manager.editQueueEntry(meeting.id, entry.id, { topic: 'New topic' });
      expect(result).toBe(true);
      expect(meeting.queueEntries[meeting.queuedSpeakerIds[0]].topic).toBe('New topic');
    });

    it('updates the type', () => {
      const meeting = manager.create([testUser]);
      const entry = manager.addQueueEntry(meeting.id, 'topic', 'My topic', testUser)!;

      manager.editQueueEntry(meeting.id, entry.id, { type: 'question' });
      expect(meeting.queueEntries[meeting.queuedSpeakerIds[0]].type).toBe('question');
    });

    it('leaves unchanged fields alone', () => {
      const meeting = manager.create([testUser]);
      const entry = manager.addQueueEntry(meeting.id, 'topic', 'Keep me', testUser)!;

      manager.editQueueEntry(meeting.id, entry.id, { type: 'question' });
      expect(meeting.queueEntries[meeting.queuedSpeakerIds[0]].topic).toBe('Keep me');
      expect(meeting.queueEntries[meeting.queuedSpeakerIds[0]].type).toBe('question');
    });

    it('returns false for non-existent entry', () => {
      const meeting = manager.create([testUser]);
      expect(manager.editQueueEntry(meeting.id, 'no-such-id', { topic: 'X' })).toBe(false);
    });

    it('returns false for non-existent meeting', () => {
      expect(manager.editQueueEntry('no-such-meeting', 'any', { topic: 'X' })).toBe(false);
    });
  });

  describe('removeQueueEntry', () => {
    it('removes an entry from the queue', () => {
      const meeting = manager.create([testUser]);
      const entry = manager.addQueueEntry(meeting.id, 'topic', 'Remove me', testUser)!;

      expect(manager.removeQueueEntry(meeting.id, entry.id)).toBe(true);
      expect(meeting.queuedSpeakerIds).toHaveLength(0);
    });

    it('preserves other entries when removing one', () => {
      const meeting = manager.create([testUser]);
      manager.addQueueEntry(meeting.id, 'topic', 'Keep', testUser);
      const toRemove = manager.addQueueEntry(meeting.id, 'topic', 'Remove', otherUser)!;
      manager.addQueueEntry(meeting.id, 'topic', 'Also keep', testUser);

      manager.removeQueueEntry(meeting.id, toRemove.id);
      expect(meeting.queuedSpeakerIds).toHaveLength(2);
      expect(meeting.queueEntries[meeting.queuedSpeakerIds[0]].topic).toBe('Keep');
      expect(meeting.queueEntries[meeting.queuedSpeakerIds[1]].topic).toBe('Also keep');
    });

    it('returns false for non-existent entry', () => {
      const meeting = manager.create([testUser]);
      expect(manager.removeQueueEntry(meeting.id, 'no-such-id')).toBe(false);
    });

    it('returns false for non-existent meeting', () => {
      expect(manager.removeQueueEntry('no-such-meeting', 'any')).toBe(false);
    });
  });

  describe('getQueueEntry', () => {
    it('finds an entry by ID', () => {
      const meeting = manager.create([testUser]);
      const entry = manager.addQueueEntry(meeting.id, 'topic', 'Find me', testUser)!;

      expect(manager.getQueueEntry(meeting.id, entry.id)).toBe(entry);
    });

    it('returns undefined for non-existent entry', () => {
      const meeting = manager.create([testUser]);
      expect(manager.getQueueEntry(meeting.id, 'no-such-id')).toBeUndefined();
    });
  });

  describe('nextSpeaker', () => {
    it('pops the first entry and makes them the current speaker', () => {
      const meeting = manager.create([testUser]);
      manager.addQueueEntry(meeting.id, 'topic', 'First', testUser);
      manager.addQueueEntry(meeting.id, 'topic', 'Second', otherUser);

      const speaker = manager.nextSpeaker(meeting.id);

      expect(speaker).not.toBeNull();
      expect(speaker!.topic).toBe('First');
      expect(meeting.queueEntries[meeting.currentSpeakerEntryId!]?.topic).toBe('First');
      expect(meeting.queuedSpeakerIds).toHaveLength(1);
      expect(meeting.queueEntries[meeting.queuedSpeakerIds[0]].topic).toBe('Second');
    });

    it('sets currentTopic when the entry type is "topic"', () => {
      const meeting = manager.create([testUser]);
      manager.addQueueEntry(meeting.id, 'topic', 'New discussion', testUser);

      manager.nextSpeaker(meeting.id);

      expect(meeting.queueEntries[meeting.currentTopicEntryId!]?.topic).toBe('New discussion');
    });

    it('does not change currentTopic for non-topic types', () => {
      const meeting = manager.create([testUser]);

      // Set an existing topic
      const testUserKey = ensureUser(meeting, testUser);
      const oldTopicEntry = { id: 'old', type: 'topic' as const, topic: 'Previous topic', userId: testUserKey };
      meeting.queueEntries['old'] = oldTopicEntry;
      meeting.currentTopicEntryId = 'old';

      manager.addQueueEntry(meeting.id, 'question', 'A question', otherUser);
      manager.nextSpeaker(meeting.id);

      // currentTopic should remain unchanged
      expect(meeting.queueEntries[meeting.currentTopicEntryId!]?.topic).toBe('Previous topic');
    });

    it('clears the current speaker when queue is empty', () => {
      const meeting = manager.create([testUser]);
      const testUserKey = ensureUser(meeting, testUser);
      const oldEntry = { id: 'old', type: 'topic' as const, topic: 'Done', userId: testUserKey };
      meeting.queueEntries['old'] = oldEntry;
      meeting.currentSpeakerEntryId = 'old';

      const result = manager.nextSpeaker(meeting.id);

      expect(result).toBeNull();
      expect(meeting.currentSpeakerEntryId).toBeUndefined();
    });

    it('returns null for non-existent meeting', () => {
      expect(manager.nextSpeaker('no-such-meeting')).toBeNull();
    });
  });

  describe('reorderQueueEntry', () => {
    it('moves an entry to the beginning when afterId is null', () => {
      const meeting = manager.create([testUser]);
      manager.addQueueEntry(meeting.id, 'topic', 'A', testUser);
      manager.addQueueEntry(meeting.id, 'topic', 'B', testUser);
      const c = manager.addQueueEntry(meeting.id, 'topic', 'C', testUser)!;

      // Move C to the beginning
      const result = manager.reorderQueueEntry(meeting.id, c.id, null);
      expect(result).toBe(true);
      expect(meeting.queuedSpeakerIds.map((id) => meeting.queueEntries[id].topic)).toEqual(['C', 'A', 'B']);
    });

    it('moves an entry after another entry', () => {
      const meeting = manager.create([testUser]);
      const a = manager.addQueueEntry(meeting.id, 'topic', 'A', testUser)!;
      manager.addQueueEntry(meeting.id, 'topic', 'B', testUser);
      const c = manager.addQueueEntry(meeting.id, 'topic', 'C', testUser)!;

      // Move A to after C (to the end)
      const result = manager.reorderQueueEntry(meeting.id, a.id, c.id);
      expect(result).toBe(true);
      expect(meeting.queuedSpeakerIds.map((id) => meeting.queueEntries[id].topic)).toEqual(['B', 'C', 'A']);
    });

    // -- Type changes based on direction --

    it('moving down: adopts the lowest priority of items above', () => {
      const meeting = manager.create([testUser]);
      // Queue: POO, Question, Topic
      const poo = manager.addQueueEntry(meeting.id, 'point-of-order', 'POO', testUser)!;
      manager.addQueueEntry(meeting.id, 'question', 'Q', testUser);
      const t = manager.addQueueEntry(meeting.id, 'topic', 'T', testUser)!;

      // Move POO after Topic (to the end, moving down)
      // Items above new position: Q, T — lowest priority is T (topic)
      manager.reorderQueueEntry(meeting.id, poo.id, t.id);

      expect(meeting.queuedSpeakerIds[2]).toBe(poo.id);
      expect(meeting.queueEntries[meeting.queuedSpeakerIds[2]].type).toBe('topic');
    });

    it('moving down: adopts type of the single item above', () => {
      const meeting = manager.create([testUser]);
      // Queue: POO, Question
      const poo = manager.addQueueEntry(meeting.id, 'point-of-order', 'POO', testUser)!;
      const q = manager.addQueueEntry(meeting.id, 'question', 'Q', testUser)!;

      // Move POO after Question (moving down)
      // Items above: Q — lowest priority is question
      manager.reorderQueueEntry(meeting.id, poo.id, q.id);

      expect(meeting.queuedSpeakerIds[1]).toBe(poo.id);
      expect(meeting.queueEntries[meeting.queuedSpeakerIds[1]].type).toBe('question');
    });

    it('moving up: adopts the highest priority of items below', () => {
      const meeting = manager.create([testUser]);
      // Queue: POO, Question, Topic
      manager.addQueueEntry(meeting.id, 'point-of-order', 'POO', testUser);
      manager.addQueueEntry(meeting.id, 'question', 'Q', testUser);
      const t = manager.addQueueEntry(meeting.id, 'topic', 'T', testUser)!;

      // Move Topic to the beginning (moving up)
      // Items below new position: POO, Q — highest priority is POO (point-of-order)
      manager.reorderQueueEntry(meeting.id, t.id, null);

      expect(meeting.queuedSpeakerIds[0]).toBe(t.id);
      expect(meeting.queueEntries[meeting.queuedSpeakerIds[0]].type).toBe('point-of-order');
    });

    it('moving up: adopts type of the single item below', () => {
      const meeting = manager.create([testUser]);
      // Queue: Question, Topic
      manager.addQueueEntry(meeting.id, 'question', 'Q', testUser);
      const t = manager.addQueueEntry(meeting.id, 'topic', 'T', testUser)!;

      // Move Topic before Question (moving up)
      // Items below: Q — highest priority is question
      manager.reorderQueueEntry(meeting.id, t.id, null);

      expect(meeting.queuedSpeakerIds[0]).toBe(t.id);
      expect(meeting.queueEntries[meeting.queuedSpeakerIds[0]].type).toBe('question');
    });

    it('moving down past mixed types: adopts the lowest priority above', () => {
      const meeting = manager.create([testUser]);
      // Build a manually out-of-order queue: POO, Topic, Question
      // (can't use addQueueEntry since it auto-sorts by priority)
      const testUserKey = ensureUser(meeting, testUser);
      meeting.queueEntries['poo'] = { id: 'poo', type: 'point-of-order', topic: 'POO', userId: testUserKey };
      meeting.queueEntries['t'] = { id: 't', type: 'topic', topic: 'T', userId: testUserKey };
      meeting.queueEntries['q'] = { id: 'q', type: 'question', topic: 'Q', userId: testUserKey };
      meeting.queuedSpeakerIds = ['poo', 't', 'q'];

      // Move POO after Q (to the end, moving down)
      // Items above: T, Q — lowest priority is T (topic, priority 3)
      manager.reorderQueueEntry(meeting.id, 'poo', 'q');

      expect(meeting.queuedSpeakerIds[2]).toBe('poo');
      expect(meeting.queueEntries[meeting.queuedSpeakerIds[2]].type).toBe('topic');
    });

    it('moving up past mixed types: adopts the highest priority at or below', () => {
      const meeting = manager.create([testUser]);
      // Build a manually out-of-order queue: Question, Topic, POO
      const testUserKey = ensureUser(meeting, testUser);
      meeting.queueEntries['q'] = { id: 'q', type: 'question', topic: 'Q', userId: testUserKey };
      meeting.queueEntries['t'] = { id: 't', type: 'topic', topic: 'T', userId: testUserKey };
      meeting.queueEntries['poo'] = { id: 'poo', type: 'point-of-order', topic: 'POO', userId: testUserKey };
      meeting.queuedSpeakerIds = ['q', 't', 'poo'];

      // Move POO to the beginning (moving up)
      // Items at and below index 0 (including POO itself): POO, Q, T
      // Highest priority is POO itself (point-of-order, priority 0)
      manager.reorderQueueEntry(meeting.id, 'poo', null);

      expect(meeting.queuedSpeakerIds[0]).toBe('poo');
      expect(meeting.queueEntries[meeting.queuedSpeakerIds[0]].type).toBe('point-of-order');
    });

    it('moving up: topic moving above questions becomes question', () => {
      const meeting = manager.create([testUser]);
      // Queue: Question, Topic (auto-sorted by addQueueEntry)
      manager.addQueueEntry(meeting.id, 'question', 'Q', testUser);
      const t = manager.addQueueEntry(meeting.id, 'topic', 'T', testUser)!;

      // Move Topic to the beginning (moving up)
      // Items at and below index 0 (including T itself): T, Q
      // Highest priority is Q (question, priority 1)
      manager.reorderQueueEntry(meeting.id, t.id, null);

      expect(meeting.queuedSpeakerIds[0]).toBe(t.id);
      expect(meeting.queueEntries[meeting.queuedSpeakerIds[0]].type).toBe('question');
    });

    it('moving down: includes itself in the "above" set', () => {
      const meeting = manager.create([testUser]);
      // Queue: Topic, Question — topic has lower priority than question
      const t = manager.addQueueEntry(meeting.id, 'topic', 'T', testUser)!;
      // addQueueEntry sorts by priority, so question goes before topic
      const q = manager.addQueueEntry(meeting.id, 'question', 'Q', testUser)!;
      // Actual queue: [Q, T]

      // Move Q after T (moving down)
      // Items at and above (including Q itself): Q, T — lowest priority is T (topic)
      // But wait, Q is being moved, so after removal and reinsertion:
      // Remove Q → [T], insert after T → [T, Q]
      // Items at and above index 1: [T, Q] — lowest priority is topic
      manager.reorderQueueEntry(meeting.id, q.id, t.id);

      expect(meeting.queuedSpeakerIds[1]).toBe(q.id);
      expect(meeting.queueEntries[meeting.queuedSpeakerIds[1]].type).toBe('topic');
    });

    it('moving up: includes itself in the "below" set', () => {
      const meeting = manager.create([testUser]);
      // Build queue: Question, Point-of-order (out of order)
      const testUserKey = ensureUser(meeting, testUser);
      meeting.queueEntries['q'] = { id: 'q', type: 'question', topic: 'Q', userId: testUserKey };
      meeting.queueEntries['poo'] = { id: 'poo', type: 'point-of-order', topic: 'POO', userId: testUserKey };
      meeting.queuedSpeakerIds = ['q', 'poo'];

      // Move POO to beginning (moving up)
      // Items at and below index 0: [POO, Q]
      // POO's own type (point-of-order, priority 0) is the highest priority
      manager.reorderQueueEntry(meeting.id, 'poo', null);

      expect(meeting.queuedSpeakerIds[0]).toBe('poo');
      expect(meeting.queueEntries[meeting.queuedSpeakerIds[0]].type).toBe('point-of-order');
    });

    it('keeps original type when entry is alone in the queue', () => {
      const meeting = manager.create([testUser]);
      const entry = manager.addQueueEntry(meeting.id, 'question', 'Solo', testUser)!;

      // Moving the only entry to the beginning is a no-op but should succeed
      const result = manager.reorderQueueEntry(meeting.id, entry.id, null);
      expect(result).toBe(true);
      expect(meeting.queueEntries[meeting.queuedSpeakerIds[0]].type).toBe('question');
    });

    it('returns false for non-existent entry', () => {
      const meeting = manager.create([testUser]);
      manager.addQueueEntry(meeting.id, 'topic', 'A', testUser);
      expect(manager.reorderQueueEntry(meeting.id, 'no-such-id', null)).toBe(false);
    });

    it('returns false for non-existent afterId', () => {
      const meeting = manager.create([testUser]);
      const a = manager.addQueueEntry(meeting.id, 'topic', 'A', testUser)!;
      expect(manager.reorderQueueEntry(meeting.id, a.id, 'no-such-id')).toBe(false);
      // Entry should be back in its original position
      expect(meeting.queuedSpeakerIds[0]).toBe(a.id);
    });

    it('returns false for non-existent meeting', () => {
      expect(manager.reorderQueueEntry('no-such-meeting', 'any', null)).toBe(false);
    });
  });

  // -- Poll mutations --

  /** Helper: options for poll tests. */
  const samplePollOptions = [
    { emoji: '❤️', label: 'Love' },
    { emoji: '👍', label: 'Like' },
    { emoji: '👀', label: 'Watching' },
  ];

  describe('startPoll', () => {
    it('enables poll with custom options', () => {
      const meeting = manager.create([testUser]);

      const result = manager.startPoll(meeting.id, samplePollOptions);
      expect(result).toBe(true);
      expect(meeting.trackPoll).toBe(true);
      expect(meeting.pollOptions).toHaveLength(3);
      expect(meeting.pollOptions[0].emoji).toBe('❤️');
      expect(meeting.pollOptions[0].label).toBe('Love');
      // Each option gets a unique ID
      expect(meeting.pollOptions[0].id).toBeDefined();
      expect(meeting.pollOptions[0].id).not.toBe(meeting.pollOptions[1].id);
    });

    it('clears existing reactions when starting', () => {
      const meeting = manager.create([testUser]);
      meeting.reactions = [{ optionId: 'old', userId: userKey(testUser) }];

      manager.startPoll(meeting.id, samplePollOptions);
      expect(meeting.reactions).toHaveLength(0);
    });

    it('returns false for non-existent meeting', () => {
      expect(manager.startPoll('no-such-meeting', samplePollOptions)).toBe(false);
    });
  });

  describe('stopPoll', () => {
    it('disables poll and clears reactions and options', () => {
      const meeting = manager.create([testUser]);
      manager.startPoll(meeting.id, samplePollOptions);
      meeting.reactions = [{ optionId: meeting.pollOptions[0].id, userId: userKey(testUser) }];

      const result = manager.stopPoll(meeting.id);
      expect(result).toBe(true);
      expect(meeting.trackPoll).toBe(false);
      expect(meeting.pollOptions).toHaveLength(0);
      expect(meeting.reactions).toHaveLength(0);
    });

    it('returns false for non-existent meeting', () => {
      expect(manager.stopPoll('no-such-meeting')).toBe(false);
    });
  });

  describe('toggleReaction', () => {
    it('adds a reaction when the user has not reacted to this option', () => {
      const meeting = manager.create([testUser]);
      manager.startPoll(meeting.id, samplePollOptions);
      const optionId = meeting.pollOptions[0].id;

      const result = manager.toggleReaction(meeting.id, optionId, testUser);
      expect(result).toBe(true);
      expect(meeting.reactions).toHaveLength(1);
      expect(meeting.reactions[0].optionId).toBe(optionId);
      expect(meeting.users[meeting.reactions[0].userId].ghUsername).toBe('alice');
    });

    it('removes a reaction when the user already has it (toggle off)', () => {
      const meeting = manager.create([testUser]);
      manager.startPoll(meeting.id, samplePollOptions);
      const optionId = meeting.pollOptions[0].id;

      manager.toggleReaction(meeting.id, optionId, testUser);
      manager.toggleReaction(meeting.id, optionId, testUser);
      expect(meeting.reactions).toHaveLength(0);
    });

    it('allows multiple different options from the same user', () => {
      const meeting = manager.create([testUser]);
      manager.startPoll(meeting.id, samplePollOptions);

      manager.toggleReaction(meeting.id, meeting.pollOptions[0].id, testUser);
      manager.toggleReaction(meeting.id, meeting.pollOptions[1].id, testUser);
      expect(meeting.reactions).toHaveLength(2);
    });

    it('allows different users to react to the same option', () => {
      const meeting = manager.create([testUser]);
      manager.startPoll(meeting.id, samplePollOptions);
      const optionId = meeting.pollOptions[0].id;

      manager.toggleReaction(meeting.id, optionId, testUser);
      manager.toggleReaction(meeting.id, optionId, otherUser);
      expect(meeting.reactions).toHaveLength(2);
    });

    it('returns false when poll is not active', () => {
      const meeting = manager.create([testUser]);
      expect(manager.toggleReaction(meeting.id, 'any-id', testUser)).toBe(false);
    });

    it('returns false for an invalid option ID', () => {
      const meeting = manager.create([testUser]);
      manager.startPoll(meeting.id, samplePollOptions);
      expect(manager.toggleReaction(meeting.id, 'invalid-option', testUser)).toBe(false);
    });

    it('returns false for non-existent meeting', () => {
      expect(manager.toggleReaction('no-such-meeting', 'any', testUser)).toBe(false);
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
