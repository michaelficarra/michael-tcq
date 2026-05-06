/**
 * Pure transformation: take a `MeetingState` and a typed delta action,
 * return the new `MeetingState`. Used both by the client reducer (which
 * wraps it with React state-management plumbing) and by the test
 * harness that verifies the client and server stay in sync byte-for-byte.
 *
 * Keeping this in `@tcq/shared` ensures there is exactly one
 * implementation of "how a delta updates state" and that it can be
 * exercised against the server's authoritative state without depending
 * on React or any DOM environment.
 */

import type {
  AgendaAddedDelta,
  AgendaAdvancedDelta,
  AgendaDeletedDelta,
  AgendaEditedDelta,
  AgendaReorderedDelta,
  ChairsUpdatedDelta,
  PollReactedDelta,
  PollStartedDelta,
  PollStoppedDelta,
  QueueAddedDelta,
  QueueClosedChangedDelta,
  QueueEditedDelta,
  QueueRemovedDelta,
  QueueReorderedDelta,
  SpeakerAdvancedDelta,
} from './messages.js';
import type { MeetingState, User, UserKey } from './types.js';

/**
 * Discriminated union of all delta-shaped actions. The `type` matches
 * the corresponding `ServerToClientEvents` event name 1:1, which makes
 * dispatching from a socket listener a no-op rename.
 */
export type MeetingDeltaAction =
  | { type: 'chairs:updated'; delta: ChairsUpdatedDelta }
  | { type: 'agenda:added'; delta: AgendaAddedDelta }
  | { type: 'agenda:edited'; delta: AgendaEditedDelta }
  | { type: 'agenda:deleted'; delta: AgendaDeletedDelta }
  | { type: 'agenda:reordered'; delta: AgendaReorderedDelta }
  | { type: 'queue:added'; delta: QueueAddedDelta }
  | { type: 'queue:edited'; delta: QueueEditedDelta }
  | { type: 'queue:removed'; delta: QueueRemovedDelta }
  | { type: 'queue:reordered'; delta: QueueReorderedDelta }
  | { type: 'queue:closedChanged'; delta: QueueClosedChangedDelta }
  | { type: 'speaker:advanced'; delta: SpeakerAdvancedDelta }
  | { type: 'agenda:advanced'; delta: AgendaAdvancedDelta }
  | { type: 'poll:started'; delta: PollStartedDelta }
  | { type: 'poll:stopped'; delta: PollStoppedDelta }
  | { type: 'poll:reacted'; delta: PollReactedDelta };

/**
 * Merge any newly-introduced user records carried by a delta into the
 * meeting's local `users` cache. Idempotent — known users are
 * overwritten with the (presumably identical) latest snapshot.
 */
function mergeUsers(current: Record<UserKey, User>, added: Record<UserKey, User> | undefined): Record<UserKey, User> {
  if (!added) return current;
  return { ...current, ...added };
}

/**
 * Apply a versioned delta on top of an existing `MeetingState`. The
 * gap-detection check on the socket listener is what guarantees the
 * delta is the next-expected one — this function does no version
 * checking itself.
 *
 * Every result also has its `operational.version` advanced to the
 * delta's `version` so the local state's `version` field stays in
 * lockstep with the server's authoritative counter — this is what the
 * reducer/server-equivalence test asserts on every mutation.
 */
export function applyDelta(meeting: MeetingState, action: MeetingDeltaAction): MeetingState {
  const next = applyDeltaInner(meeting, action);
  return next.operational.version === action.delta.version
    ? next
    : { ...next, operational: { ...next.operational, version: action.delta.version } };
}

