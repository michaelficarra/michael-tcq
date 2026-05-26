/**
 * Drives a native `popover="auto"` element from React state — the dropdown-menu
 * counterpart to {@link useNativeDialog}. Used by the hamburger menu
 * (`UserMenu`) and the saved-topics dropdown (`SpeakerControls`).
 *
 * The Popover API gives us, for free, the three things these menus used to
 * hand-roll: top-layer stacking (so no `createPortal` to escape the navbar's
 * clipping/`z-index` context), light dismiss on an outside pointerdown, and Esc
 * dismissal. We keep ownership of *positioning* in JS (measured `top`/`left`),
 * because CSS anchor positioning still isn't in Firefox/Safari — see
 * `docs/ARCHITECTURE.md`.
 *
 * The caller owns an `open` boolean and renders the popover element only while
 * open (`{open && <div popover="auto" ref={popoverRef}>…</div>}`). Rendering the
 * contents in step with `open` keeps positioning flicker-free (the box is
 * measured and laid out before `showPopover()` promotes it) and keeps a closed
 * menu out of the DOM so Playwright/RTL `getByRole` don't match hidden items.
 *
 * This hook:
 *  - calls `showPopover()` once the element mounts while open;
 *  - bridges every platform-driven close (light dismiss, Esc, and the implicit
 *    close when React unmounts the element) back into `onClose`, via the
 *    `toggle` event, so the caller's `open` source of truth stays in sync;
 *  - resolves the auto-popover "click the open trigger" race — see
 *    {@link UsePopover.consumeTriggerClick}.
 */

import { useCallback, useEffect, useRef, useState, type RefCallback } from 'react';

/**
 * A `toggle` event. `ToggleEvent` isn't in every lib.dom we build against, so
 * describe the one field we read.
 */
type PopoverToggleEvent = Event & { newState: 'open' | 'closed' };

export interface UsePopover {
  /** Attach to the popover element's `ref`. */
  popoverRef: RefCallback<HTMLElement>;
  /**
   * Spread onto the trigger button. Records whether the popover is open at the
   * start of a pointer gesture, so the click that follows can tell apart "the
   * platform just light-dismissed this popover on pointerdown" from a genuine
   * open request.
   */
  triggerProps: { onPointerDown: () => void };
  /**
   * Call first in the trigger's click handler. Returns true when this click is
   * the tail of the gesture that just light-dismissed an open popover: the
   * popover is already closing, so the handler should leave it closed rather
   * than toggle it straight back open. In jsdom (no pointerdown, no light
   * dismiss) this is always false, so unit tests toggle on click as before.
   */
  consumeTriggerClick: () => boolean;
}

export function usePopover(open: boolean, onClose: () => void): UsePopover {
  // Track the popover node as state (set by a callback ref) rather than a plain
  // ref, so the effects below re-run when the element actually mounts — the
  // caller only renders it while open, so it mounts after the hook first runs.
  const [el, setEl] = useState<HTMLElement | null>(null);
  const popoverRef = useCallback<RefCallback<HTMLElement>>((node) => setEl(node), []);

  // Keep the latest onClose without re-running the listener effect when callers
  // pass an inline arrow (new identity every render).
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  // Promote to the top layer once the element mounts while open. Positioning is
  // already applied (inline style measured by the caller), so there's no
  // flicker. Wrapped in try/catch: showPopover throws if the element isn't yet
  // connected or is already showing — both harmless here.
  useEffect(() => {
    if (!el || !open) return;
    try {
      el.showPopover();
    } catch {
      /* not connected yet, or already shown */
    }
  }, [el, open]);

  // Funnel platform-driven closes back into the caller's `open` state.
  useEffect(() => {
    if (!el) return;
    const onToggle = (e: Event) => {
      if ((e as PopoverToggleEvent).newState === 'closed') onCloseRef.current();
    };
    el.addEventListener('toggle', onToggle);
    return () => el.removeEventListener('toggle', onToggle);
  }, [el]);

  // Snapshot taken on the trigger's pointerdown (before the browser's light
  // dismiss has had a chance to flip `open`), consumed by the click handler.
  const wasOpenAtPointerDownRef = useRef(false);
  const triggerProps = { onPointerDown: () => (wasOpenAtPointerDownRef.current = open) };
  const consumeTriggerClick = useCallback(() => {
    const wasOpen = wasOpenAtPointerDownRef.current;
    wasOpenAtPointerDownRef.current = false;
    return wasOpen;
  }, []);

  return { popoverRef, triggerProps, consumeTriggerClick };
}
