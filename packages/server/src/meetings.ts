import { randomUUID } from 'node:crypto';
import type { MeetingState, AgendaItem, QueueEntry, QueueEntryType, User } from '@tcq/shared';
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
    return meeting.chairs.some((chair) => chair.ghid === user.ghid);
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
