import { useCallback, useEffect, useState, type RefCallback } from 'react';

const RELOAD_DELAY_SECONDS = 10;

/**
 * Full-width banner shown when the client detects it's connected to a
 * stale (drained) Cloud Run revision. Counts down and reloads the page so
 * the user picks up the new revision; brief delay gives users a moment
 * to copy any unsaved text out of an input before the reload wipes it.
 *
 * Promoted to the top layer via `popover="manual"` — the same Popover-API
 * foundation as the toast region (see ToastRegion) — so it sits above all
 * page content without z-index juggling and `manual` keeps it from being
 * light-dismissed. It stays a banner, not a toast: it isn't part of the
 * toast stack and keeps its own countdown + auto-reload behaviour.
 */
export function StaleVersionBanner() {
  const [secondsLeft, setSecondsLeft] = useState(RELOAD_DELAY_SECONDS);

  // Promote to the top layer once mounted. Mirrors usePopover/ToastRegion:
  // track the node as state via a callback ref so this runs after mount, and
  // wrap showPopover in try/catch (throws if not yet connected).
  const [el, setEl] = useState<HTMLElement | null>(null);
  const bannerRef = useCallback<RefCallback<HTMLElement>>((node) => setEl(node), []);
  useEffect(() => {
    if (!el) return;
    try {
      el.showPopover();
    } catch {
      /* not connected yet, or already shown */
    }
  }, [el]);

  useEffect(() => {
    const id = window.setInterval(() => {
      setSecondsLeft((s) => s - 1);
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (secondsLeft <= 0) {
      window.location.reload();
    }
  }, [secondsLeft]);

  const displayed = Math.max(secondsLeft, 0);

  return (
    <div
      ref={bannerRef}
      popover="manual"
      role="alert"
      aria-live="assertive"
      className="tcq-stale-banner fixed top-0 left-0 right-0 bg-amber-500 text-stone-900 px-4 py-2 text-sm text-center shadow"
    >
      A new version of TCQ is available. Reloading in {displayed} second{displayed === 1 ? '' : 's'}
      &hellip;{' '}
      <button onClick={() => window.location.reload()} className="underline font-medium cursor-pointer">
        Reload now
      </button>
    </div>
  );
}
