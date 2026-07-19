import { describe, it, expect } from 'vitest';
import type { AgendaEntry } from '@tcq/shared';
import { MeetingManager } from './meetings.js';
import { githubUser } from './auth/githubUser.js';
import { InMemoryStore } from './test/inMemoryStore.js';
import { buildSessionSlotStates, findSessionSlotForDuration, applyUrlImport } from './slotImportedItems.js';

const testUser = githubUser({ id: 1, login: 'chair', name: 'Chair', organisation: '' });

function session(id: string, capacity: number): AgendaEntry {
  return { kind: 'session', id, name: id, capacity };
}

function item(id: string, duration?: number): AgendaEntry {
  return { kind: 'item', id, name: id, presenterIds: [], duration };
}

describe('buildSessionSlotStates', () => {
  it('tracks remaining capacity after existing items in a session run', () => {
    const slots = buildSessionSlotStates([session('s1', 60), item('a', 40)]);
    expect(slots).toHaveLength(1);
    expect(slots[0].remaining).toBe(20);
    expect(slots[0].insertAfterId).toBe('a');
  });
});

describe('findSessionSlotForDuration', () => {
  it('returns the first session with enough remaining capacity', () => {
    const slots = buildSessionSlotStates([session('s1', 30), item('a', 25), session('s2', 60)]);
    expect(findSessionSlotForDuration(slots, 20)?.sessionId).toBe('s2');
    expect(findSessionSlotForDuration(slots, 5)?.sessionId).toBe('s1');
  });
});

describe('applyUrlImport', () => {
  it('slots imported items into sessions without reordering existing entries', () => {
    const manager = new MeetingManager(new InMemoryStore());
    const meeting = manager.create([testUser]);
    manager.addSession(meeting.id, 'Morning', 60);
    manager.addAgendaItem(meeting.id, 'Existing', [testUser], 40);
    manager.addSession(meeting.id, 'Afternoon', 30);

    applyUrlImport(
      manager,
      meeting.id,
      [
        { name: 'Fits morning', presenters: [], duration: 15 },
        { name: 'Fits afternoon', presenters: [], duration: 10 },
        { name: 'Too big for afternoon', presenters: [], duration: 35 },
      ],
      new Map(),
      true,
    );

    const stored = manager.get(meeting.id)!;
    expect(stored.agenda.map((entry) => `${entry.kind}:${entry.name}`)).toEqual([
      'session:Morning',
      'item:Existing',
      'item:Fits morning',
      'session:Afternoon',
      'item:Fits afternoon',
      'item:Too big for afternoon',
    ]);
  });

  it('appends imported items to the tail when slotIntoSessions is false', () => {
    const manager = new MeetingManager(new InMemoryStore());
    const meeting = manager.create([testUser]);
    manager.addSession(meeting.id, 'Morning', 60);
    manager.addAgendaItem(meeting.id, 'Existing', [testUser], 40);
    manager.addSession(meeting.id, 'Afternoon', 30);

    applyUrlImport(
      manager,
      meeting.id,
      [
        { name: 'Imported first', presenters: [], duration: 15 },
        { name: 'Imported second', presenters: [], duration: 10 },
      ],
      new Map(),
      false,
    );

    const stored = manager.get(meeting.id)!;
    expect(stored.agenda.map((entry) => `${entry.kind}:${entry.name}`)).toEqual([
      'session:Morning',
      'item:Existing',
      'session:Afternoon',
      'item:Imported first',
      'item:Imported second',
    ]);
  });
});
