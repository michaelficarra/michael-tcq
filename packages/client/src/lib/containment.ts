/**
 * Derive session containment metadata from the agenda.
 *
 * Walk the agenda in order. On each `Session` entry, start a new contiguous
 * run: each following `AgendaItem` (treated as 0 minutes when duration is
 * undefined) is added to `runTotal`. Items are marked as contained only as
 * long as the running `used` stays within capacity — the contained set is a
 * strict contiguous **prefix** of the run. As soon as one item would push the
 * sum over capacity, the prefix ends and no later item in the same run is
 * contained (even if it's small enough to fit on its own). Those tail items
 * are tracked in `overflowBy` so the UI can group them under an "overflow"
 * subsection header. The run itself continues to accumulate `runTotal` so
 * "overflow" displays the full excess.
 *
 * A run ends at the next session header or the end of the agenda.
 *
 * Pure display derivation: the server doesn't know about containment.
 * Recomputes from scratch each call. AgendaPanel memoises the result on
 * `meeting.agenda` so unrelated state changes don't trigger the walk.
 */

import type { AgendaEntry } from '@tcq/shared';
import { isAgendaItem, isSession } from '@tcq/shared';

export interface Containment {
  /** For each agenda item that's contained, which session contains it. */
  containedBy: Map<string, string>;
  /**
   * For each agenda item that sits past its session's capacity prefix,
   * which session it overflows from. Items in this map still belong
   * (visually) to that session's run — they just exceed its capacity.
   */
  overflowBy: Map<string, string>;
  /**
   * Per-item overflow contribution in minutes. For the first item that
   * crosses the capacity line, this is only the *protruding* portion
   * (`used + duration − capacity`); for items further down the run, the
   * prefix is already closed so the full duration counts. Summing the
   * values for a session's items equals `runTotal − capacity`, so this
   * map lets the UI annotate individual items without recomputing.
   */
  overflowAmount: Map<string, number>;
  /** For each session, the sum of durations of its contained items. */
  used: Map<string, number>;
  /**
   * For each session, the sum of durations across the full contiguous run
   * (including items past the capacity line). Used to detect overflow.
   */
  runTotal: Map<string, number>;
}

export function computeContainment(entries: AgendaEntry[]): Containment {
  const containedBy = new Map<string, string>();
  const overflowBy = new Map<string, string>();
  const overflowAmount = new Map<string, number>();
  const used = new Map<string, number>();
  const runTotal = new Map<string, number>();

  // The session whose run we're currently collecting, if any.
  let activeSessionId: string | null = null;
  let activeCapacity = 0;
  let activeUsed = 0;
  let activeRunTotal = 0;
  // Once an item overflows the active session's capacity, the contained
  // prefix is closed — no further items in this run are contained, even if
  // they'd fit on their own. Reset at each session boundary.
  let prefixClosed = false;

  for (const entry of entries) {
    if (isSession(entry)) {
      activeSessionId = entry.id;
      activeCapacity = entry.capacity;
      activeUsed = 0;
      activeRunTotal = 0;
      prefixClosed = false;
      used.set(entry.id, 0);
      runTotal.set(entry.id, 0);
      continue;
    }

    if (!isAgendaItem(entry) || activeSessionId === null) continue;

    const minutes = entry.duration ?? 0;
    activeRunTotal += minutes;
    runTotal.set(activeSessionId, activeRunTotal);

    if (prefixClosed) {
      // Once the prefix is closed, every remaining item in the run is
      // overflow (regardless of individual size) — its whole duration
      // counts toward the session's overflow total.
      overflowBy.set(entry.id, activeSessionId);
      overflowAmount.set(entry.id, minutes);
      continue;
    }

    if (activeUsed + minutes <= activeCapacity) {
      activeUsed += minutes;
      used.set(activeSessionId, activeUsed);
      containedBy.set(entry.id, activeSessionId);
    } else {
      // This item straddles the capacity line: the part up to capacity
      // doesn't overflow, only the remainder does. After this, the
      // prefix is closed so subsequent items contribute their full
      // duration above.
      prefixClosed = true;
      overflowBy.set(entry.id, activeSessionId);
      overflowAmount.set(entry.id, activeUsed + minutes - activeCapacity);
    }
  }

  return { containedBy, overflowBy, overflowAmount, used, runTotal };
}

/**
 * The set of session IDs whose entire run is in the past — the meeting has
 * advanced beyond every item the session contains. Used to suppress the
 * in-agenda overflow indicators (the "↓ overflow ↓" divider and the
 * "(overflows Xm)" badge) for concluded sessions, whose overflow total is
 * already summarised in the session header. Sessions that are *current*
 * (the current item sits within their run) or *upcoming* (the current item
 * precedes their run, or the meeting hasn't started) keep their indicators.
 *
 * `currentIndex` is the index of the current agenda item within `entries`
 * (`-1` when there is no current item — pre-start or concluded); `isPastFinal`
 * is true once the chair has advanced past the last item so the whole meeting
 * is concluded and every session is therefore past.
 *
 * Pure, like `computeContainment` — the server doesn't model session status.
 */
export function computePastSessions(entries: AgendaEntry[], currentIndex: number, isPastFinal: boolean): Set<string> {
  const past = new Set<string>();

  // Concluded meeting: every existing session is behind us.
  if (isPastFinal) {
    for (const entry of entries) if (isSession(entry)) past.add(entry.id);
    return past;
  }
  // Not started / nothing current: no session has been passed yet.
  if (currentIndex < 0) return past;

  // Walk runs, tracking the index of the last item in the active session's
  // run. A session is past once the current item lies strictly beyond that
  // last item; if the current item is inside the run (or the run is still
  // open at the current item) the session is current, not past.
  let activeSessionId: string | null = null;
  let runEndIndex = -1;
  const finalizeRun = () => {
    if (activeSessionId !== null && currentIndex > runEndIndex) past.add(activeSessionId);
  };

  entries.forEach((entry, index) => {
    if (isSession(entry)) {
      finalizeRun();
      activeSessionId = entry.id;
      runEndIndex = index; // run has no items yet; extends as items follow
    } else if (isAgendaItem(entry) && activeSessionId !== null) {
      runEndIndex = index;
    }
  });
  finalizeRun();

  return past;
}
