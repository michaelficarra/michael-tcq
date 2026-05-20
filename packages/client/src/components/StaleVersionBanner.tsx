import { useEffect, useState } from 'react';

const RELOAD_DELAY_SECONDS = 10;

/**
 * Full-width banner shown when the client detects it's connected to a
 * stale (drained) Cloud Run revision. Counts down and reloads the page so
 * the user picks up the new revision; brief delay gives users a moment
 * to copy any unsaved text out of an input before the reload wipes it.
 */
export function StaleVersionBanner() {
  const [secondsLeft, setSecondsLeft] = useState(RELOAD_DELAY_SECONDS);

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
      role="alert"
      aria-live="assertive"
      className="fixed top-0 left-0 right-0 z-50 bg-amber-500 text-stone-900 px-4 py-2 text-sm text-center shadow"
    >
      A new version of TCQ is available. Reloading in {displayed} second{displayed === 1 ? '' : 's'}
      &hellip;{' '}
      <button onClick={() => window.location.reload()} className="underline font-medium cursor-pointer">
        Reload now
      </button>
    </div>
  );
}
