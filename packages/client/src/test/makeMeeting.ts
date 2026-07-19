/**
 * Test helper for constructing a MeetingState fixture.
 *
 * Accepts a `Partial<MeetingState>` of overrides on top of sensible defaults
 * (empty users, empty agenda, queue closed, no current speaker/topic).
 * Callers pass the nested subobjects directly: `{ queue, current, operational,
 * poll?, ... }`.
 */
import type { ActivePoll, MeetingState } from '@tcq/shared';
import { asUserKey } from '@tcq/shared';

export interface MakeMeetingDefaults {
  id?: string;
  users?: MeetingState['users'];
  chairIds?: MeetingState['chairIds'];
  agenda?: MeetingState['agenda'];
}

export function makeMeeting(overrides?: Partial<MeetingState>, defaults: MakeMeetingDefaults = {}): MeetingState {
  const { queue, current, operational, ...rest } = overrides ?? {};

  return {
    id: defaults.id ?? 'test-meeting',
    createdAt: '2026-01-01T00:00:00.000Z',
    participantIds: [],
    users: defaults.users ?? {},
    chairIds: defaults.chairIds ?? [],
    agenda: defaults.agenda ?? [],
    queue: queue ?? { entries: {}, orderedIds: [], closed: false },
    current: current ?? { topicSpeakers: [] },
    operational: {
      lastConnectionTime: '2026-01-01T00:00:00.000Z',
      maxConcurrent: 0,
      version: 0,
      ...operational,
    },
    ...rest,
  };
}

/**
 * A `current` context for a meeting that is under way — an agenda item is
 * active. The `makeMeeting` default is the pre-start state, in which Point of
 * Order is the only addable queue entry type, so tests exercising the ordinary
 * queue controls need to opt into this instead.
 *
 * Spread it when adding fields (e.g. a current topic) so `agendaItemId`
 * survives: `current: { ...RUNNING_CURRENT, topic: … }`.
 */
export const RUNNING_CURRENT: MeetingState['current'] = {
  topicSpeakers: [],
  startedAt: '2026-01-01T00:00:00.000Z',
  agendaItemId: 'item-1',
};

/** Convenience: construct an ActivePoll with sensible defaults. */
export function makePoll(overrides?: Partial<ActivePoll>): ActivePoll {
  return {
    options: [],
    reactions: [],
    startTime: '2026-01-01T00:00:00.000Z',
    startChairId: asUserKey(''),
    multiSelect: true,
    ...overrides,
  };
}
