import { describe, it, expect } from 'vitest';
import type { MeetingState, User } from '@tcq/shared';
import { meetingReducer, type MeetingContextState } from './MeetingContext.js';

/** Create a minimal meeting state for testing. */
function makeMeeting(overrides?: Partial<MeetingState>): MeetingState {
  return {
    id: 'test-meeting',
    users: {},
    chairIds: [],
    agenda: [],
    currentAgendaItemId: undefined,
    currentSpeakerEntryId: undefined,
    currentTopicEntryId: undefined,
    queueEntries: {},
    queuedSpeakerIds: [],
    queueClosed: false,
    log: [],
    currentTopicSpeakers: [],
    ...overrides,
  };
}

function makeState(overrides?: Partial<MeetingContextState>): MeetingContextState {
  return {
    meeting: null,
    user: null,
    connected: false,
    error: null,
    ...overrides,
  };
}

const alice: User = { ghid: 1, ghUsername: 'alice', name: 'Alice', organisation: 'ACME' };

describe('meetingReducer', () => {
  // -- state --

  describe('state action', () => {
    it('replaces the meeting state', () => {
      const meeting = makeMeeting({ id: 'new-meeting' });
      const result = meetingReducer(makeState(), { type: 'state', meeting });
      expect(result.meeting).toBe(meeting);
    });

    it('clears any previous error', () => {
      const state = makeState({ error: 'something went wrong' });
      const meeting = makeMeeting();
      const result = meetingReducer(state, { type: 'state', meeting });
      expect(result.error).toBeNull();
    });
  });

  // -- setUser --

  describe('setUser action', () => {
    it('sets the user', () => {
      const result = meetingReducer(makeState(), { type: 'setUser', user: alice });
      expect(result.user).toBe(alice);
    });
  });

  // -- setConnected --

  describe('setConnected action', () => {
    it('sets connected to true', () => {
      const result = meetingReducer(makeState(), { type: 'setConnected', connected: true });
      expect(result.connected).toBe(true);
    });

    it('sets connected to false', () => {
      const state = makeState({ connected: true });
      const result = meetingReducer(state, { type: 'setConnected', connected: false });
      expect(result.connected).toBe(false);
    });
  });

  // -- setError --

  describe('setError action', () => {
    it('sets the error message', () => {
      const result = meetingReducer(makeState(), { type: 'setError', error: 'not found' });
      expect(result.error).toBe('not found');
    });
  });

  // -- optimisticAgendaReorder --

  describe('optimisticAgendaReorder action', () => {
    const agenda = [
      { id: 'a', name: 'First', ownerId: 'alice' },
      { id: 'b', name: 'Second', ownerId: 'alice' },
      { id: 'c', name: 'Third', ownerId: 'alice' },
    ];

    it('moves an item forward (down the list)', () => {
      const state = makeState({ meeting: makeMeeting({ agenda }) });
      const result = meetingReducer(state, {
        type: 'optimisticAgendaReorder',
        oldIndex: 0,
        newIndex: 2,
      });
      expect(result.meeting!.agenda.map((i) => i.id)).toEqual(['b', 'c', 'a']);
    });

    it('moves an item backward (up the list)', () => {
      const state = makeState({ meeting: makeMeeting({ agenda }) });
      const result = meetingReducer(state, {
        type: 'optimisticAgendaReorder',
        oldIndex: 2,
        newIndex: 0,
      });
      expect(result.meeting!.agenda.map((i) => i.id)).toEqual(['c', 'a', 'b']);
    });

    it('is a no-op when oldIndex equals newIndex', () => {
      const state = makeState({ meeting: makeMeeting({ agenda }) });
      const result = meetingReducer(state, {
        type: 'optimisticAgendaReorder',
        oldIndex: 1,
        newIndex: 1,
      });
      expect(result.meeting!.agenda.map((i) => i.id)).toEqual(['a', 'b', 'c']);
    });

    it('does not mutate the original state', () => {
      const state = makeState({ meeting: makeMeeting({ agenda }) });
      meetingReducer(state, {
        type: 'optimisticAgendaReorder',
        oldIndex: 0,
        newIndex: 2,
      });
      expect(state.meeting!.agenda.map((i) => i.id)).toEqual(['a', 'b', 'c']);
    });

    it('returns state unchanged when meeting is null', () => {
      const state = makeState({ meeting: null });
      const result = meetingReducer(state, {
        type: 'optimisticAgendaReorder',
        oldIndex: 0,
        newIndex: 1,
      });
      expect(result).toBe(state);
    });
  });

  // -- optimisticQueueReorder --

  describe('optimisticQueueReorder action', () => {
    const queuedSpeakerIds = ['x', 'y', 'z'];

    it('moves an entry forward (down the list)', () => {
      const state = makeState({ meeting: makeMeeting({ queuedSpeakerIds }) });
      const result = meetingReducer(state, {
        type: 'optimisticQueueReorder',
        oldIndex: 0,
        newIndex: 2,
      });
      expect(result.meeting!.queuedSpeakerIds).toEqual(['y', 'z', 'x']);
    });

    it('moves an entry backward (up the list)', () => {
      const state = makeState({ meeting: makeMeeting({ queuedSpeakerIds }) });
      const result = meetingReducer(state, {
        type: 'optimisticQueueReorder',
        oldIndex: 2,
        newIndex: 0,
      });
      expect(result.meeting!.queuedSpeakerIds).toEqual(['z', 'x', 'y']);
    });

    it('is a no-op when oldIndex equals newIndex', () => {
      const state = makeState({ meeting: makeMeeting({ queuedSpeakerIds }) });
      const result = meetingReducer(state, {
        type: 'optimisticQueueReorder',
        oldIndex: 1,
        newIndex: 1,
      });
      expect(result.meeting!.queuedSpeakerIds).toEqual(['x', 'y', 'z']);
    });

    it('does not mutate the original state', () => {
      const state = makeState({ meeting: makeMeeting({ queuedSpeakerIds }) });
      meetingReducer(state, {
        type: 'optimisticQueueReorder',
        oldIndex: 0,
        newIndex: 2,
      });
      expect(state.meeting!.queuedSpeakerIds).toEqual(['x', 'y', 'z']);
    });

    it('returns state unchanged when meeting is null', () => {
      const state = makeState({ meeting: null });
      const result = meetingReducer(state, {
        type: 'optimisticQueueReorder',
        oldIndex: 0,
        newIndex: 1,
      });
      expect(result).toBe(state);
    });
  });
});