function applyDeltaInner(meeting: MeetingState, action: MeetingDeltaAction): MeetingState {
  switch (action.type) {
    case 'chairs:updated':
      return {
        ...meeting,
        chairIds: action.delta.chairIds,
        users: mergeUsers(meeting.users, action.delta.users),
      };
    case 'agenda:added':
      return {
        ...meeting,
        agenda: [...meeting.agenda, action.delta.entry],
        users: mergeUsers(meeting.users, action.delta.users),
      };
    case 'agenda:edited':
      return {
        ...meeting,
        agenda: meeting.agenda.map((e) => (e.id === action.delta.id ? action.delta.entry : e)),
        users: mergeUsers(meeting.users, action.delta.users),
      };
    case 'agenda:deleted':
      return {
        ...meeting,
        agenda: meeting.agenda.filter((e) => e.id !== action.delta.id),
        current: action.delta.currentCleared ? { ...meeting.current, agendaItemId: undefined } : meeting.current,
      };
    case 'agenda:reordered': {
      const byId = new Map(meeting.agenda.map((e) => [e.id, e] as const));
      const reordered = action.delta.orderedIds
        .map((id) => byId.get(id))
        .filter((e): e is NonNullable<typeof e> => e !== undefined);
      return { ...meeting, agenda: reordered };
    }
    case 'queue:added': {
      const orderedIds = [...meeting.queue.orderedIds];
      orderedIds.splice(action.delta.position, 0, action.delta.entry.id);
      return {
        ...meeting,
        queue: {
          ...meeting.queue,
          entries: { ...meeting.queue.entries, [action.delta.entry.id]: action.delta.entry },
          orderedIds,
        },
        users: mergeUsers(meeting.users, action.delta.users),
      };
    }
    case 'queue:edited':
      return {
        ...meeting,
        queue: {
          ...meeting.queue,
          entries: { ...meeting.queue.entries, [action.delta.id]: action.delta.entry },
        },
      };
    case 'queue:removed': {
      // Construct a fresh entries map without the removed id rather than
      // using destructuring rest (the rest binding triggers an unused-var
      // lint warning when the dropped key isn't referenced).
      const remaining: typeof meeting.queue.entries = {};
      for (const [id, entry] of Object.entries(meeting.queue.entries)) {
        if (id !== action.delta.id) remaining[id] = entry;
      }
      return {
        ...meeting,
        queue: {
          ...meeting.queue,
          entries: remaining,
          orderedIds: meeting.queue.orderedIds.filter((id) => id !== action.delta.id),
        },
      };
    }
    case 'queue:reordered': {
      // Apply any priority-crossing type changes the server produced
      // (delta.updatedEntries carries partial patches keyed by id),
      // then re-order according to the canonical orderedIds.
      let entries = meeting.queue.entries;
      if (action.delta.updatedEntries) {
        entries = { ...entries };
        for (const [id, patch] of Object.entries(action.delta.updatedEntries)) {
          const existing = entries[id];
          if (existing) entries[id] = { ...existing, ...patch };
        }
      }
      return {
        ...meeting,
        queue: { ...meeting.queue, entries, orderedIds: action.delta.orderedIds },
      };
    }
    case 'queue:closedChanged':
      return { ...meeting, queue: { ...meeting.queue, closed: action.delta.closed } };
    case 'speaker:advanced':
      return {
        ...meeting,
        current: action.delta.current,
        queue: action.delta.queue,
        operational: { ...meeting.operational, lastAdvancementBy: action.delta.lastAdvancementBy },
      };
    case 'agenda:advanced': {
      const agenda = action.delta.agendaUpdates
        ? meeting.agenda.map((e) => {
            const update = action.delta.agendaUpdates?.[e.id];
            return update ? ({ ...e, ...update } as typeof e) : e;
          })
        : meeting.agenda;
      return {
        ...meeting,
        agenda,
        current: action.delta.current,
        queue: action.delta.queue,
        operational: { ...meeting.operational, lastAdvancementBy: action.delta.lastAdvancementBy },
        users: mergeUsers(meeting.users, action.delta.users),
      };
    }
    case 'poll:started':
      return { ...meeting, poll: action.delta.poll };
    case 'poll:stopped':
      return { ...meeting, poll: undefined };
    case 'poll:reacted':
      return meeting.poll ? { ...meeting, poll: { ...meeting.poll, reactions: action.delta.reactions } } : meeting;
  }
}
