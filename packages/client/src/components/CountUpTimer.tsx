/**
 * A live count-up timer that displays elapsed time since a given timestamp.
 * Updates every second. Shows M:SS for under an hour, H:MM:SS for an hour+.
 */

import { useState, useEffect } from 'react';

interface CountUpTimerProps {
  /** ISO timestamp to count up from. */
  since: string;
  className?: string;
  /** Optional duration limit in minutes. When exceeded, the timer switches to bold red. */
  overAfterMinutes?: number;
}

/** Format elapsed milliseconds as M:SS or H:MM:SS. */
// eslint-disable-next-line react-refresh/only-export-components
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const mm = String(minutes).padStart(hours > 0 ? 2 : 1, '0');
  const ss = String(seconds).padStart(2, '0');

  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function CountUpTimer({ since, className, overAfterMinutes }: CountUpTimerProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const elapsed = now - new Date(since).getTime();
  const isOver = overAfterMinutes != null && elapsed > overAfterMinutes * 60_000;

  const defaultClass = 'text-xs text-stone-400 dark:text-stone-500 tabular-nums';
  const overClass = 'text-xs font-bold text-red-600 dark:text-red-400 tabular-nums';

  return (
    <span
      className={isOver ? overClass : (className ?? defaultClass)}
      title={`Since ${new Date(since).toLocaleString()}`}
    >
      {formatElapsed(elapsed)}
    </span>
  );
}
