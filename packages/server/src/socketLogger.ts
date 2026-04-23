/**
 * Socket.IO event logging helpers.
 *
 * `denormalisePayload` swaps entity IDs (agenda entry ids, queue entry ids,
 * poll option ids, usernames) for the entities they reference in the
 * current meeting state. Each entry in the log is then self-contained —
 * an operator reading `agenda:reorder` sees the full item being moved
 * without having to cross-reference a separate state dump.
 *
 * `attributionFields` produces the nested `user` sub-struct used by
 * every log entry that names an acting user, so attribution stays
 * grouped rather than sprinkled across the top level.
 */

import type { MeetingState } from '@tcq/shared';
import { asUserKey } from '@tcq/shared';
import type { SessionUser } from './session.js';

/** Look up an agenda entry (item or session header) by id. */
function lookupAgendaEntry(meeting: MeetingState, id: unknown): unknown {
  if (typeof id !== 'string') return undefined;
  return meeting.agenda.find((e) => e.id === id);
}

/** Look up a user by GitHub username (case-insensitive), returning the stored User if known. */
function lookupUser(meeting: MeetingState, username: unknown): unknown {
  if (typeof username !== 'string') return undefined;
  return meeting.users[asUserKey(username.toLowerCase())];
}

/**
 * Replace entity IDs in an event payload with the entities they reference
 * in the given meeting state. Returns a shallow clone — the original is
 * left untouched so the downstream handler sees the raw payload it
 * expects. If the referenced entity can't be found (unknown id, meeting
 * not joined, etc.) the original scalar is preserved so the log entry
 * still shows something useful.
 */
export function denormalisePayload(event: string, payload: unknown, meeting: MeetingState | undefined): unknown {
  if (!meeting || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload;
  }
  const p: Record<string, unknown> = { ...(payload as Record<string, unknown>) };

  // Agenda item/session edits, deletes, and reorders — id and afterId
  // reference entries in meeting.agenda (items and sessions share the
  // same id-space).
  if (
    event === 'agenda:edit' ||
    event === 'agenda:delete' ||
    event === 'agenda:reorder' ||
    event === 'session:edit' ||
    event === 'session:delete'
  ) {
    if ('id' in p) p.id = lookupAgendaEntry(meeting, p.id) ?? p.id;
    if ('afterId' in p && p.afterId != null) p.afterId = lookupAgendaEntry(meeting, p.afterId) ?? p.afterId;
  }

  // Queue entry edits, removes, reorders — id/afterId reference entries
  // in meeting.queue.entries.
  if (event === 'queue:edit' || event === 'queue:remove' || event === 'queue:reorder') {
    if (typeof p.id === 'string') p.id = meeting.queue.entries[p.id] ?? p.id;
    if (typeof p.afterId === 'string') p.afterId = meeting.queue.entries[p.afterId] ?? p.afterId;
  }

  // queue:add — asUsername is a presenter username; currentTopicSpeakerId
  // references the CurrentTopic the client saw at emit time.
  if (event === 'queue:add') {
    if ('asUsername' in p) p.asUsername = lookupUser(meeting, p.asUsername) ?? p.asUsername;
    if ('currentTopicSpeakerId' in p && p.currentTopicSpeakerId) {
      if (meeting.current.topic?.speakerId === p.currentTopicSpeakerId) {
        p.currentTopicSpeakerId = meeting.current.topic;
      }
    }
  }

  // queue:next — currentSpeakerEntryId is the speaker id the client last
  // saw (precondition for idempotent advancement).
  if (event === 'queue:next' && 'currentSpeakerEntryId' in p && p.currentSpeakerEntryId) {
    if (meeting.current.speaker?.id === p.currentSpeakerEntryId) {
      p.currentSpeakerEntryId = meeting.current.speaker;
    }
  }

  // meeting:nextAgendaItem — currentAgendaItemId is the precondition
  // agenda item id (may be null on meeting start).
  if (event === 'meeting:nextAgendaItem' && 'currentAgendaItemId' in p && p.currentAgendaItemId) {
    p.currentAgendaItemId = lookupAgendaEntry(meeting, p.currentAgendaItemId) ?? p.currentAgendaItemId;
  }

  // poll:react — optionId references one of the active poll's options.
  if (event === 'poll:react' && 'optionId' in p && meeting.poll) {
    const opt = meeting.poll.options.find((o) => o.id === p.optionId);
    if (opt) p.optionId = opt;
  }

  // meeting:updateChairs — usernames is an array of GitHub usernames.
  if (event === 'meeting:updateChairs' && Array.isArray(p.usernames)) {
    p.usernames = p.usernames.map((u) => lookupUser(meeting, u) ?? u);
  }

  // agenda:add / agenda:edit — presenterUsernames is an array of GitHub usernames.
  if ((event === 'agenda:add' || event === 'agenda:edit') && Array.isArray(p.presenterUsernames)) {
    p.presenterUsernames = p.presenterUsernames.map((u) => lookupUser(meeting, u) ?? u);
  }

  return p;
}

/**
 * Produce the nested attribution sub-struct for an authenticated log
 * entry. Keyed under `user` so ghid/ghUsername/isAdmin never float free
 * at the top level alongside other unrelated fields.
 */
export function attributionFields(user: SessionUser): { user: { ghid: number; ghUsername: string; isAdmin: boolean } } {
  return {
    user: {
      ghid: user.ghid,
      ghUsername: user.ghUsername,
      isAdmin: user.isAdmin,
    },
  };
}
