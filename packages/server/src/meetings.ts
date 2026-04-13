import { randomUUID } from 'node:crypto';
import type { MeetingState, AgendaItem, QueueEntry, QueueEntryType, ReactionType, User } from '@tcq/shared';
import { QUEUE_ENTRY_PRIORITY } from '@tcq/shared';
import type { MeetingStore } from './store.js';
import { generateMeetingId } from './meetingId.js';

/**
 * Manages the in-memory map of active meetings and coordinates with
 * the persistent store for durability.
 *
 * All reads and mutations go through this class. The persistent store
 * is written to periodically (see `startPeriodicSync`) and on
 * significant events.
 */
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
    for (const meeting of meetings) {
      this.meetings.set(meeting.id, meeting);
    }
    if (meetings.length > 0) {
      console.log(`Restored ${meetings.length} meeting(s) from store`);
    }
  }

  /** Create a new meeting with the given chairs. */
  create(chairs: User[]): MeetingState {
    const id = generateMeetingId((candidate) => this.meetings.has(candidate));

    const meeting: MeetingState = {
      id,
      chairs,
      agenda: [],
      currentAgendaItem: undefined,
      currentSpeaker: undefined,
      currentTopic: undefined,
      queuedSpeakers: [],
      reactions: [],
      trackTemperature: false,
      version: 0,
    };

    this.meetings.set(id, meeting);
    this.markDirty(id);
    return meeting;
  }

  /** Get a meeting by ID, or undefined if it doesn't exist. */
  get(id: string): MeetingState | undefined {
    return this.meetings.get(id);
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
    // Compare by username (case-insensitive) since chairs are specified
    // by GitHub username, and it's the stable identifier throughout the app.
    return meeting.chairs.some(
      (chair) => chair.ghUsername.toLowerCase() === user.ghUsername.toLowerCase(),
    );
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
      owner,
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
    if (updates.owner !== undefined) item.owner = updates.owner;
    if (updates.timebox === null) {
      item.timebox = undefined;
    } else if (updates.timebox !== undefined) {
      item.timebox = updates.timebox;
    }

    // If this item is the current agenda item, update that reference too
    if (meeting.currentAgendaItem?.id === itemId) {
      meeting.currentAgendaItem = item;
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

    if (!meeting.currentAgendaItem) {
      // No current item — start with the first one
      nextIndex = 0;
    } else {
      // Find the current item's position and advance to the next
      const currentIndex = meeting.agenda.findIndex(
        (item) => item.id === meeting.currentAgendaItem!.id,
      );
      nextIndex = currentIndex + 1;
    }

    // Check if we've gone past the end of the agenda
    if (nextIndex >= meeting.agenda.length) return null;

    const nextItem = meeting.agenda[nextIndex];
    meeting.currentAgendaItem = nextItem;

    // The item owner becomes the current speaker
    meeting.currentSpeaker = {
      id: randomUUID(),
      type: 'topic',
      topic: `Introducing: ${nextItem.name}`,
      user: nextItem.owner,
    };

    // Clear the current topic and queue for the new agenda item
    meeting.currentTopic = undefined;
    meeting.queuedSpeakers = [];

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
  addQueueEntry(
    meetingId: string,
    type: QueueEntryType,
    topic: string,
    user: User,
  ): QueueEntry | null {
    const meeting = this.meetings.get(meetingId);
    if (!meeting) return null;

    const entry: QueueEntry = {
      id: randomUUID(),
      type,
      topic,
      user,
    };

    // Find the correct insertion position: after all entries of the same
    // or higher priority type, maintaining FIFO within each type.
    const entryPriority = QUEUE_ENTRY_PRIORITY[type];
    let insertIndex = meeting.queuedSpeakers.length; // default: end
    for (let i = 0; i < meeting.queuedSpeakers.length; i++) {
      const existingPriority = QUEUE_ENTRY_PRIORITY[meeting.queuedSpeakers[i].type];
      if (existingPriority > entryPriority) {
        // Found an entry with lower priority — insert before it
        insertIndex = i;
        break;
      }
    }

    meeting.queuedSpeakers.splice(insertIndex, 0, entry);
    this.markDirty(meetingId);
    return entry;
  }

  /**
   * Edit an existing queue entry. Only the provided fields are updated;
   * omitted fields are left unchanged. Returns true if the entry was
   * found and updated.
   */
  editQueueEntry(
    meetingId: string,
    entryId: string,
    updates: { topic?: string; type?: QueueEntryType },
  ): boolean {
    const meeting = this.meetings.get(meetingId);
    if (!meeting) return false;

    const entry = meeting.queuedSpeakers.find((e) => e.id === entryId);
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

    const index = meeting.queuedSpeakers.findIndex((e) => e.id === entryId);
    if (index === -1) return false;

    meeting.queuedSpeakers.splice(index, 1);
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
    return meeting.queuedSpeakers.find((e) => e.id === entryId);
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

    if (meeting.queuedSpeakers.length === 0) {
      // Queue is empty — clear the current speaker
      meeting.currentSpeaker = undefined;
      this.markDirty(meetingId);
      return null;
    }

    // Pop the first entry from the queue
    const [entry] = meeting.queuedSpeakers.splice(0, 1);
    meeting.currentSpeaker = entry;

    // If this is a new topic, update the current topic
    if (entry.type === 'topic') {
      meeting.currentTopic = entry;
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
    const entryIndex = meeting.queuedSpeakers.findIndex((e) => e.id === entryId);
    if (entryIndex === -1) return false;

    const [entry] = meeting.queuedSpeakers.splice(entryIndex, 1);

    if (afterId === null) {
      // Move to the beginning of the queue
      meeting.queuedSpeakers.unshift(entry);
    } else {
      // Find the "after" entry in the (now shorter) array
      const afterIndex = meeting.queuedSpeakers.findIndex((e) => e.id === afterId);
      if (afterIndex === -1) {
        // afterId not found — put the entry back and report failure
        meeting.queuedSpeakers.splice(entryIndex, 0, entry);
        return false;
      }
      // Insert immediately after the "after" entry
      meeting.queuedSpeakers.splice(afterIndex + 1, 0, entry);
    }

    // Determine the new position of the moved entry
    const newIndex = meeting.queuedSpeakers.findIndex((e) => e.id === entryId);

    // Change the entry's type to match its new neighbours when it
    // crosses a type boundary. Look at the adjacent entry to determine
    // what type it should become:
    // - If there's an entry after it, use that entry's type
    // - If there's an entry before it, use that entry's type
    // - If it's the only entry, keep its original type
    const neighbour =
      meeting.queuedSpeakers[newIndex + 1] ??
      meeting.queuedSpeakers[newIndex - 1];
    if (neighbour) {
      entry.type = neighbour.type;
    }

    this.markDirty(meetingId);
    return true;
  }

  // -- Temperature check mutations --

  /**
   * Start a temperature check. Sets trackTemperature to true and clears
   * any existing reactions so we start fresh.
   */
  startTemperature(meetingId: string): boolean {
    const meeting = this.meetings.get(meetingId);
    if (!meeting) return false;

    meeting.trackTemperature = true;
    meeting.reactions = [];
    this.markDirty(meetingId);
    return true;
  }

  /**
   * Stop a temperature check. Sets trackTemperature to false and clears
   * all reactions.
   */
  stopTemperature(meetingId: string): boolean {
    const meeting = this.meetings.get(meetingId);
    if (!meeting) return false;

    meeting.trackTemperature = false;
    meeting.reactions = [];
    this.markDirty(meetingId);
    return true;
  }

  /**
   * Toggle a reaction for a user. If the user already has this reaction
   * type, it's removed. If they don't, it's added. Each user can have
   * at most one of each reaction type.
   *
   * Returns false if the meeting doesn't exist or temperature tracking
   * is not active.
   */
  toggleReaction(meetingId: string, reactionType: ReactionType, user: User): boolean {
    const meeting = this.meetings.get(meetingId);
    if (!meeting) return false;
    if (!meeting.trackTemperature) return false;

    // Check if the user already has this reaction
    const existingIndex = meeting.reactions.findIndex(
      (r) => r.reaction === reactionType && r.user.ghUsername.toLowerCase() === user.ghUsername.toLowerCase(),
    );

    if (existingIndex !== -1) {
      // Remove it (toggle off)
      meeting.reactions.splice(existingIndex, 1);
    } else {
      // Add it (toggle on)
      meeting.reactions.push({ reaction: reactionType, user });
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
}
