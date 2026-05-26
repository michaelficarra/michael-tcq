/**
 * Drives a native modal `<dialog>` from React state, encapsulating the pattern
 * piloted on the Preferences modal and now shared by every modal in the app.
 *
 * The caller owns an `open` boolean (its source of truth) and renders a single
 * always-mounted `<dialog class="tcq-dialog">`. This hook:
 *
 *  - mirrors `open` onto `showModal()` / `close()`, putting the dialog in the
 *    top layer so the platform handles focus trapping, focus restoration, and
 *    Esc / back-gesture dismissal for free;
 *  - bridges every platform-driven close (Esc, back gesture, light dismiss, the
 *    Safari fallback) back into React via `onClose`;
 *  - for dismissable dialogs, enables light dismiss with `closedby="any"` plus a
 *    JS outside-click fallback for browsers that lack it (notably Safari);
 *  - for non-dismissable dialogs (`{ dismissable: false }` — e.g. the
 *    server-driven active-poll modal), blocks Esc/back close requests so the
 *    dialog only closes when `open` flips false;
 *  - gates the dialog's *contents* behind `renderContents`, which stays true
 *    through the exit transition and then drops to false. A dismissed modal
 *    must contribute no form controls to the DOM: Playwright's
 *    getByLabel/getByText match hidden elements, so leaving controls mounted
 *    while `display:none` would collide with unrelated queries across the suite.
 *
 * The `.tcq-dialog` class in index.css supplies the backdrop tint and the
 * entry/exit animation (`@starting-style` + `allow-discrete`).
 */

import { useCallback, useEffect, useRef, useState, type RefCallback } from 'react';

/**
 * Ref callback that marks an element as a modal dialog's initial focus target.
 *
 * Use this instead of React's `autoFocus` prop inside a `useNativeDialog`
 * dialog. `autoFocus` only calls `.focus()` imperatively during commit, but the
 * subsequent `showModal()` (run in a passive effect) re-applies the dialog
 * focusing steps and lands on the *first focusable* element — overriding it.
 * Those steps do honour the real `autofocus` content attribute, which React's
 * prop never emits, so we set it directly. Pass a stable (module-level)
 * reference so the ref callback isn't re-invoked on every render.
 */
export function dialogAutoFocus(el: HTMLElement | null): void {
  el?.setAttribute('autofocus', '');
}

export interface UseNativeDialogOptions {
  /**
   * When false, the dialog can't be dismissed by Esc, the back gesture, or a
   * click outside — it closes only when `open` becomes false. Defaults to true.
   */
  dismissable?: boolean;
}

export interface UseNativeDialog {
  /** Attach to the `<dialog>` element's `ref`. */
  dialogRef: RefCallback<HTMLDialogElement>;
  /**
   * Render the dialog's contents only while this is true (open, or animating
   * closed). Wrap the children: `{renderContents && (<>…</>)}`.
   */
  renderContents: boolean;
}

export function useNativeDialog(
  open: boolean,
  onClose: () => void,
  options: UseNativeDialogOptions = {},
): UseNativeDialog {
  const { dismissable = true } = options;

  // Track the <dialog> node as state (set by a callback ref) rather than a
  // plain ref, so the effects below re-run when the element actually mounts.
  // The element can mount *after* the hook first runs — e.g. a dialog inside a
  // panel that renders nothing until its data loads — and a one-shot effect
  // reading a ref would miss it and never wire up its listeners.
  const [dialog, setDialog] = useState<HTMLDialogElement | null>(null);
  const dialogRef = useCallback<RefCallback<HTMLDialogElement>>((node) => setDialog(node), []);

  // Keep the latest onClose without re-running the setup effect when callers
  // pass an inline arrow (which changes identity every render). Updated in an
  // effect (not during render) so it stays a pure read in the event handler.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  // Contents render while open or animating closed. `isClosing` is adjusted
  // during render (React's "store info from previous renders" pattern), not in
  // an effect, so the contents stay mounted on the very render that hides the
  // modal — otherwise they'd unmount before the exit transition could play.
  const [isClosing, setIsClosing] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    setIsClosing(!open);
  }
  const renderContents = open || isClosing;

  // Mirror open/close state onto the native dialog. showModal() enters the top
  // layer; close() runs the exit animation via the CSS transition.
  useEffect(() => {
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open, dialog]);

  // Once the exit transition finishes, drop the contents from the DOM. The
  // timeout is a safety net for environments where no `transitionend` fires
  // (e.g. transitions disabled), so the contents can't get stuck mounted.
  useEffect(() => {
    if (!isClosing || !dialog) return;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      setIsClosing(false);
    };
    const onTransitionEnd = (e: TransitionEvent) => {
      if (e.target === dialog) finish();
    };
    dialog.addEventListener('transitionend', onTransitionEnd);
    const timer = window.setTimeout(finish, 300);
    return () => {
      dialog.removeEventListener('transitionend', onTransitionEnd);
      window.clearTimeout(timer);
    };
  }, [isClosing, dialog]);

  // Wire up dismissal behaviour once the dialog is mounted.
  useEffect(() => {
    if (!dialog) return;
    const cleanups: Array<() => void> = [];

    if (dismissable) {
      // Every platform-driven close (Esc, back gesture, light dismiss, and the
      // fallback below) surfaces as a `close` event — funnel them back into the
      // caller's source of truth.
      const onCloseEvent = () => onCloseRef.current();
      dialog.addEventListener('close', onCloseEvent);
      cleanups.push(() => dialog.removeEventListener('close', onCloseEvent));

      // `closedby="any"` = light dismiss + close requests. Set imperatively
      // because React's typings don't yet know the attribute.
      dialog.setAttribute('closedby', 'any');

      // Fallback light dismiss for browsers lacking `closedby` (e.g. Safari): a
      // click whose coordinates fall on the backdrop — the dialog itself is the
      // target and the point is outside its content box — closes it.
      const supportsClosedBy = 'closedBy' in HTMLDialogElement.prototype;
      if (!supportsClosedBy) {
        const onClick = (e: MouseEvent) => {
          if (e.target !== dialog) return;
          const r = dialog.getBoundingClientRect();
          const inside =
            r.top <= e.clientY && e.clientY <= r.top + r.height && r.left <= e.clientX && e.clientX <= r.left + r.width;
          if (!inside) dialog.close();
        };
        dialog.addEventListener('click', onClick);
        cleanups.push(() => dialog.removeEventListener('click', onClick));
      }
    } else {
      // Non-dismissable: the dialog closes only when `open` flips false on its
      // own. `closedby="none"` refuses close requests — Esc and the back
      // gesture — where supported (Chromium, Firefox); preventing the Escape
      // keydown's default action covers browsers that lack `closedby` (notably
      // Safari). Together they keep the modal up across all three engines.
      dialog.setAttribute('closedby', 'none');
      const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') e.preventDefault();
      };
      dialog.addEventListener('keydown', onKeyDown);
      cleanups.push(() => dialog.removeEventListener('keydown', onKeyDown));
    }

    return () => cleanups.forEach((fn) => fn());
  }, [dismissable, dialog]);

  return { dialogRef, renderContents };
}
