import { randomUUID } from 'node:crypto';
import type { MeetingState, AgendaItem, QueueEntry, QueueEntryType, User } from '@tcq/shared';
import { QUEUE_ENTRY_PRIORITY, userKey } from '@tcq/shared';
import type { MeetingStore } from './store.js';
import { generateMeetingId } from './meetingId.js';

/**
 * Register a user in a meeting's users map, returning their canonical key.
 * Always updates the stored user so name/organisation changes are picked up.
 */
export function ensureUser(meeting: MeetingState, user: User): string {
  const key = userKey(user);
  meeting.users[key] = user;
  return key;
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
        migrateLegacyMeeting(meeting);
        // Default queueClosed for meetings persisted before this field existed
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- migration for legacy persisted data
        if ((meeting as any).queueClosed === undefined) meeting.queueClosed = false;
        this.meetings.set(meeting.id, meeting);
      }
    }

    if (expired > 0) {
      console.log(`Removed ${expired} expired meeting(s) from store`);
    }
    if (this.meetings.size > 0) {
      console.log(`Restored ${this.meetings.size} meeting(s) from store`);
    }
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

    const meeting: MeetingState = {
      id,
      users,
      chairIds,
      agenda: [],
      currentAgendaItemId: undefined,
      currentSpeakerEntryId: undefined,
      currentTopicEntryId: undefined,
      queueEntries: {},
      queuedSpeakerIds: [],
      queueClosed: true,
      reactions: [],
      trackPoll: false,
      pollOptions: [],
      version: 0,
      lastConnectionTime: new Date().toISOString(),
      log: [],
      currentTopicSpeakers: [],
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
    if (!meeting?.currentAgendaItemId) return undefined;
    return meeting.agenda.find((item) => item.id === meeting.currentAgendaItemId);
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

  /**
   * Mark a meeting as having unsaved changes and bump its version.
   * Every mutation calls this, so the version counter tracks all changes.
   * Used by advancement events to detect stale concurrent requests.
   */
  markDirty(id: string): void {
    this.dirty.add(id);
    const meeting = this.meetings.get(id);
    if (meeting) {
      meeting.version++;
    }
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
   * Add a new agenda item to a meeting.
   * Returns the created item, or null if the meeting doesn't exist.
   */
  addAgendaItem(meetingId: string, name: string, owner: User, timebox?: number): AgendaItem | null {
    const meeting = this.meetings.get(meetingId);
    if (!meeting) return null;

    const item: AgendaItem = {
      id: randomUUID(),
      name,
      ownerId: ensureUser(meeting, owner),
      timebox,
    };

    meeting.agenda.push(item);
    this.markDirty(meetingId);
    return item;
  }

  /**
   * Edit an existing agenda item. Only the provided fields are updated;
   * omitted fields are left unchanged. Pass `timebox: null` to clear
   * the timebox. Returns true if the item was found and updated.
   */
  editAgendaItem(
    meetingId: string,
    itemId: string,
    updates: { name?: string; owner?: User; timebox?: number | null },
  ): boolean {
    const meeting = this.meetings.get(meetingId);
    if (!meeting) return false;

    const item = meeting.agenda.find((i) => i.id === itemId);
    if (!item) return false;

    if (updates.name !== undefined) item.name = updates.name;
    if (updates.owner !== undefined) item.ownerId = ensureUser(meeting, updates.owner);
    if (updates.timebox === null) {
      item.timebox = undefined;
    } else if (updates.timebox !== undefined) {
      item.timebox = updates.timebox;
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

    const index = meeting.agenda.findIndex((item) => item.id === itemId);
    if (index === -1) return false;

    meeting.agenda.splice(index, 1);

    // If the deleted item was the current agenda item, clear the reference
    if (meeting.currentAgendaItemId === itemId) {
      meeting.currentAgendaItemId = undefined;
    }

    this.markDirty(meetingId);
    return true;
  }

  /**
   * Reorder an agenda item by moving it to the position after another item.
   *
   * Uses item UUIDs rather than indices to avoid race conditions when
   * two chairs reorder simultaneously. If `afterId` is null, the item
   * is moved to the beginning of the agenda.
   *
   * Returns true if the reorder was valid and applied.
   */
  reorderAgendaItem(meetingId: string, itemId: string, afterId: string | null): boolean {
    const meeting = this.meetings.get(meetingId);
    if (!meeting) return false;

    // Find and remove the item being moved
    const itemIndex = meeting.agenda.findIndex((i) => i.id === itemId);
    if (itemIndex === -1) return false;

    const [item] = meeting.agenda.splice(itemIndex, 1);

    if (afterId === null) {
      // Move to the beginning
      meeting.agenda.unshift(item);
    } else {
      // Find the "after" item in the (now shorter) array
      const afterIndex = meeting.agenda.findIndex((i) => i.id === afterId);
      if (afterIndex === -1) {
        // afterId not found — put the item back and report failure
        meeting.agenda.splice(itemIndex, 0, item);
        return false;
      }
      // Insert immediately after the "after" item
      meeting.agenda.splice(afterIndex + 1, 0, item);
    }

    this.markDirty(meetingId);
    return true;
  }

  // -- Meeting flow mutations --

  /**
   * Advance to the next agenda item. If no current agenda item is set,
   * this starts the meeting by setting the first item. Otherwise it
   * advances to the next item in the list.
   *
   * When advancing, the agenda item's owner becomes the current speaker
   * with a topic of "Introducing: <item name>". The current topic and
   * queue are cleared since we're starting a new agenda item.
   *
   * Returns the new current agenda item, or null if there's nothing to
   * advance to (e.g. we're past the last item, or agenda is empty).
   */
  nextAgendaItem(meetingId: string): AgendaItem | null {
    const meeting = this.meetings.get(meetingId);
    if (!meeting) return null;

    if (meeting.agenda.length === 0) return null;

    let nextIndex: number;

    if (!meeting.currentAgendaItemId) {
      // No current item — start with the first one
      nextIndex = 0;
    } else {
      // Find the current item's position and advance to the next
      const currentIndex = meeting.agenda.findIndex((item) => item.id === meeting.currentAgendaItemId);
      nextIndex = currentIndex + 1;
    }

    // Check if we've gone past the end of the agenda
    if (nextIndex >= meeting.agenda.length) return null;

    const nextItem = meeting.agenda[nextIndex];
    meeting.currentAgendaItemId = nextItem.id;

    // The item owner becomes the current speaker
    const speakerEntry: QueueEntry = {
      id: randomUUID(),
      type: 'topic',
      topic: `Introducing: ${nextItem.name}`,
      userId: nextItem.ownerId,
    };

    // Clear queue entries and start fresh for the new agenda item
    meeting.queueEntries = { [speakerEntry.id]: speakerEntry };
    meeting.queuedSpeakerIds = [];
    meeting.currentSpeakerEntryId = speakerEntry.id;

    // Clear the current topic for the new agenda item
    meeting.currentTopicEntryId = undefined;

    // Re-open the queue for the new agenda item
    meeting.queueClosed = false;

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

    // Add to the lookup map
    meeting.queueEntries[entry.id] = entry;

    // Find the correct insertion position: after all entries of the same
    // or higher priority type, maintaining FIFO within each type.
    const entryPriority = QUEUE_ENTRY_PRIORITY[type];
    let insertIndex = meeting.queuedSpeakerIds.length; // default: end
    for (let i = 0; i < meeting.queuedSpeakerIds.length; i++) {
      const existing = meeting.queueEntries[meeting.queuedSpeakerIds[i]];
      const existingPriority = QUEUE_ENTRY_PRIORITY[existing.type];
      if (existingPriority > entryPriority) {
        // Found an entry with lower priority — insert before it
        insertIndex = i;
        break;
      }
    }

    meeting.queuedSpeakerIds.splice(insertIndex, 0, entry.id);
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

    const entry = meeting.queueEntries[entryId];
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

    const index = meeting.queuedSpeakerIds.indexOf(entryId);
    if (index === -1) return false;

    meeting.queuedSpeakerIds.splice(index, 1);
    delete meeting.queueEntries[entryId];

    this.markDirty(meetingId);
    return true;
  }

  /** Open or close the queue to new entries from non-chair users. */
  setQueueClosed(meetingId: string, closed: boolean): boolean {
    const meeting = this.meetings.get(meetingId);
    if (!meeting) return false;
    meeting.queueClosed = closed;
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
    return meeting.queueEntries[entryId];
  }

  /**
   * Advance to the next speaker. Pops the first entry from the queue
   * and makes that person the current speaker.
   *
   * - If the entry type is "topic", it also becomes the currentTopic.
   * - If the queue is empty, clears the current speaker (returns null).
   *
   * Returns the new current speaker entry, or null if queue was empty.
   */
  nextSpeaker(meetingId: string): QueueEntry | null {
    const meeting = this.meetings.get(meetingId);
    if (!meeting) return null;

    if (meeting.queuedSpeakerIds.length === 0) {
      // Queue is empty — clear the current speaker
      meeting.currentSpeakerEntryId = undefined;
      this.markDirty(meetingId);
      return null;
    }

    // Pop the first entry from the queue
    const entryId = meeting.queuedSpeakerIds.shift()!;
    const entry = meeting.queueEntries[entryId];
    meeting.currentSpeakerEntryId = entryId;

    // If this is a new topic, update the current topic
    if (entry.type === 'topic') {
      meeting.currentTopicEntryId = entryId;
    }

    this.markDirty(meetingId);
    return entry;
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
    const entryIndex = meeting.queuedSpeakerIds.indexOf(entryId);
    if (entryIndex === -1) return false;

    const entry = meeting.queueEntries[entryId];
    meeting.queuedSpeakerIds.splice(entryIndex, 1);

    if (afterId === null) {
      // Move to the beginning of the queue
      meeting.queuedSpeakerIds.unshift(entryId);
    } else {
      // Find the "after" entry in the (now shorter) array
      const afterIndex = meeting.queuedSpeakerIds.indexOf(afterId);
      if (afterIndex === -1) {
        // afterId not found — put the entry back and report failure
        meeting.queuedSpeakerIds.splice(entryIndex, 0, entryId);
        return false;
      }
      // Insert immediately after the "after" entry
      meeting.queuedSpeakerIds.splice(afterIndex + 1, 0, entryId);
    }

    // Determine the new position and whether the entry moved up or down
    const newIndex = meeting.queuedSpeakerIds.indexOf(entryId);
    const movedDown = newIndex > entryIndex;

    // Change the entry's type based on its direction of movement:
    // - Moving down: adopt the lowest priority (highest number) of the
    //   items at or above it (including itself), so it doesn't outrank
    //   what's before it.
    // - Moving up: adopt the highest priority (lowest number) of the
    //   items at or below it (including itself), so it doesn't underrank
    //   what's after it.
    if (meeting.queuedSpeakerIds.length > 1) {
      if (movedDown) {
        // Items at and above the new position (indices 0..newIndex)
        const idsAtAndAbove = meeting.queuedSpeakerIds.slice(0, newIndex + 1);
        // Lowest priority = highest priority number
        let lowestType = entry.type;
        for (const id of idsAtAndAbove) {
          const e = meeting.queueEntries[id];
          if (QUEUE_ENTRY_PRIORITY[e.type] > QUEUE_ENTRY_PRIORITY[lowestType]) {
            lowestType = e.type;
          }
        }
        entry.type = lowestType;
      } else {
        // Items at and below the new position (indices newIndex..end)
        const idsAtAndBelow = meeting.queuedSpeakerIds.slice(newIndex);
        // Highest priority = lowest priority number
        let highestType = entry.type;
        for (const id of idsAtAndBelow) {
          const e = meeting.queueEntries[id];
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
   * Start a poll with custom options. Sets trackPoll
   * to true, stores the options, and clears any existing reactions.
   * Each option gets a unique UUID assigned by the server.
   */
  startPoll(meetingId: string, options: { emoji: string; label: string }[]): boolean {
    const meeting = this.meetings.get(meetingId);
    if (!meeting) return false;

    // Assign unique IDs to each option
    meeting.pollOptions = options.map((opt) => ({
      id: randomUUID(),
      emoji: opt.emoji,
      label: opt.label,
    }));
    meeting.trackPoll = true;
    meeting.reactions = [];
    this.markDirty(meetingId);
    return true;
  }

  /**
   * Stop a poll. Sets trackPoll to false and clears
   * all reactions and options.
   */
  stopPoll(meetingId: string): boolean {
    const meeting = this.meetings.get(meetingId);
    if (!meeting) return false;

    meeting.trackPoll = false;
    meeting.pollOptions = [];
    meeting.reactions = [];
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
   * Returns false if the meeting doesn't exist, poll
   * is not active, or the option ID is invalid.
   */
  toggleReaction(meetingId: string, optionId: string, user: User): boolean {
    const meeting = this.meetings.get(meetingId);
    if (!meeting) return false;
    if (!meeting.trackPoll) return false;

    // Validate that the option exists
    const optionExists = meeting.pollOptions.some((o) => o.id === optionId);
    if (!optionExists) return false;

    const key = ensureUser(meeting, user);

    // Check if the user already reacted to this option
    const existingIndex = meeting.reactions.findIndex((r) => r.optionId === optionId && r.userId === key);

    if (existingIndex !== -1) {
      // Remove it (toggle off)
      meeting.reactions.splice(existingIndex, 1);
    } else {
      // In single-select mode, remove any existing reaction by this user first
      if (!meeting.pollMultiSelect) {
        meeting.reactions = meeting.reactions.filter((r) => r.userId !== key);
      }
      // Add it (toggle on)
      meeting.reactions.push({ optionId, userId: key });
    }

    this.markDirty(meetingId);
    return true;
  }

  /**
   * Write all dirty meetings to the persistent store.
   * Called periodically and after significant events.
   */
  async sync(): Promise<void> {
    const promises: Promise<void>[] = [];

    for (const id of this.dirty) {
      const meeting = this.meetings.get(id);
      if (meeting) {
        promises.push(this.store.save(meeting));
      }
    }

    await Promise.all(promises);
    this.dirty.clear();
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
      this.sync().catch((err) => {
        console.error('Periodic sync failed:', err);
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
      this.removeExpiredMeetings().catch((err) => {
        console.error('Expiry sweep failed:', err);
      });
    }, intervalMs);

    return () => clearInterval(timer);
  }

  /** Remove all meetings whose last connection is older than 90 days. */
  private async removeExpiredMeetings(): Promise<void> {
    const now = Date.now();
    const expiredIds: string[] = [];

    for (const meeting of this.meetings.values()) {
      if (this.isExpired(meeting, now)) {
        expiredIds.push(meeting.id);
      }
    }

    for (const id of expiredIds) {
      console.log(`Expiring meeting ${id} (no connections in 90 days)`);
      await this.remove(id);
    }
  }

  /**
   * Check whether a meeting has expired. A meeting expires 90 days after
   * its most recent connection. Meetings without a lastConnectionTime
   * (created before this feature) are not considered expired.
   */
  private isExpired(meeting: MeetingState, now: number): boolean {
    if (!meeting.lastConnectionTime) return false;
    const lastConnection = new Date(meeting.lastConnectionTime).getTime();
    return now - lastConnection > MEETING_EXPIRY_MS;
  }
}

// -- Legacy migration --

/**
 * Migrate a meeting from the legacy format (inline User/QueueEntry objects)
 * to the normalised format (ID references with lookup maps).
 * Detects legacy format by checking for the absence of the `users` field.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
function migrateLegacyMeeting(meeting: MeetingState): void {
  const m = meeting as any;

  // Already migrated (or new format)
  if (meeting.users && typeof meeting.users === 'object' && !Array.isArray(meeting.users)) {
    // Handle partial migration from the previous currentAgendaItem → currentAgendaItemId change
    if (m.currentAgendaItem && !meeting.currentAgendaItemId) {
      meeting.currentAgendaItemId = m.currentAgendaItem.id;
      delete m.currentAgendaItem;
    }
    return;
  }

  const users: Record<string, User> = {};
  const eu = (u: User): string => {
    const key = userKey(u);
    users[key] = u;
    return key;
  };

  // Chairs: User[] → string[]
  if (Array.isArray(m.chairs) && m.chairs.length > 0 && typeof m.chairs[0] === 'object' && m.chairs[0].ghUsername) {
    meeting.chairIds = m.chairs.map((c: User) => eu(c));
  }
  delete m.chairs;

  // Agenda items: owner → ownerId
  for (const item of meeting.agenda) {
    if ((item as any).owner && typeof (item as any).owner === 'object') {
      (item as any).ownerId = eu((item as any).owner);
      delete (item as any).owner;
    }
  }

  // currentAgendaItem → currentAgendaItemId
  if (m.currentAgendaItem && !meeting.currentAgendaItemId) {
    meeting.currentAgendaItemId = m.currentAgendaItem.id;
    delete m.currentAgendaItem;
  }

  // Queue entries: queuedSpeakers → queueEntries + queuedSpeakerIds
  const queueEntries: Record<string, QueueEntry> = {};
  if (Array.isArray(m.queuedSpeakers)) {
    meeting.queuedSpeakerIds = [];
    for (const entry of m.queuedSpeakers) {
      if (entry.user && typeof entry.user === 'object') {
        entry.userId = eu(entry.user);
        delete entry.user;
      }
      queueEntries[entry.id] = entry;
      meeting.queuedSpeakerIds.push(entry.id);
    }
    delete m.queuedSpeakers;
  }

  // currentSpeaker → currentSpeakerEntryId
  if (m.currentSpeaker && typeof m.currentSpeaker === 'object' && m.currentSpeaker.id) {
    const cs = m.currentSpeaker;
    if (cs.user && typeof cs.user === 'object') {
      cs.userId = eu(cs.user);
      delete cs.user;
    }
    queueEntries[cs.id] = cs;
    meeting.currentSpeakerEntryId = cs.id;
    delete m.currentSpeaker;
  }

  // currentTopic → currentTopicEntryId
  if (m.currentTopic && typeof m.currentTopic === 'object' && m.currentTopic.id) {
    const ct = m.currentTopic;
    if (ct.user && typeof ct.user === 'object') {
      ct.userId = eu(ct.user);
      delete ct.user;
    }
    queueEntries[ct.id] = ct;
    meeting.currentTopicEntryId = ct.id;
    delete m.currentTopic;
  }

  meeting.queueEntries = queueEntries;

  // Reactions: user → userId
  if (Array.isArray(meeting.reactions)) {
    for (const r of meeting.reactions) {
      if ((r as any).user && typeof (r as any).user === 'object') {
        (r as any).userId = eu((r as any).user);
        delete (r as any).user;
      }
    }
  }

  // TopicSpeakers: user → userId
  if (Array.isArray(meeting.currentTopicSpeakers)) {
    for (const s of meeting.currentTopicSpeakers) {
      if ((s as any).user && typeof (s as any).user === 'object') {
        (s as any).userId = eu((s as any).user);
        delete (s as any).user;
      }
    }
  }

  // Log entries
  for (const entry of meeting.log) {
    migrateLogEntry(entry, eu);
  }

  // pollStartChair → pollStartChairId
  if (m.pollStartChair && typeof m.pollStartChair === 'object') {
    meeting.pollStartChairId = eu(m.pollStartChair);
    delete m.pollStartChair;
  }

  meeting.users = users;
}

/** Migrate a single log entry from inline User objects to user ID references. */
function migrateLogEntry(entry: any, eu: (u: User) => string): void {
  // Common: chair → chairId
  if (entry.chair && typeof entry.chair === 'object') {
    entry.chairId = eu(entry.chair);
    delete entry.chair;
  }

  switch (entry.type) {
    case 'agenda-item-started':
      if (entry.itemOwner && typeof entry.itemOwner === 'object') {
        entry.itemOwnerId = eu(entry.itemOwner);
        delete entry.itemOwner;
      }
      break;
    case 'agenda-item-finished':
      if (
        Array.isArray(entry.participants) &&
        entry.participants.length > 0 &&
        typeof entry.participants[0] === 'object'
      ) {
        entry.participantIds = entry.participants.map((p: User) => eu(p));
        delete entry.participants;
      }
      break;
    case 'topic-discussed':
      if (Array.isArray(entry.speakers)) {
        for (const s of entry.speakers) {
          if (s.user && typeof s.user === 'object') {
            s.userId = eu(s.user);
            delete s.user;
          }
        }
      }
      break;
    case 'poll-ran':
      if (entry.startChair && typeof entry.startChair === 'object') {
        entry.startChairId = eu(entry.startChair);
        delete entry.startChair;
      }
      if (entry.endChair && typeof entry.endChair === 'object') {
        entry.endChairId = eu(entry.endChair);
        delete entry.endChair;
      }
      break;
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
