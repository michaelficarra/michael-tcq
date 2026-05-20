/**
 * Shared 1-second clock for every consumer that needs a live-updating
 * elapsed/wall-clock value (the agenda row's `(elapsed M:SS)` readout,
 * the queue header's count-up timers, etc.).
 *
 * A single self-correcting `setTimeout` chain advances the clock, rather
 * than each subscriber starting its own `setInterval`. The schedule is
 * aligned to the next wall-clock second boundary so the tick never
 * drifts further into a second over time — without this, the displayed
 * elapsed value could occasionally jump (e.g. "0:07" straight to "0:09")
 * because cumulative drift caused a single firing to straddle two
 * second-boundaries.
 *
 * The schedule is also gated on the listener set: the first subscription
 * starts the chain and the last unsubscription stops it. Modules that
 * import `useNow` but never mount it (test setups, lazy-loaded bundles)
 * therefore pay nothing.
 */

import { useSyncExternalStore } from 'react';

const listeners = new Set<() => void>();
let scheduledId: ReturnType<typeof setTimeout> | null = null;

function scheduleTick() {
  // Aim for ~1ms past the next wall-clock second so floor(elapsed/1000)
  // is guaranteed to have advanced by the time the listeners run.
  const delay = 1001 - (Date.now() % 1000);
  scheduledId = setTimeout(() => {
    scheduledId = null;
    for (const listener of listeners) listener();
    // Keep ticking only while someone's still listening; the last
    // unsubscribe will have left `listeners` empty and we stop here.
    if (listeners.size > 0) scheduleTick();
  }, delay);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (scheduledId === null) scheduleTick();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && scheduledId !== null) {
      clearTimeout(scheduledId);
      scheduledId = null;
    }
  };
}

function getSnapshot() {
  return Date.now();
}

/**
 * Subscribe to the shared 1-second clock. Returns the current
 * `Date.now()` value and re-renders the caller every second. The clock
 * runs only while at least one consumer is mounted.
 */
export function useNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot);
}
