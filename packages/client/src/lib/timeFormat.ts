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

const listeners = new Set<() => void>();

setInterval(() => {
  for (const listener of listeners) listener();
}, 15_000);

function subscribeNow(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getNow() {
  return Date.now();
}

/** Hook returning the current wall-clock time, refreshed every 15s. */
export function useNow(): number {
  return useSyncExternalStore(subscribeNow, getNow);
}
