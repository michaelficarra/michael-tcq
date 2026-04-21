/**
 * Test helper for constructing a MeetingState fixture.
 *
 * Accepts either the current nested fields (queue, current, operational)
 * or a set of legacy flat aliases (queueEntries, queuedSpeakerIds,
 * queueClosed, currentAgendaItemId, currentAgendaItemStartTime,
 * currentSpeakerEntryId, currentTopicEntryId, currentTopicSpeakers,
 * lastSpeakerAdvancementAttributedTo, lastConnectionTime). The aliases
 * are folded into the nested shape — tests that were written before the
 * state shape was reorganised can keep working by passing the flat form.
 *
 * If `currentSpeakerEntryId` is supplied and matches an entry in
 * `queueEntries`, that entry is lifted into `current.speaker` and removed
 * from `queue.entries` (the new shape stores the current speaker as a
 * first-class struct, not as a queue entry lookup).
 */
import type {
  ActivePoll,
  CurrentContext,
  CurrentSpeaker,
  CurrentTopic,
  MeetingQueueState,
  MeetingState,
  QueueEntry,
  TopicSpeaker,
} from '@tcq/shared';

export interface MakeMeetingOverrides extends Partial<MeetingState> {
  queueEntries?: Record<string, QueueEntry>;
  queuedSpeakerIds?: string[];
  queueClosed?: boolean;
  currentAgendaItemId?: string;
  currentAgendaItemStartTime?: string;
  currentSpeakerEntryId?: string;
  currentTopicEntryId?: string;
  currentTopicSpeakers?: TopicSpeaker[];
  lastSpeakerAdvancementAttributedTo?: string;
  lastConnectionTime?: string;
}

function toSpeaker(id: string, entry: QueueEntry | undefined): CurrentSpeaker {
  return {
    id,
    type: entry?.type ?? 'topic',
    topic: entry?.topic ?? '',
    userId: entry?.userId ?? '',
    source: 'queue',
    startTime: '2026-01-01T00:00:00.000Z',
  };
}

function toTopic(entry: QueueEntry | undefined): CurrentTopic | undefined {
  if (!entry) return undefined;
  return { userId: entry.userId, topic: entry.topic, startTime: '2026-01-01T00:00:00.000Z' };
}

export interface MakeMeetingDefaults {
  id?: string;
  users?: MeetingState['users'];
  chairIds?: MeetingState['chairIds'];
  agenda?: MeetingState['agenda'];
}

export function makeMeeting(overrides?: MakeMeetingOverrides, defaults: MakeMeetingDefaults = {}): MeetingState {
  const {
    queueEntries,
    queuedSpeakerIds,
    queueClosed,
    currentAgendaItemId,
    currentAgendaItemStartTime,
    currentSpeakerEntryId,
    currentTopicEntryId,
    currentTopicSpeakers,
    lastSpeakerAdvancementAttributedTo,
    lastConnectionTime,
    queue: queueOverride,
    current: currentOverride,
    operational: operationalOverride,
    ...rest
  } = overrides ?? {};

  const allEntries = { ...(queueEntries ?? {}) };
  let speaker: CurrentSpeaker | undefined;
  if (currentSpeakerEntryId) {
    speaker = toSpeaker(currentSpeakerEntryId, allEntries[currentSpeakerEntryId]);
    delete allEntries[currentSpeakerEntryId];
  }
  const topicEntry = currentTopicEntryId ? queueEntries?.[currentTopicEntryId] : undefined;
  const topic = toTopic(topicEntry);

  const queue: MeetingQueueState = queueOverride ?? {
    entries: allEntries,
    orderedIds: queuedSpeakerIds ?? [],
    closed: queueClosed ?? false,
  };

  const current: CurrentContext = currentOverride ?? {
    agendaItemId: currentAgendaItemId,
    agendaItemStartTime: currentAgendaItemStartTime,
    speaker,
    topic,
    topicSpeakers: currentTopicSpeakers ?? [],
  };

  const operational = operationalOverride ?? {
    lastAdvancementBy: lastSpeakerAdvancementAttributedTo,
    lastConnectionTime,
  };

  return {
    id: defaults.id ?? 'test-meeting',
    users: defaults.users ?? {},
    chairIds: defaults.chairIds ?? [],
    agenda: defaults.agenda ?? [],
    queue,
    current,
    operational,
    log: [],
    ...rest,
  };
}

/** Convenience: construct an ActivePoll with sensible defaults. */
export function makePoll(overrides?: Partial<ActivePoll>): ActivePoll {
  return {
    options: [],
    reactions: [],
    startTime: '2026-01-01T00:00:00.000Z',
    startChairId: '',
    multiSelect: true,
    ...overrides,
  };
}
