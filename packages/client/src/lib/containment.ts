/**
 * Derive session containment metadata from the agenda.
 *
 * Walk the agenda in order. On each `Session` entry, start a new contiguous
 * run: each following `AgendaItem` (treated as 0 minutes when timebox is
 * undefined) is added to `runTotal`. Items are marked as contained only as
 * long as the running `used` stays within capacity — the contained set is a
 * strict contiguous **prefix** of the run. As soon as one item would push the
 * sum over capacity, the prefix ends and no later item in the same run is
 * contained (even if it's small enough to fit on its own). The run itself
 * continues to accumulate `runTotal` so "overflow" displays the full excess.
 *
 * A run ends at the next session header or the end of the agenda.
 *
 * Pure display derivation: the server doesn't know about containment.
 * Recomputes from scratch each call; the agenda is small enough that
 * memoisation isn't worth the extra plumbing.
 */

import type { AgendaEntry } from '@tcq/shared';
import { isAgendaItem, isSession } from '@tcq/shared';

export interface Containment {
  /** For each agenda item that's contained, which session contains it. */
  containedBy: Map<string, string>;
  /** For each session, the sum of timeboxes of its contained items. */
  used: Map<string, number>;
  /**
   * For each session, the sum of timeboxes across the full contiguous run
   * (including items past the capacity line). Used to detect overflow.
   */
  runTotal: Map<string, number>;
}

export function computeContainment(entries: AgendaEntry[]): Containment {
  const containedBy = new Map<string, string>();
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

    const minutes = entry.timebox ?? 0;
    activeRunTotal += minutes;
    runTotal.set(activeSessionId, activeRunTotal);

    if (prefixClosed) continue;

    if (activeUsed + minutes <= activeCapacity) {
      activeUsed += minutes;
      used.set(activeSessionId, activeUsed);
      containedBy.set(entry.id, activeSessionId);
    } else {
      // This item would overflow — close the prefix so later (possibly
      // smaller) items aren't squeezed in past a larger overflowing one.
      prefixClosed = true;
    }
  }

  return { containedBy, used, runTotal };
}
