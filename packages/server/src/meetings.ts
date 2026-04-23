import { randomUUID } from 'node:crypto';
import type {
  AgendaItem,
  CurrentSpeaker,
  MeetingState,
  QueueEntry,
  QueueEntryType,
  Session,
  TopicSpeaker,
  User,
  UserKey,
} from '@tcq/shared';
import { QUEUE_ENTRY_PRIORITY, isAgendaItem, userKey } from '@tcq/shared';
import type { MeetingStore } from './store.js';
import { generateMeetingId } from './meetingId.js';
import { info, notice, error as logError, serialiseError } from './logger.js';

/**
 * Register a user in a meeting's users map, returning their canonical key.
 * Always updates the stored user so name/organisation changes are picked up.
 */
export function ensureUser(meeting: MeetingState, user: User): UserKey {
  const key = userKey(user);
  meeting.users[key] = user;
  return key;
}

/** Drop duplicate keys, preserving first-occurrence order. */
function dedupeKeys(keys: UserKey[]): UserKey[] {
  const seen = new Set<UserKey>();
  const out: UserKey[] = [];
  for (const k of keys) {
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

/**
 * Manages the in-memory map of active meetings and coordinates with
 * the persistent store for durability.
 *
 * All reads and mutations go through this class. The persistent store
 * is written to periodically (see `startPeriodicSync`) and on
 * significant events.
 */
/** How long (in ms) a meeting is retained after its most recent connection. */
const MEETING_EXPIRY_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

export class MeetingManager {
  /** The canonical in-memory state for all active meetings. */
  private meetings = new Map<string, MeetingState>();

  /** Tracks which meetings have unsaved changes. */
  private dirty = new Set<string>();

  private store: MeetingStore;

  constructor(store: MeetingStore) {
    this.store = store;
  }

  /**
   * Restore meetings from the persistent store into memory.
   * Called once on server startup.
   */
  async restore(): Promise<void> {
    const meetings = await this.store.loadAll();
    const now = Date.now();
    let expired = 0;

    for (const meeting of meetings) {
      if (this.isExpired(meeting, now)) {
        expired++;
        await this.store.remove(meeting.id);
      } else {
        this.meetings.set(meeting.id, meeting);
      }
    }

    info('meetings_restored', {
      restored: this.meetings.size,
      expiredAtStartup: expired,
    });
  }

  /** Create a new meeting with the given chairs. */
  create(chairs: User[]): MeetingState {
    const id = generateMeetingId((candidate) => this.meetings.has(candidate));

    const users: Record<string, User> = {};
    const chairIds = chairs.map((c) => {
      const key = userKey(c);
      users[key] = c;
      return key;
    });

    const now = new Date().toISOString();
    const meeting: MeetingState = {
      id,
      createdAt: now,
      participantIds: [],
      users,
      chairIds,
      agenda: [],
      queue: {
        entries: {},
        orderedIds: [],
        closed: true,
      },
      current: {
        topicSpeakers: [],
      },
      operational: {
        lastConnectionTime: now,
        maxConcurrent: 0,
      },
      log: [],
    };

    this.meetings.set(id, meeting);
    this.markDirty(id);
    return meeting;
  }

  /** Get a meeting by ID, or undefined if it doesn't exist. */
  get(id: string): MeetingState | undefined {
    return this.meetings.get(id);
  }

  /** Look up the current agenda item for a meeting, or undefined if none is set. */
  getCurrentAgendaItem(meetingId: string): AgendaItem | undefined {
    const meeting = this.meetings.get(meetingId);
    const currentId = meeting?.current.agendaItemId;
    if (!currentId) return undefined;
    // Only agenda items are eligible — sessions are never "current".
    return meeting!.agenda.find((entry): entry is AgendaItem => isAgendaItem(entry) && entry.id === currentId);
  }

  /** List all active meetings. Used by the admin dashboard. */
  listAll(): MeetingState[] {
    return [...this.meetings.values()];
  }

  /** Check whether a meeting exists. */
  has(id: string): boolean {
    return this.meetings.has(id);
  }

  /** Remove a meeting from memory and the persistent store. */
  async remove(id: string): Promise<void> {
    this.meetings.delete(id);
    this.dirty.delete(id);
    await this.store.remove(id);
  }

  /** Mark a meeting as having unsaved changes. */
  markDirty(id: string): void {
    this.dirty.add(id);
  }

  /**
   * Check whether a user is a chair for a given meeting.
   * Returns false if the meeting doesn't exist.
   */
  isChair(meetingId: string, user: User): boolean {
    const meeting = this.meetings.get(meetingId);
    if (!meeting) return false;
    return meeting.chairIds.includes(userKey(user));
  }

  // -- Chair management --

  /**
   * Update the list of chairs for a meeting.
   * Returns false if the meeting doesn't exist.
   * An empty chair list is allowed (admins can clear all chairs).
   */
  updateChairs(meetingId: string, chairs: User[]): boolean {
    const meeting = this.meetings.get(meetingId);
    if (!meeting) return false;

    meeting.chairIds = chairs.map((c) => ensureUser(meeting, c));
    this.markDirty(meetingId);
    return true;
  }

  // -- Agenda mutations --

  /**
   * Add a new agenda item to a meeting. `presenters` must be non-empty;
   * duplicate keys are de-duplicated preserving first-occurrence order.
   * Returns the created item, or null if the meeting doesn't exist or
   * `presenters` is empty.
   */
  addAgendaItem(meetingId: string, name: string, presenters: User[], duration?: number): AgendaItem | null {
    const meeting = this.meetings.get(meetingId);
    if (!meeting) return null;

    const presenterIds = dedupeKeys(presenters.map((p) => ensureUser(meeting, p)));
    if (presenterIds.length === 0) return null;

    const item: AgendaItem = {
      kind: 'item',
      id: randomUUID(),
      name,
      presenterIds,
      duration,
    };

    meeting.agenda.push(item);
    this.markDirty(meetingId);
    return item;
  }

  /**
   * Edit an existing agenda item. Only the provided fields are updated;
   * omitted fields are left unchanged. Pass `duration: null` to clear
   * the duration. When `presenters` is provided it must be non-empty;
   * an empty list is rejected (the call returns false without mutating).
   * Returns true if the item was found and updated.
   */
  editAgendaItem(
    meetingId: string,
    itemId: string,
    updates: { name?: string; presenters?: User[]; duration?: number | null },
  ): boolean {
    const meeting = this.meetings.get(meetingId);
    if (!meeting) return false;

    // Guard on `isAgendaItem` so a session id with the same-shape edit
    // payload can't accidentally mutate a session header here.
    const item = meeting.agenda.find((e): e is AgendaItem => isAgendaItem(e) && e.id === itemId);
    if (!item) return false;

    if (updates.presenters !== undefined) {
      const presenterIds = dedupeKeys(updates.presenters.map((p) => ensureUser(meeting, p)));
      if (presenterIds.length === 0) return false;
      item.presenterIds = presenterIds;
    }
    if (updates.name !== undefined) item.name = updates.name;
    if (updates.duration === null) {
      item.duration = undefined;
    } else if (updates.duration !== undefined) {
      item.duration = updates.duration;
    }

    this.markDirty(meetingId);
    return true;
  }

  /**
   * Delete an agenda item by ID from a meeting.
   * Returns true if the item was found and removed.
   */
  deleteAgendaItem(meetingId: string, itemId: string): boolean {
    const meeting = this.meetings.get(meetingId);
    if (!meeting) return false;

    // Only agenda items — session headers are deleted via `deleteSession`.
    const index = meeting.agenda.findIndex((entry) => isAgendaItem(entry) && entry.id === itemId);
    if (index === -1) return false;

    meeting.agenda.splice(index, 1);

    // If the deleted item was the current agenda item, clear the reference
    if (meeting.current.agendaItemId === itemId) {
      meeting.current.agendaItemId = undefined;
    }

    this.markDirty(meetingId);
    return true;
  }

  /**
   * Reorder an agenda entry (item or session) by moving it after another
   * entry. Items and sessions share the same id-space and are reordered
   * through the same protocol — dnd-kit uses a single sortable context
   * for both.
   *
   * Uses entry UUIDs rather than indices to avoid race conditions when
   * two chairs reorder simultaneously. If `afterId` is null, the entry
   * is moved to the beginning of the agenda.
   *
   * Returns true if the reorder was valid and applied.
   */
  reorderAgendaItem(meetingId: string, itemId: string, afterId: string | null): boolean {
    const meeting = this.meetings.get(meetingId);
    if (!meeting) return false;

    // Find and remove the entry being moved
    const itemIndex = meeting.agenda.findIndex((e) => e.id === itemId);
    if (itemIndex === -1) return false;

    const [entry] = meeting.agenda.splice(itemIndex, 1);

    if (afterId === null) {
      // Move to the beginning
      meeting.agenda.unshift(entry);
    } else {
      // Find the "after" entry in the (now shorter) array
      const afterIndex = meeting.agenda.findIndex((e) => e.id === afterId);
      if (afterIndex === -1) {
        // afterId not found — put the entry back and report failure
        meeting.agenda.splice(itemIndex, 0, entry);
        return false;
      }
      // Insert immediately after the "after" entry
      meeting.agenda.splice(afterIndex + 1, 0, entry);
    }

    this.markDirty(meetingId);
    return true;
  }

  // -- Session mutations --

  /**
   * Add a new session header to the agenda. Appended to the end of the
   * list; callers reposition it via `reorderAgendaItem`. Returns the
   * created session, or null if the meeting doesn't exist.
   */
  addSession(meetingId: string, name: string, capacity: number): Session | null {
    const meeting = this.meetings.get(meetingId);
    if (!meeting) return null;

    const session: Session = {
      kind: 'session',
      id: randomUUID(),
      name,
      capacity,
    };

    meeting.agenda.push(session);
    this.markDirty(meetingId);
    return session;
  }

  /**
   * Edit an existing session header. Only the provided fields are updated.
   * Returns true if the session was found and updated.
   */
  editSession(meetingId: string, sessionId: string, updates: { name?: string; capacity?: number }): boolean {
    const meeting = this.meetings.get(meetingId);
    if (!meeting) return false;

    const session = meeting.agenda.find((e): e is Session => !isAgendaItem(e) && e.id === sessionId);
    if (!session) return false;

    if (updates.name !== undefined) session.name = updates.name;
    if (updates.capacity !== undefined) session.capacity = updates.capacity;

    this.markDirty(meetingId);
    return true;
  }

  /**
   * Delete a session header by ID. Does not delete any agenda items that
   * were visually contained within it — containment is a purely client-side
   * display concern, so the items' positions in the list are unaffected.
   * Returns true if the session was found and removed.
   */
  deleteSession(meetingId: string, sessionId: string): boolean {
    const meeting = this.meetings.get(meetingId);
    if (!meeting) return false;

    const index = meeting.agenda.findIndex((e) => !isAgendaItem(e) && e.id === sessionId);
    if (index === -1) return false;

    meeting.agenda.splice(index, 1);
    this.markDirty(meetingId);
    return true;
  }

  // -- Meeting flow mutations --

  /**
   * Advance to the next agenda item. If no current agenda item is set,
   * this starts the meeting by setting the first item. Otherwise it
   * advances to the next item in the list.
   *
   * When advancing, the agenda item's first presenter becomes the current
   * speaker with a topic of "Introducing: <item name>". The current topic and
   * queue are cleared since we're starting a new agenda item.
   *
   * Returns the new current agenda item, or null if there's nothing to
   * advance to (e.g. we're past the last item, or agenda is empty).
   */
  nextAgendaItem(meetingId: string): AgendaItem | null {
    const meeting = this.meetings.get(meetingId);
    if (!meeting) return null;

    if (meeting.agenda.length === 0) return null;

    // Starting position for the search — one past the current item, or
    // the start of the agenda if no item is current yet.
    let searchFrom: number;
    if (!meeting.current.agendaItemId) {
      searchFrom = 0;
    } else {
      const currentIndex = meeting.agenda.findIndex(
        (entry) => isAgendaItem(entry) && entry.id === meeting.current.agendaItemId,
      );
      searchFrom = currentIndex + 1;
    }

    // Skip any interleaved session headers — advancement only lands on
    // actual agenda items. If the remainder is all sessions (or empty),
    // there's nothing to advance to.
    const nextIndex = meeting.agenda.findIndex((entry, idx) => idx >= searchFrom && isAgendaItem(entry));
    if (nextIndex === -1) return null;

    const nextItem = meeting.agenda[nextIndex] as AgendaItem;
    const now = new Date().toISOString();

    // The item's first presenter becomes the current speaker. No synthesised
    // queue entry: the CurrentSpeaker struct is the sole representation of
    // this turn. Any co-presenters are not auto-queued — they can self-add.
    const firstPresenterId = nextItem.presenterIds[0];
    const speaker: CurrentSpeaker = {
      id: randomUUID(),
      type: 'topic',
      topic: `Introducing: ${nextItem.name}`,
      userId: firstPresenterId,
      source: 'agenda',
      startTime: now,
    };

    // Topic group for this agenda item starts with the introduction.
    const introSpeaker: TopicSpeaker = {
      userId: firstPresenterId,
      type: 'topic',
      topic: `Introducing: ${nextItem.name}`,
      startTime: now,
    };

    meeting.current = {
      agendaItemId: nextItem.id,
      agendaItemStartTime: now,
      speaker,
      // Topic is cleared on agenda advance — "reply" isn't available until
      // someone actually introduces a topic via the queue.
      topic: undefined,
      topicSpeakers: [introSpeaker],
    };

    // Queue is wiped (new agenda item) and re-opened.
    meeting.queue = {
      entries: {},
      orderedIds: [],
      closed: false,
    };

    this.markDirty(meetingId);
    return nextItem;
  }

  // -- Queue mutations --

  /**
   * Add a new entry to the speaker queue. The entry is inserted at the
   * correct position based on type priority (point-of-order > question >
   * reply > topic). Within the same type, entries are ordered FIFO.
   *
   * Returns the created entry, or null if the meeting doesn't exist.
   */
  addQueueEntry(meetingId: string, type: QueueEntryType, topic: string, user: User): QueueEntry | null {
    const meeting = this.meetings.get(meetingId);
    if (!meeting) return null;

    const entry: QueueEntry = {
      id: randomUUID(),
      type,
      topic,
      userId: ensureUser(meeting, user),
    };

    meeting.queue.entries[entry.id] = entry;

    // Find the correct insertion position: after all entries of the same
    // or higher priority type, maintaining FIFO within each type.
    const entryPriority = QUEUE_ENTRY_PRIORITY[type];
    let insertIndex = meeting.queue.orderedIds.length; // default: end
    for (let i = 0; i < meeting.queue.orderedIds.length; i++) {
      const existing = meeting.queue.entries[meeting.queue.orderedIds[i]];
      const existingPriority = QUEUE_ENTRY_PRIORITY[existing.type];
      if (existingPriority > entryPriority) {
        // Found an entry with lower priority — insert before it
        insertIndex = i;
        break;
      }
    }

    meeting.queue.orderedIds.splice(insertIndex, 0, entry.id);
    this.markDirty(meetingId);
    return entry;
  }

  /**
   * Edit an existing queue entry. Only the provided fields are updated;
   * omitted fields are left unchanged. Returns true if the entry was
   * found and updated.
   */
  editQueueEntry(meetingId: string, entryId: string, updates: { topic?: string; type?: QueueEntryType }): boolean {
    const meeting = this.meetings.get(meetingId);
    if (!meeting) return false;

    const entry = meeting.queue.entries[entryId];
    if (!entry) return false;

    if (updates.topic !== undefined) entry.topic = updates.topic;
    if (updates.type !== undefined) entry.type = updates.type;

    this.markDirty(meetingId);
    return true;
  }

  /**
   * Remove an entry from the speaker queue.
   * Returns true if the entry was found and removed.
   */
  removeQueueEntry(meetingId: string, entryId: string): boolean {
    const meeting = this.meetings.get(meetingId);
    if (!meeting) return false;

    const index = meeting.queue.orderedIds.indexOf(entryId);
    if (index === -1) return false;

    meeting.queue.orderedIds.splice(index, 1);
    delete meeting.queue.entries[entryId];

    this.markDirty(meetingId);
    return true;
  }

  /** Open or close the queue to new entries from non-chair users. */
  setQueueClosed(meetingId: string, closed: boolean): boolean {
    const meeting = this.meetings.get(meetingId);
    if (!meeting) return false;
    meeting.queue.closed = closed;
    this.markDirty(meetingId);
    return true;
  }

  /**
   * Find a queue entry by ID.
   * Returns the entry, or undefined if not found.
   */
  getQueueEntry(meetingId: string, entryId: string): QueueEntry | undefined {
    const meeting = this.meetings.get(meetingId);
    if (!meeting) return undefined;
    return meeting.queue.entries[entryId];
  }

  /**
   * Advance to the next speaker. Pops the first entry from the queue,
   * snapshots it into `current.speaker`, and removes it from `queue.entries`
   * (the struct is now the sole reference).
   *
   * - If the entry type is "topic", it also becomes the current topic.
   * - If the queue is empty, clears the current speaker (returns null).
   *
   * Returns the new current speaker struct, or null if the queue was empty.
   */
  nextSpeaker(meetingId: string): CurrentSpeaker | null {
    const meeting = this.meetings.get(meetingId);
    if (!meeting) return null;

    if (meeting.queue.orderedIds.length === 0) {
      // Queue is empty — clear the current speaker
      meeting.current.speaker = undefined;
      this.markDirty(meetingId);
      return null;
    }

    // Pop the first entry from the queue and remove it from the entries map —
    // the CurrentSpeaker struct now holds all the info we need.
    const entryId = meeting.queue.orderedIds.shift()!;
    const entry = meeting.queue.entries[entryId];
    delete meeting.queue.entries[entryId];

    const now = new Date().toISOString();
    const speaker: CurrentSpeaker = {
      id: entryId,
      type: entry.type,
      topic: entry.topic,
      userId: entry.userId,
      source: 'queue',
      startTime: now,
    };

    meeting.current.speaker = speaker;

    // If this is a new topic, update the current topic
    if (entry.type === 'topic') {
      meeting.current.topic = {
        speakerId: speaker.id,
        userId: entry.userId,
        topic: entry.topic,
        startTime: now,
      };
    }

    this.markDirty(meetingId);
    return speaker;
  }

  /**
   * Reorder a queue entry by moving it to the position after another entry.
   *
   * Uses item UUIDs rather than indices to avoid race conditions (same
   * approach as agenda reordering). If `afterId` is null, the entry is
   * moved to the beginning of the queue.
   *
   * When an entry crosses a type priority boundary, its type is changed
   * to match its neighbours at the new position. The new type is
   * determined by looking at the entry immediately after the new position
   * (or immediately before if inserted at the end). This allows chairs
   * to override the automatic priority ordering.
   *
   * Returns true if the reorder was valid and applied.
   */
  reorderQueueEntry(meetingId: string, entryId: string, afterId: string | null): boolean {
    const meeting = this.meetings.get(meetingId);
    if (!meeting) return false;

    // Find and remove the entry being moved
    const entryIndex = meeting.queue.orderedIds.indexOf(entryId);
    if (entryIndex === -1) return false;

    const entry = meeting.queue.entries[entryId];
    meeting.queue.orderedIds.splice(entryIndex, 1);

    if (afterId === null) {
      // Move to the beginning of the queue
      meeting.queue.orderedIds.unshift(entryId);
    } else {
      // Find the "after" entry in the (now shorter) array
      const afterIndex = meeting.queue.orderedIds.indexOf(afterId);
      if (afterIndex === -1) {
        // afterId not found — put the entry back and report failure
        meeting.queue.orderedIds.splice(entryIndex, 0, entryId);
        return false;
      }
      // Insert immediately after the "after" entry
      meeting.queue.orderedIds.splice(afterIndex + 1, 0, entryId);
    }

    // Determine the new position and whether the entry moved up or down
    const newIndex = meeting.queue.orderedIds.indexOf(entryId);
    const movedDown = newIndex > entryIndex;

    // Change the entry's type based on its direction of movement:
    // - Moving down: adopt the lowest priority (highest number) of the
    //   items at or above it (including itself), so it doesn't outrank
    //   what's before it.
    // - Moving up: adopt the highest priority (lowest number) of the
    //   items at or below it (including itself), so it doesn't underrank
    //   what's after it.
    if (meeting.queue.orderedIds.length > 1) {
      if (movedDown) {
        // Items at and above the new position (indices 0..newIndex)
        const idsAtAndAbove = meeting.queue.orderedIds.slice(0, newIndex + 1);
        // Lowest priority = highest priority number
        let lowestType = entry.type;
        for (const id of idsAtAndAbove) {
          const e = meeting.queue.entries[id];
          if (QUEUE_ENTRY_PRIORITY[e.type] > QUEUE_ENTRY_PRIORITY[lowestType]) {
            lowestType = e.type;
          }
        }
        entry.type = lowestType;
      } else {
        // Items at and below the new position (indices newIndex..end)
        const idsAtAndBelow = meeting.queue.orderedIds.slice(newIndex);
        // Highest priority = lowest priority number
        let highestType = entry.type;
        for (const id of idsAtAndBelow) {
          const e = meeting.queue.entries[id];
          if (QUEUE_ENTRY_PRIORITY[e.type] < QUEUE_ENTRY_PRIORITY[highestType]) {
            highestType = e.type;
          }
        }
        entry.type = highestType;
      }
    }

    this.markDirty(meetingId);
    return true;
  }

  // -- Poll mutations --

  /**
   * Start a poll with custom options. Populates `meeting.poll` with the
   * given options (each assigned a unique UUID), start time, chair, topic,
   * and selection mode. Any pre-existing poll is replaced.
   */
  startPoll(
    meetingId: string,
    options: { emoji: string; label: string }[],
    startChairId: UserKey,
    topic: string | undefined,
    multiSelect: boolean,
  ): boolean {
    const meeting = this.meetings.get(meetingId);
    if (!meeting) return false;

    meeting.poll = {
      options: options.map((opt) => ({
        id: randomUUID(),
        emoji: opt.emoji,
        label: opt.label,
      })),
      reactions: [],
      startTime: new Date().toISOString(),
      startChairId,
      topic,
      multiSelect,
    };
    this.markDirty(meetingId);
    return true;
  }

  /**
   * Stop the active poll. Clears `meeting.poll`.
   */
  stopPoll(meetingId: string): boolean {
    const meeting = this.meetings.get(meetingId);
    if (!meeting) return false;

    meeting.poll = undefined;
    this.markDirty(meetingId);
    return true;
  }

  /**
   * Toggle a reaction for a user on a specific poll option.
   * If the user already reacted to this option, the reaction is removed.
   * If they haven't, a reaction is added.
   *
   * In multi-select mode (default), each user can react to each option
   * at most once. In single-select mode, selecting a new option removes
   * any previous selection by that user.
   *
   * Returns false if the meeting doesn't exist, no poll is active, or
   * the option ID is invalid.
   */
  toggleReaction(meetingId: string, optionId: string, user: User): boolean {
    const meeting = this.meetings.get(meetingId);
    if (!meeting || !meeting.poll) return false;

    const poll = meeting.poll;
    if (!poll.options.some((o) => o.id === optionId)) return false;

    const key = ensureUser(meeting, user);

    const existingIndex = poll.reactions.findIndex((r) => r.optionId === optionId && r.userId === key);

    if (existingIndex !== -1) {
      // Remove it (toggle off)
      poll.reactions.splice(existingIndex, 1);
    } else {
      // In single-select mode, remove any existing reaction by this user first
      if (!poll.multiSelect) {
        poll.reactions = poll.reactions.filter((r) => r.userId !== key);
      }
      poll.reactions.push({ optionId, userId: key });
    }

    this.markDirty(meetingId);
    return true;
  }

  /**
   * Write all dirty meetings to the persistent store.
   * Called periodically and after significant events.
   *
   * Returns the number of meetings written, so callers (the periodic
   * timer) can skip emitting a log entry when there was nothing to do.
   */
  async sync(): Promise<number> {
    const promises: Promise<void>[] = [];

    for (const id of this.dirty) {
      const meeting = this.meetings.get(id);
      if (meeting) {
        promises.push(this.store.save(meeting));
      }
    }

    await Promise.all(promises);
    const count = promises.length;
    this.dirty.clear();
    return count;
  }

  /**
   * Persist a single meeting immediately (for high-value mutations
   * like agenda advancement or speaker changes).
   */
  async syncOne(id: string): Promise<void> {
    const meeting = this.meetings.get(id);
    if (meeting) {
      await this.store.save(meeting);
      this.dirty.delete(id);
    }
  }

  /**
   * Start a periodic sync interval. Returns a cleanup function
   * that stops the interval.
   */
  startPeriodicSync(intervalMs = 30_000): () => void {
    const timer = setInterval(() => {
      const start = process.hrtime.bigint();
      this.sync()
        .then((count) => {
          // Skip the log when there was nothing to sync — otherwise we'd
          // emit a no-op line every 30 s on an idle server.
          if (count > 0) {
            const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
            info('periodic_sync_completed', { count, durationMs });
          }
        })
        .catch((err) => {
          logError('periodic_sync_failed', { error: serialiseError(err) });
        });
    }, intervalMs);

    return () => clearInterval(timer);
  }

  /**
   * Start a periodic sweep that removes expired meetings (no connection
   * in the last 90 days). Runs once per hour. Returns a cleanup function
   * that stops the interval.
   */
  startExpirySweep(intervalMs = 60 * 60 * 1000): () => void {
    const timer = setInterval(() => {
      const start = process.hrtime.bigint();
      this.removeExpiredMeetings()
        .then(({ scanned, expired }) => {
          const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
          info('expiry_sweep_completed', { scanned, expired, durationMs });
        })
        .catch((err) => {
          logError('expiry_sweep_failed', { error: serialiseError(err) });
        });
    }, intervalMs);

    return () => clearInterval(timer);
  }

  /** Remove all meetings whose last connection is older than 90 days. */
  private async removeExpiredMeetings(): Promise<{ scanned: number; expired: number }> {
    const now = Date.now();
    const expiredIds: string[] = [];
    let scanned = 0;

    for (const meeting of this.meetings.values()) {
      scanned++;
      if (this.isExpired(meeting, now)) {
        expiredIds.push(meeting.id);
      }
    }

    for (const id of expiredIds) {
      const meeting = this.meetings.get(id)!;
      const lastConnectionTime = meeting.operational.lastConnectionTime;
      const ageDays = Math.floor((now - new Date(lastConnectionTime).getTime()) / (24 * 60 * 60 * 1000));
      notice('meeting_expired', {
        meetingId: id,
        lastConnectionTime,
        ageDays,
      });
      await this.remove(id);
    }

    return { scanned, expired: expiredIds.length };
  }

  /**
   * Check whether a meeting has expired. A meeting expires 90 days after
   * its most recent connection.
   */
  private isExpired(meeting: MeetingState, now: number): boolean {
    const lastConnection = new Date(meeting.operational.lastConnectionTime).getTime();
    return now - lastConnection > MEETING_EXPIRY_MS;
  }
}
