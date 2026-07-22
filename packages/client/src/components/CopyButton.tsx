/**
 * A button that copies text to the clipboard and shows a brief floating
 * confirmation just above itself — the shared affordance behind every
 * copy-to-clipboard control (Copy Queue, Copy Results). Before this, the copy
 * buttons wrote silently, so a click gave no sign anything had happened.
 *
 * The confirmation is a native `popover="manual"` element promoted to the top
 * layer, so it escapes any clipping / `z-index` ancestor without a portal —
 * the same Popover-API foundation as the toasts and dropdown menus (see
 * docs/ARCHITECTURE.md). `manual` is the right state: it has no light-dismiss,
 * so it survives until our timer takes it down. Positioning stays in JS (a
 * measured `getBoundingClientRect` → inline fixed `top`/`left`), matching the
 * rest of the app; CSS anchor positioning still isn't in Firefox/Safari.
 *
 * `role="status"` (success) / `role="alert"` (failure) makes the outcome
 * audible to screen readers, mirroring the toast convention in ToastRegion.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode, type RefCallback } from 'react';

/** How long the confirmation stays up before it disappears, in ms. */
const CONFIRM_DURATION_MS = 1500;

interface Confirmation {
  /** Viewport-space anchor: the button's top edge, horizontally centred. */
  top: number;
  left: number;
  /** Whether the copy succeeded — drives colour, glyph, message, and role. */
  ok: boolean;
}

interface CopyButtonProps {
  /** Produces the text to copy, evaluated at click time (from live state). */
  getText: () => string;
  /** Tailwind chrome for the button; varies per call site. */
  className?: string;
  /** The button label. */
  children: ReactNode;
}

export function CopyButton({ getText, className, children }: CopyButtonProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  // null while hidden; otherwise the measured anchor + outcome.
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const timerRef = useRef<number | undefined>(undefined);

  // Track the popover node as state via a callback ref, so the showPopover
  // effect runs once the element actually mounts — the same callback-ref →
  // state → effect dance as usePopover / ToastItem.
  const [popoverEl, setPopoverEl] = useState<HTMLElement | null>(null);
  const popoverRef = useCallback<RefCallback<HTMLElement>>((node) => setPopoverEl(node), []);

  // Promote to the top layer on mount. Positioning is already applied inline,
  // so there's no flicker. try/catch: showPopover throws if the element isn't
  // connected yet or is already showing — both harmless here.
  useEffect(() => {
    if (!popoverEl) return;
    try {
      popoverEl.showPopover();
    } catch {
      /* not connected yet, or already shown */
    }
  }, [popoverEl]);

  // While the confirmation is up, dismiss it on scroll: the tooltip is
  // `position: fixed` and doesn't track its button, so a scroll would leave it
  // detached. Re-anchoring for the ~1.5s it shows isn't worth it.
  useEffect(() => {
    if (!confirm) return;
    const dismiss = () => setConfirm(null);
    window.addEventListener('scroll', dismiss, { capture: true });
    return () => window.removeEventListener('scroll', dismiss, { capture: true });
  }, [confirm]);

  // Clear any pending auto-hide timer on unmount.
  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  const show = useCallback((next: Confirmation) => {
    setConfirm(next);
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setConfirm(null), CONFIRM_DURATION_MS);
  }, []);

  function handleCopy() {
    const text = getText();
    const rect = buttonRef.current?.getBoundingClientRect();
    // Anchor at the button's top-centre; the tooltip lifts itself above that
    // point via a CSS transform. Fall back to the origin when the rect is
    // unavailable (e.g. jsdom, where layout is 0×0) — positioning is cosmetic.
    const anchor = rect ? { top: rect.top, left: rect.left + rect.width / 2 } : { top: 0, left: 0 };
    // Promise.resolve tolerates clipboard mocks whose writeText returns undefined.
    Promise.resolve(navigator.clipboard.writeText(text)).then(
      () => show({ ...anchor, ok: true }),
      () => show({ ...anchor, ok: false }),
    );
  }

  return (
    <>
      <button ref={buttonRef} type="button" onClick={handleCopy} className={className}>
        {children}
      </button>
      {confirm && (
        <div
          ref={popoverRef}
          popover="manual"
          // Polite (status) on success, assertive (alert) on failure — the same
          // live-region split ToastRegion uses.
          role={confirm.ok ? 'status' : 'alert'}
          style={{ top: confirm.top, left: confirm.left }}
          className={`tcq-copied-tooltip pointer-events-none whitespace-nowrap rounded border px-2 py-1 text-xs font-medium shadow-lg ${
            confirm.ok
              ? 'border-green-300 bg-green-50 text-green-800 dark:border-green-600/60 dark:bg-green-900/40 dark:text-green-200'
              : 'border-red-300 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-900/40 dark:text-red-300'
          }`}
        >
          <span aria-hidden="true">{confirm.ok ? '✓' : '⚠'}</span> {confirm.ok ? 'Copied' : 'Copy failed'}
        </div>
      )}
    </>
  );
}
