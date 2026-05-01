/**
 * Relative-time formatting helpers + a shared 15-second clock hook.
 * The <RelativeTime> component that consumes these lives alongside in
 * RelativeTime.tsx — helpers are split out so Fast Refresh keeps working.
 */

import { useSyncExternalStore } from 'react';

/**
 * Format a full timestamp for a tooltip, using the viewer's locale and
 * time zone. e.g. "13 April 2026, 14:32:07" or "4/13/2026, 2:32:07 PM".
 */
export function formatFullTimestamp(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * Format the wall-clock time of a future deadline, with a calendar-day
 * suffix when the deadline isn't on the same local day as `nowMs`:
 *   - same day:     "06:32"
 *   - next day:     "06:32 tomorrow"
 *   - 2+ days out:  "06:32 on Wed, 3 May"
 *
 * Time is locale-formatted (12h vs 24h follows the viewer's locale).
 * `nowMs` lets the suffix update live as midnight passes.
 */
export function formatDeadline(deadlineIso: string, nowMs: number): string {
  const deadline = new Date(deadlineIso);
  const time = deadline.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
  const dayDiff = localDayDiff(new Date(nowMs), deadline);
  if (dayDiff <= 0) return time;
  if (dayDiff === 1) return `${time} tomorrow`;
  const date = deadline.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  return `${time} on ${date}`;
}

// Calendar-day delta in the viewer's local timezone. setHours(0,0,0,0)
// operates in local time, so DST transitions don't bias the day count.
function localDayDiff(from: Date, to: Date): number {
  const f = new Date(from);
  f.setHours(0, 0, 0, 0);
  const t = new Date(to);
  t.setHours(0, 0, 0, 0);
  return Math.round((t.getTime() - f.getTime()) / 86_400_000);
}

/** Compute a relative time string like "5 min ago". */
export function relativeTime(iso: string, now: number): string {
  const diff = now - new Date(iso).getTime();
  const seconds = Math.round(diff / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// A single 15-second interval drives every consumer of useNow via
// useSyncExternalStore, instead of each instance creating its own setInterval.
//
// getSnapshot must return a stable reference between ticks — returning a
// fresh Date.now() on every call violates useSyncExternalStore's contract
// and causes React to throw "tearing" errors that unmount the subtree.
// So we cache the current tick here and only advance it when the interval
// fires, in the same step that notifies subscribers.

const listeners = new Set<() => void>();
let currentNow = Date.now();

setInterval(() => {
  currentNow = Date.now();
  for (const listener of listeners) listener();
}, 15_000);

function subscribeNow(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getNow() {
  return currentNow;
}

/** Hook returning the current wall-clock time, refreshed every 15s. */
export function useNow(): number {
  return useSyncExternalStore(subscribeNow, getNow);
}
