/**
 * The colored duration bar painted in an agenda row's left indicator
 * column. Visualises one item's relationship to its session's capacity,
 * and (on the active row) live elapsed time.
 *
 * The bar is a single vertical strip absolutely positioned to the row's
 * left edge, stacking up to five segments top-to-bottom:
 *
 *   1. Dark gray  — elapsed time within capacity
 *   2. Light gray — remaining time within capacity
 *   3. Dark red   — elapsed time past capacity (session overflow)
 *   4. Light red  — remaining time past capacity
 *   5. Orange     — elapsed time past the chair's per-item estimate
 *
 * The bar's vertical scale is `max(estimate, elapsed)` minutes so the
 * orange "over estimate" segment can grow without pushing the rest of
 * the bar off the row. While `elapsedMs === 0` (non-current rows), the
 * dark segments are zero and the bar reduces to the static gray/red
 * capacity split.
 *
 * Stateless and decorative: takes its inputs as props (the parent calls
 * the 1-second clock when subscribing live elapsed time) and renders
 * `aria-hidden` spans, leaving accessible names to the surrounding row.
 */

import { formatShortDuration } from '@tcq/shared';
import { formatElapsed } from './CountUpTimer.js';

export interface AgendaItemDurationBarProps {
  /** Estimated duration in minutes, or undefined when no estimate was set. */
  durationMinutes: number | undefined;
  /**
   * Item's overflow contribution to its session, in minutes. Zero for
   * items that fit within capacity. Drives the red segment of the bar
   * and its hover tooltip.
   */
  overflowAmount: number;
  /**
   * Whether the row sits inside a session run. When false there's no
   * session-capacity context to plot against, so the bar renders
   * nothing.
   */
  isIndented: boolean;
  /**
   * Live elapsed time in ms for the active row. Defaults to 0, which
   * skips the dark "elapsed" overlays and the orange "over estimate"
   * segment — i.e. the bar reduces to the static capacity split used
   * on every non-current row.
   */
  elapsedMs?: number;
}

export function AgendaItemDurationBar({
  durationMinutes,
  overflowAmount,
  isIndented,
  elapsedMs = 0,
}: AgendaItemDurationBarProps) {
  const elapsedMin = Math.max(0, elapsedMs) / 60_000;
  const estimateMin = durationMinutes != null && durationMinutes > 0 ? durationMinutes : 0;
  const containedMin = Math.max(0, estimateMin - overflowAmount);
  const overflowMin = Math.max(0, overflowAmount);
  const overEstimateMin = Math.max(0, elapsedMin - estimateMin);
  const totalMin = Math.max(estimateMin, elapsedMin);

  // No session-run context or no scale to plot against → render nothing.
  if (!isIndented || totalMin === 0) return null;

  // Segment amounts, in minutes. Time progresses top → bottom on the
  // bar, so dark (elapsed) segments stack above their light siblings.
  const darkGrayMin = Math.min(elapsedMin, containedMin);
  const lightGrayMin = containedMin - darkGrayMin;
  const darkRedMin = Math.max(0, Math.min(elapsedMin, estimateMin) - containedMin);
  const lightRedMin = overflowMin - darkRedMin;
  const orangeMin = overEstimateMin;
  const toPct = (m: number) => (m / totalMin) * 100;

  const redTitle = `Overflows by ${formatShortDuration(overflowAmount)}`;
  const orangeTitle = `Over estimate by ${formatElapsed(orangeMin * 60_000)}`;

  return (
    <span
      aria-hidden="true"
      data-testid="agenda-duration-bar"
      className="absolute inset-y-0 left-0 w-0.75 flex flex-col pointer-events-none"
    >
      {darkGrayMin > 0 && (
        <span
          data-testid="bar-segment-dark-gray"
          className="bg-stone-500 dark:bg-stone-400"
          style={{ height: `${toPct(darkGrayMin)}%` }}
        />
      )}
      {lightGrayMin > 0 && (
        <span
          data-testid="bar-segment-light-gray"
          className="bg-stone-300 dark:bg-stone-600"
          style={{ height: `${toPct(lightGrayMin)}%` }}
        />
      )}
      {darkRedMin > 0 && (
        <span
          data-testid="bar-segment-dark-red"
          className="bg-red-800 dark:bg-red-300 pointer-events-auto"
          style={{ height: `${toPct(darkRedMin)}%` }}
          title={redTitle}
        />
      )}
      {lightRedMin > 0 && (
        <span
          data-testid="bar-segment-light-red"
          className="bg-red-600 dark:bg-red-500 pointer-events-auto"
          style={{ height: `${toPct(lightRedMin)}%` }}
          title={redTitle}
        />
      )}
      {orangeMin > 0 && (
        <span
          data-testid="bar-segment-orange"
          className="bg-orange-500 dark:bg-orange-400 pointer-events-auto"
          style={{ height: `${toPct(orangeMin)}%` }}
          title={orangeTitle}
        />
      )}
    </span>
  );
}
