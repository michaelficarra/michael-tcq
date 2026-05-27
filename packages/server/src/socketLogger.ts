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

import type { MeetingState, UserKey } from '@tcq/shared';
import type { SessionUser } from './session.js';
import { findUserByHandle } from './auth/githubUser.js';

/** Look up an agenda entry (item or session header) by id. */
function lookupAgendaEntry(meeting: MeetingState, id: unknown): unknown {
  if (typeof id !== 'string') return undefined;
  return meeting.agenda.find((e) => e.id === id);
}

/** Look up a user by handle (case-insensitive), returning the stored User if known. */
function lookupUser(meeting: MeetingState, username: unknown): unknown {
  if (typeof username !== 'string') return undefined;
  return findUserByHandle(meeting, username);
}

/**
 * Resolve a `UserSelection` (chair/presenter wire ref) to its stored User for
 * readable logging — `{provider,accountId}` via the meeting's users map,
 * `{handle}` via a handle scan. Falls back to the raw selection when unknown.
 */
function lookupSelection(meeting: MeetingState, sel: unknown): unknown {
  if (sel && typeof sel === 'object') {
    if ('handle' in sel && typeof sel.handle === 'string') {
      return findUserByHandle(meeting, sel.handle) ?? sel;
    }
    if ('provider' in sel && 'accountId' in sel) {
      const key = `${(sel as { provider: string }).provider}:${(sel as { accountId: string }).accountId}` as UserKey;
      return meeting.users[key] ?? sel;
    }
  }
  return sel;
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

  // meeting:updateChairs — chairs is an array of UserSelections.
  if (event === 'meeting:updateChairs' && Array.isArray(p.chairs)) {
    p.chairs = p.chairs.map((sel) => lookupSelection(meeting, sel));
  }

  // agenda:add / agenda:edit — presenters is an array of UserSelections.
  if ((event === 'agenda:add' || event === 'agenda:edit') && Array.isArray(p.presenters)) {
    p.presenters = p.presenters.map((sel) => lookupSelection(meeting, sel));
  }

  return p;
}

/**
 * Produce the nested attribution sub-struct for an authenticated log
 * entry. Keyed under `user` so provider/accountId/handle/isAdmin never
 * float free at the top level alongside other unrelated fields.
 */
export function attributionFields(user: SessionUser): {
  user: { provider: string; accountId: string; handle?: string; isAdmin: boolean };
} {
  return {
    user: {
      provider: user.provider,
      accountId: user.accountId,
      handle: user.handle,
      isAdmin: user.isAdmin,
    },
  };
}
