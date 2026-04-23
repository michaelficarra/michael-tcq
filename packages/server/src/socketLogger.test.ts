import { describe, it, expect } from 'vitest';
import type { MeetingState, AgendaItem, Session, QueueEntry, CurrentTopic, CurrentSpeaker, User } from '@tcq/shared';
import { userKey } from '@tcq/shared';
import { denormalisePayload, attributionFields } from './socketLogger.js';

function makeUser(ghid: number, ghUsername: string): User {
  return { ghid, ghUsername, name: ghUsername, organisation: '' };
}

function makeMeeting(): MeetingState {
  const alice = makeUser(1, 'alice');
  const bob = makeUser(2, 'bob');

  const agendaItem: AgendaItem = {
    id: 'item-1',
    name: 'Item one',
    presenterIds: [userKey(alice)],
    duration: 10,
  };
  const session: Session = {
    kind: 'session',
    id: 'session-1',
    name: 'Morning session',
    capacity: 60,
  };
  const queueEntry: QueueEntry = {
    id: 'qe-1',
    type: 'topic',
    topic: 'My topic',
    userId: userKey(alice),
  };
  const topic: CurrentTopic = {
    speakerId: 'speaker-1',
    userId: userKey(alice),
    topic: 'Discussing things',
    startTime: '2026-04-22T00:00:00.000Z',
  };
  const speaker: CurrentSpeaker = {
    id: 'speaker-1',
    type: 'topic',
    topic: 'Discussing things',
    userId: userKey(alice),
    source: 'queue',
    startTime: '2026-04-22T00:00:00.000Z',
  };

  return {
    id: 'meeting-x',
    users: { [userKey(alice)]: alice, [userKey(bob)]: bob },
    chairIds: [userKey(alice)],
    agenda: [agendaItem, session],
    queue: {
      entries: { 'qe-1': queueEntry },
      orderedIds: ['qe-1'],
      closed: false,
    },
    current: { topic, speaker, topicSpeakers: [] },
    operational: { lastConnectionTime: '2026-04-22T00:00:00.000Z' },
    log: [],
  };
}

describe('denormalisePayload', () => {
  it('replaces agenda:reorder ids with the full agenda entries', () => {
    const meeting = makeMeeting();
    const out = denormalisePayload('agenda:reorder', { id: 'item-1', afterId: 'session-1' }, meeting);
    expect(out).toEqual({
      id: { id: 'item-1', name: 'Item one', presenterIds: ['alice'], duration: 10 },
      afterId: { kind: 'session', id: 'session-1', name: 'Morning session', capacity: 60 },
    });
  });

  it('preserves null afterId (move-to-start sentinel)', () => {
    const meeting = makeMeeting();
    const out = denormalisePayload('agenda:reorder', { id: 'item-1', afterId: null }, meeting) as {
      id: unknown;
      afterId: unknown;
    };
    expect(out.afterId).toBeNull();
    expect(out.id).toMatchObject({ name: 'Item one' });
  });

  it('replaces queue:remove id with the queue entry', () => {
    const meeting = makeMeeting();
    const out = denormalisePayload('queue:remove', { id: 'qe-1' }, meeting);
    expect(out).toEqual({
      id: { id: 'qe-1', type: 'topic', topic: 'My topic', userId: 'alice' },
    });
  });

  it('replaces meeting:updateChairs usernames with User objects', () => {
    const meeting = makeMeeting();
    const out = denormalisePayload('meeting:updateChairs', { usernames: ['alice', 'bob'] }, meeting) as {
      usernames: unknown[];
    };
    expect(out.usernames).toEqual([
      { ghid: 1, ghUsername: 'alice', name: 'alice', organisation: '' },
      { ghid: 2, ghUsername: 'bob', name: 'bob', organisation: '' },
    ]);
  });

  it('replaces queue:add currentTopicSpeakerId with the current topic', () => {
    const meeting = makeMeeting();
    const out = denormalisePayload(
      'queue:add',
      { type: 'reply', topic: 'My reply', currentTopicSpeakerId: 'speaker-1' },
      meeting,
    ) as { currentTopicSpeakerId: unknown };
    expect(out.currentTopicSpeakerId).toMatchObject({
      speakerId: 'speaker-1',
      topic: 'Discussing things',
    });
  });

  it('replaces meeting:nextAgendaItem currentAgendaItemId with the agenda item', () => {
    const meeting = makeMeeting();
    const out = denormalisePayload('meeting:nextAgendaItem', { currentAgendaItemId: 'item-1' }, meeting) as {
      currentAgendaItemId: unknown;
    };
    expect(out.currentAgendaItemId).toMatchObject({ name: 'Item one' });
  });

  it('leaves unknown ids untouched so the log still shows something useful', () => {
    const meeting = makeMeeting();
    const out = denormalisePayload('agenda:delete', { id: 'does-not-exist' }, meeting);
    expect(out).toEqual({ id: 'does-not-exist' });
  });

  it('returns the payload unchanged when there is no joined meeting', () => {
    const out = denormalisePayload('agenda:reorder', { id: 'item-1', afterId: null }, undefined);
    expect(out).toEqual({ id: 'item-1', afterId: null });
  });

  it('passes non-object payloads through (e.g. the `join` meetingId string)', () => {
    const meeting = makeMeeting();
    const out = denormalisePayload('join', 'meeting-x', meeting);
    expect(out).toBe('meeting-x');
  });
});

describe('attributionFields', () => {
  it('nests user identity fields under a `user` key', () => {
    const fields = attributionFields({
      ghid: 7,
      ghUsername: 'octocat',
      name: 'Octocat',
      organisation: 'GitHub',
      isAdmin: true,
    });
    expect(fields).toEqual({ user: { ghid: 7, ghUsername: 'octocat', isAdmin: true } });
  });
});
