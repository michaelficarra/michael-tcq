/**
 * Renders the toast queue as a stack of `popover="manual"` elements anchored
 * bottom-right (clear of the bottom-left ConnectionStatus dot).
 *
 * `manual` is the right popover state for toasts: it has no light-dismiss, so
 * interacting elsewhere on the page won't close them, and several can coexist.
 * Each toast promotes itself to the top layer on mount via `showPopover()` —
 * the same callback-ref → state → effect dance as {@link usePopover} — and
 * funnels every platform-driven close (the native close button, the
 * auto-dismiss timer, Esc) back through `onDismiss` so React state stays in
 * sync.
 *
 * Stacking: top-layer popovers ignore their DOM parent, so we can't lay them
 * out with a flex container. Each toast reports its measured height (via a
 * ResizeObserver, mirroring useSlidingTabUnderline) and the region translates
 * each one up by the cumulative height of the newer toasts below it. We do this
 * in JS rather than with `sibling-index()` — that's not Baseline yet, and it
 * couldn't account for variable-height (multi-line) toasts anyway.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefCallback } from 'react';
import type { Toast } from '../contexts/ToastContext.js';

/** Vertical gap between stacked toasts, in px. */
const STACK_GAP = 12;

type PopoverToggleEvent = Event & { newState: 'open' | 'closed' };

interface ToastRegionProps {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}

export function ToastRegion({ toasts, onDismiss }: ToastRegionProps) {
  // Measured height of each toast, keyed by id. Updated by ToastItem via
  // onMeasure as content lays out or wraps.
  const [heights, setHeights] = useState<Record<string, number>>({});

  const handleMeasure = useCallback((id: string, height: number) => {
    setHeights((prev) => (prev[id] === height ? prev : { ...prev, [id]: height }));
  }, []);
  // Note: a removed toast's height entry lingers in `heights`, but offsets are
  // computed only from the live `toasts` array below, so stale entries never
  // affect layout — and the count is bounded by toasts shown in a session.

  // Cumulative upward offset for each toast: the newest (last in the array)
  // sits at the corner with offset 0; older toasts are pushed up by the height
  // (plus gap) of every toast below them.
  const offsets: Record<string, number> = {};
  let running = 0;
  for (let i = toasts.length - 1; i >= 0; i--) {
    const toast = toasts[i];
    offsets[toast.id] = running;
    running += (heights[toast.id] ?? 0) + STACK_GAP;
  }

  return (
    <>
      {toasts.map((toast) => (
        <ToastItem
          key={toast.id}
          toast={toast}
          offset={offsets[toast.id]}
          onDismiss={onDismiss}
          onMeasure={handleMeasure}
        />
      ))}
    </>
  );
}

interface ToastItemProps {
  toast: Toast;
  offset: number;
  onDismiss: (id: string) => void;
  onMeasure: (id: string, height: number) => void;
}

function ToastItem({ toast, offset, onDismiss, onMeasure }: ToastItemProps) {
  // Track the node as state so the effects below re-run once it mounts.
  const [el, setEl] = useState<HTMLElement | null>(null);
  const popoverRef = useCallback<RefCallback<HTMLElement>>((node) => setEl(node), []);

  // Keep latest callbacks without re-running the listener effects on every
  // render (callers pass fresh closures).
  const onDismissRef = useRef(onDismiss);
  const onMeasureRef = useRef(onMeasure);
  useEffect(() => {
    onDismissRef.current = onDismiss;
    onMeasureRef.current = onMeasure;
  });

  // Promote to the top layer once mounted. Wrapped in try/catch: showPopover
  // throws if the element isn't connected yet or is already showing.
  useEffect(() => {
    if (!el) return;
    try {
      el.showPopover();
    } catch {
      /* not connected yet, or already shown */
    }
  }, [el]);

  // Funnel platform-driven closes (close button, auto-dismiss, Esc) back into
  // the queue. dismissToast is idempotent, so the implicit close fired when
  // React unmounts the element after removal is a harmless no-op.
  useEffect(() => {
    if (!el) return;
    const onToggle = (e: Event) => {
      if ((e as PopoverToggleEvent).newState === 'closed') onDismissRef.current(toast.id);
    };
    el.addEventListener('toggle', onToggle);
    return () => el.removeEventListener('toggle', onToggle);
  }, [el, toast.id]);

  // Auto-dismiss timer. Hiding the popover fires `toggle` → onDismiss, so
  // removal flows through the same path as a manual close.
  useEffect(() => {
    if (!el || toast.durationMs === null) return;
    const timer = window.setTimeout(() => {
      try {
        el.hidePopover();
      } catch {
        /* already hidden */
      }
    }, toast.durationMs);
    return () => window.clearTimeout(timer);
  }, [el, toast.durationMs]);

  // Report height to the region so it can lay out the stack. useLayoutEffect so
  // the offset is set before paint (no first-frame overlap), plus a
  // ResizeObserver to catch later reflow (e.g. a long message wrapping).
  // ResizeObserver is absent in jsdom and very old browsers, so guard it — the
  // one-shot measurement above still runs.
  useLayoutEffect(() => {
    if (!el) return;
    onMeasureRef.current(toast.id, el.offsetHeight);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => onMeasureRef.current(toast.id, el.offsetHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, [el, toast.id]);

  const styles =
    toast.variant === 'error'
      ? 'bg-red-50 dark:bg-red-900/30 border-red-200 dark:border-red-800 text-red-700 dark:text-red-300'
      : 'bg-amber-50 dark:bg-amber-900/30 border-amber-300 dark:border-amber-500/60 text-amber-900 dark:text-amber-200';
  const closeStyles =
    toast.variant === 'error'
      ? 'text-red-400 hover:text-red-600 dark:text-red-500 dark:hover:text-red-300'
      : 'text-amber-500 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-200';

  return (
    <div
      id={toast.id}
      ref={popoverRef}
      popover="manual"
      // role="alert" (assertive) for errors, "status" (polite) for warnings.
      role={toast.variant === 'error' ? 'alert' : 'status'}
      style={{ '--toast-offset': `${offset}px` } as React.CSSProperties}
      className={`tcq-toast flex w-[min(22rem,calc(100vw-2rem))] items-start justify-between gap-3 rounded border px-4 py-2 text-sm shadow-lg ${styles}`}
    >
      <span>{toast.message}</span>
      {/* Declarative dismissal: the invoker hides its own containing popover. */}
      <button
        type="button"
        popoverTarget={toast.id}
        popoverTargetAction="hide"
        className={`ml-2 shrink-0 cursor-pointer ${closeStyles}`}
        aria-label="Dismiss notification"
      >
        ✕
      </button>
    </div>
  );
}
