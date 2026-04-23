/**
 * Auto-updating relative time display rendered as a <time> element.
 * Uses the shared 15-second clock from timeFormat.ts so every instance
 * on the page ticks off a single interval.
 */

import { formatFullTimestamp, relativeTime, useNow } from './timeFormat.js';

export function RelativeTime({
  timestamp,
  title,
  className,
}: {
  timestamp: string;
  title?: string;
  className?: string;
}) {
  const now = useNow();
  return (
    <time dateTime={timestamp} title={title ?? formatFullTimestamp(timestamp)} className={className}>
      {relativeTime(timestamp, now)}
    </time>
  );
}
