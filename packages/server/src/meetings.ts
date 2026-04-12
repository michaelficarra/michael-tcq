import { randomUUID } from 'node:crypto';
import type { MeetingState, AgendaItem, User } from '@tcq/shared';
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
