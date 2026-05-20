import { useEffect, useState } from 'react';

/**
 * Polls `/api/version` and detects when the current revision differs from
 * the one observed on first poll. Used to surface a "this tab is stale"
 * banner after a Cloud Run redeploy: existing WebSocket connections stay
 * pinned to the old (drained-but-alive) revision, so HTTP requests are
 * the only side-channel that sees the new revision.
 *
 * Returns `true` once a revision mismatch is observed. Stays `false` if
 * the endpoint returns 204 (no GIT_SHA — local dev, tests) or if
 * `revision` is null in the JSON response (deployed without K_REVISION,
 * which Cloud Run injects automatically, so this is mostly defensive).
 */
export function useStaleVersionCheck(pollIntervalMs = 30_000): boolean {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let baseline: string | null = null;

    async function poll() {
      try {
        const res = await fetch('/api/version', { headers: { Accept: 'application/json' } });
        if (cancelled) return;
        if (res.status !== 200) return;
        const body: { revision: string | null } = await res.json();
        if (cancelled) return;
        if (body.revision == null) return;
        if (baseline == null) {
          baseline = body.revision;
          return;
        }
        if (body.revision !== baseline) {
          setStale(true);
        }
      } catch {
        // Network errors are expected during deploys / offline periods;
        // the next interval will retry. No need to surface them.
      }
    }

    poll();
    const id = window.setInterval(poll, pollIntervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [pollIntervalMs]);

  return stale;
}
