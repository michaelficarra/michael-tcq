import type { AgendaEntry, DirectorySuggestion } from '@tcq/shared';
import { isAgendaItem, isSession } from '@tcq/shared';
import { mapImportedPresenters } from './importAgendaEntries.js';
import type { ParsedAgendaItem } from './parseAgenda.js';
import type { MeetingManager } from './meetings.js';

/** Mutable placement state for one session header's contiguous run. */
export interface SessionSlotState {
  sessionId: string;
  /** Minutes of capacity left in this session's run. */
  remaining: number;
  /** Agenda entry id after which the next slotted item should be inserted. */
  insertAfterId: string;
}

/**
 * Derive per-session placement state from the current agenda order. Each
 * session's `remaining` is its capacity minus the run total of items that
 * follow it up to the next session header (or end). Items without a duration
 * count as 0 minutes, matching containment.
 */
export function buildSessionSlotStates(agenda: AgendaEntry[]): SessionSlotState[] {
  const slots: SessionSlotState[] = [];
  let current: SessionSlotState | null = null;
  let runTotal = 0;
  let capacity = 0;

  for (const entry of agenda) {
    if (isSession(entry)) {
      capacity = entry.capacity;
      current = {
        sessionId: entry.id,
        remaining: capacity,
        insertAfterId: entry.id,
      };
      slots.push(current);
      runTotal = 0;
    } else if (isAgendaItem(entry) && current) {
      runTotal += entry.duration ?? 0;
      current.remaining = capacity - runTotal;
      current.insertAfterId = entry.id;
    }
  }

  return slots;
}

/** First session in agenda order with enough remaining capacity, if any. */
export function findSessionSlotForDuration(
  slots: SessionSlotState[],
  durationMinutes: number,
): SessionSlotState | null {
  for (const slot of slots) {
    if (slot.remaining >= durationMinutes) return slot;
  }
  return null;
}

/**
 * Add URL-parsed agenda items to a meeting. When `slotIntoSessions` is true,
 * each imported item is inserted into the first session (in agenda order)
 * whose run still has enough remaining capacity; otherwise it is appended
 * after the current tail. Imported items keep their source order and
 * existing agenda entries are never moved.
 *
 * Items with no parsed presenters are created with an empty presenter list;
 * the chair can edit one in afterwards if desired.
 */
export function applyUrlImport(
  meetingManager: MeetingManager,
  meetingId: string,
  items: ParsedAgendaItem[],
  resolvedPresenters: Map<string, DirectorySuggestion>,
  slotIntoSessions = false,
): number {
  if (!slotIntoSessions) {
    for (const item of items) {
      const presenters = mapImportedPresenters(item.presenters, resolvedPresenters);
      meetingManager.addAgendaItem(meetingId, item.name, presenters, item.duration);
    }
    return items.length;
  }

  const meeting = meetingManager.get(meetingId);
  if (!meeting) return 0;

  const slots = buildSessionSlotStates(meeting.agenda);
  let tailAfterId: string | null = meeting.agenda.at(-1)?.id ?? null;

  for (const item of items) {
    const presenters = mapImportedPresenters(item.presenters, resolvedPresenters);
    const created = meetingManager.addAgendaItem(meetingId, item.name, presenters, item.duration);
    if (!created) continue;

    const duration = item.duration ?? 0;
    const slot = findSessionSlotForDuration(slots, duration);
    if (slot) {
      meetingManager.reorderAgendaItem(meetingId, created.id, slot.insertAfterId);
      slot.insertAfterId = created.id;
      slot.remaining -= duration;
    } else if (tailAfterId !== null) {
      meetingManager.reorderAgendaItem(meetingId, created.id, tailAfterId);
    }

    // Re-read the tail after each placement — a slot reorder may have moved it.
    tailAfterId = meetingManager.get(meetingId)?.agenda.at(-1)?.id ?? null;
  }

  return items.length;
}
