// Periodic poll of the server's /api/health and /api/admin/diagnostics
// endpoints. Runs in the same Node process as the harness; samples are
// pushed into the same JSONL stream as the per-client metrics so the
// post-run summary can correlate client-perceived latency with
// server-side resource pressure.
//
// Requires an admin session — the orchestrator obtains one via
// /api/dev/switch-user once and reuses the cookie for every probe.
// `ADMIN_USERNAMES` must include that username when starting the server.

const PROBE_INTERVAL_MS = 5000;

export function startServerProbe({ serverUrl, adminCookie, metrics, signal }) {
  let healthMissCount = 0;

  async function tick() {
    const t0 = performance.now();
    try {
      const healthRes = await fetch(`${serverUrl}/api/health`);
      const healthMs = performance.now() - t0;
      if (!healthRes.ok) {
        healthMissCount++;
        metrics.write('server_health', { ok: false, status: healthRes.status, healthMs });
      } else {
        metrics.write('server_health', { ok: true, healthMs });
      }
    } catch (err) {
      healthMissCount++;
      metrics.write('server_health', { ok: false, error: String(err?.message ?? err) });
    }

    try {
      const diagRes = await fetch(`${serverUrl}/api/admin/diagnostics`, {
        headers: { cookie: adminCookie },
      });
      if (!diagRes.ok) {
        metrics.write('server_diag_error', { status: diagRes.status });
        return;
      }
      const diag = await diagRes.json();
      metrics.write('server_diag', {
        rssMb: diag.process?.memory?.rss / 1024 / 1024,
        heapUsedMb: diag.process?.memory?.heapUsed / 1024 / 1024,
        cpuSeconds: diag.process?.cpuSeconds,
        uptimeSeconds: diag.process?.uptimeSeconds,
        totalActiveMeetings: diag.meetings?.totalActive,
        totalParticipants: diag.meetings?.totalParticipants,
        totalConnections: diag.meetings?.totalConnections,
        totalClients: diag.sockets?.totalClients,
        // Cumulative state:resync count since process start. A rising
        // counter under sustained load suggests deltas are being
        // dropped or the broadcast path is overloaded.
        resyncRequests: diag.sockets?.resyncRequests,
        // Persistence health — dirty backlog growth is the most
        // sensitive signal that the 30-s sync sweep is falling behind.
        dirtyCount: diag.persistence?.dirtyCount,
        lastSyncSucceededAt: diag.persistence?.lastSyncSucceededAt,
        lastSyncFailedAt: diag.persistence?.lastSyncFailedAt,
        lastSyncError: diag.persistence?.lastSyncError ?? null,
        errorsSinceStart: diag.errors?.totalSinceStart,
      });
    } catch (err) {
      metrics.write('server_diag_error', { error: String(err?.message ?? err) });
    }
  }

  // Fire immediately so we have a baseline before the first batch of
  // virtual clients lands, then on a fixed interval.
  tick();
  const handle = setInterval(tick, PROBE_INTERVAL_MS);

  signal?.addEventListener('abort', () => clearInterval(handle));

  return {
    stop: () => clearInterval(handle),
    healthMissCount: () => healthMissCount,
  };
}
