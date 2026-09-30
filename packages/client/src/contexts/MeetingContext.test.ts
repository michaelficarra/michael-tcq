import { describe, it, expect } from 'vitest';
import type { MeetingState, User } from '@tcq/shared';
import { meetingReducer, type MeetingContextState } from './MeetingContext.js';
import { makeMeeting as buildMeeting } from '../test/makeMeeting.js';

/** Create a minimal meeting state for testing. */
function makeMeeting(overrides?: Partial<MeetingState>): MeetingState {
  return buildMeeting(overrides);
}

function makeState(overrides?: Partial<MeetingContextState>): MeetingContextState {
  return {
    meeting: null,
    user: null,
    connected: false,
    activeConnections: 0,
    error: null,
    lastSeenVersion: null,
    serverRevision: null,
    ...overrides,
  };
}

const alice: User = {
  provider: 'github',
  accountId: 'alice',
  handle: 'alice',
  name: 'Alice',
  organisation: 'ACME',
  avatarUrl: 'https://github.com/alice.png?size=80',
};

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
      { kind: 'item' as const, id: 'a', name: 'First', presenterIds: ['github:alice'] },
      { kind: 'item' as const, id: 'b', name: 'Second', presenterIds: ['github:alice'] },
      { kind: 'item' as const, id: 'c', name: 'Third', presenterIds: ['github:alice'] },
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
    const queueWith = (orderedIds: string[]) => ({ entries: {}, orderedIds, closed: false });

    it('moves an entry forward (down the list)', () => {
      const state = makeState({ meeting: makeMeeting({ queue: queueWith(['x', 'y', 'z']) }) });
      const result = meetingReducer(state, {
        type: 'optimisticQueueReorder',
        oldIndex: 0,
        newIndex: 2,
      });
      expect(result.meeting!.queue.orderedIds).toEqual(['y', 'z', 'x']);
    });

    it('moves an entry backward (up the list)', () => {
      const state = makeState({ meeting: makeMeeting({ queue: queueWith(['x', 'y', 'z']) }) });
      const result = meetingReducer(state, {
        type: 'optimisticQueueReorder',
        oldIndex: 2,
        newIndex: 0,
      });
      expect(result.meeting!.queue.orderedIds).toEqual(['z', 'x', 'y']);
    });

    it('is a no-op when oldIndex equals newIndex', () => {
      const state = makeState({ meeting: makeMeeting({ queue: queueWith(['x', 'y', 'z']) }) });
      const result = meetingReducer(state, {
        type: 'optimisticQueueReorder',
        oldIndex: 1,
        newIndex: 1,
      });
      expect(result.meeting!.queue.orderedIds).toEqual(['x', 'y', 'z']);
    });

    it('does not mutate the original state', () => {
      const state = makeState({ meeting: makeMeeting({ queue: queueWith(['x', 'y', 'z']) }) });
      meetingReducer(state, {
        type: 'optimisticQueueReorder',
        oldIndex: 0,
        newIndex: 2,
      });
      expect(state.meeting!.queue.orderedIds).toEqual(['x', 'y', 'z']);
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
  // -- poll request deltas --

  describe('poll request deltas', () => {
    const request = (id: string, requesterId: string) => ({
      id,
      requesterId,
      multiSelect: true,
      options: [
        { id: `${id}-a`, emoji: '👍', label: 'Yes' },
        { id: `${id}-b`, emoji: '👎', label: 'No' },
      ],
      requestedAt: '2026-01-01T00:00:00.000Z',
    });

    it('pollRequested appends a request, merges users, and leaves lastSeenVersion alone', () => {
      const state = makeState({ meeting: makeMeeting(), lastSeenVersion: 7 });
      const next = meetingReducer(state, {
        type: 'pollRequested',
        event: { request: request('r1', 'github:bob'), users: { 'github:alice': alice } },
      });
      expect(next.meeting?.pollRequests?.map((r) => r.id)).toEqual(['r1']);
      expect(next.meeting?.users['github:alice']).toEqual(alice);
      // Unversioned: only chairs and the requester receive these events.
      expect(next.lastSeenVersion).toBe(7);
      expect(next.meeting?.operational.version).toBe(state.meeting!.operational.version);
    });

    it('pollRequested replaces an earlier request from the same requester', () => {
      const meeting = makeMeeting({ pollRequests: [request('r1', 'github:bob'), request('r2', 'github:carol')] });
      const next = meetingReducer(makeState({ meeting, lastSeenVersion: 0 }), {
        type: 'pollRequested',
        event: { request: request('r3', 'github:bob') },
      });
      expect(next.meeting?.pollRequests?.map((r) => r.id)).toEqual(['r2', 'r3']);
    });

    it('pollRequestRemoved drops the request and the key once empty', () => {
      const meeting = makeMeeting({ pollRequests: [request('r1', 'github:bob')] });
      const next = meetingReducer(makeState({ meeting, lastSeenVersion: 3 }), {
        type: 'pollRequestRemoved',
        event: { id: 'r1' },
      });
      expect('pollRequests' in next.meeting!).toBe(false);
      expect(next.lastSeenVersion).toBe(3);
    });

    it('poll:started with requestId consumes that request only', () => {
      const meeting = makeMeeting({ pollRequests: [request('r1', 'github:bob'), request('r2', 'github:carol')] });
      const poll = {
        options: [],
        reactions: [],
        startTime: '2026-01-01T00:00:00.000Z',
        startChairId: 'github:alice' as const,
        multiSelect: true,
        requesterId: 'github:bob' as const,
      };
      const next = meetingReducer(makeState({ meeting, lastSeenVersion: 0 }), {
        type: 'poll:started',
        delta: { version: 1, poll, requestId: 'r1' },
      });
      expect(next.meeting?.poll).toEqual(poll);
      expect(next.meeting?.pollRequests?.map((r) => r.id)).toEqual(['r2']);
    });

    it('poll:started without requestId leaves pending requests alone', () => {
      const meeting = makeMeeting({ pollRequests: [request('r1', 'github:bob')] });
      const poll = {
        options: [],
        reactions: [],
        startTime: '2026-01-01T00:00:00.000Z',
        startChairId: 'github:alice' as const,
        multiSelect: true,
      };
      const next = meetingReducer(makeState({ meeting, lastSeenVersion: 0 }), {
        type: 'poll:started',
        delta: { version: 1, poll },
      });
      expect(next.meeting?.pollRequests?.map((r) => r.id)).toEqual(['r1']);
    });

    it('agenda:advanced clears pending requests', () => {
      const meeting = makeMeeting({ pollRequests: [request('r1', 'github:bob')] });
      const next = meetingReducer(makeState({ meeting, lastSeenVersion: 0 }), {
        type: 'agenda:advanced',
        delta: {
          version: 1,
          current: { topicSpeakers: [], agendaItemId: 'x', startedAt: 'x' },
          queue: { entries: {}, orderedIds: [], closed: false },
          lastAdvancementBy: 'github:alice',
        },
      });
      expect('pollRequests' in next.meeting!).toBe(false);
    });
  });
});
