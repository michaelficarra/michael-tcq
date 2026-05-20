import { useEffect, useState } from 'react';

/**
 * Polls `/api/version` and reports whether the deployed Cloud Run
 * revision has changed out from under the WebSocket this tab is bound
 * to. Cloud Run keeps an old revision alive after a redeploy until its
 * in-flight requests drain — including long-lived WebSockets — so a
 * client whose socket is on the drained-old revision needs to reload
 * to catch up.
 *
 * `baselineRevision` is the revision the WebSocket reported on connect.
 * It's the authoritative reference because that's where the socket
 * actually lives; the client's first HTTP request to `/api/version`
 * could land on a different revision if a deploy slips between the
 * two, which would falsely flag the tab as stale.
 *
 * Returns `true` once a poll observes a revision different from
 * `baselineRevision`. Stays `false` while `baselineRevision` is `null`
 * (the WebSocket hasn't reported one yet, or the server isn't on
 * Cloud Run), when the endpoint returns 204 (`GIT_SHA` unset — local
 * dev, tests), or when the response `revision` is `null`.
 */
export function useStaleVersionCheck(baselineRevision: string | null, pollIntervalMs = 30_000): boolean {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    if (baselineRevision == null) return;
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch('/api/version', { headers: { Accept: 'application/json' } });
        if (cancelled) return;
        if (res.status !== 200) return;
        const body: { revision: string | null } = await res.json();
        if (cancelled) return;
        if (body.revision == null) return;
        if (body.revision !== baselineRevision) {
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
  }, [baselineRevision, pollIntervalMs]);

  return stale;
}
