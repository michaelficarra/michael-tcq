/**
 * Diagnostics panel — shown on the home page below the active-meetings
 * admin panel for users with admin privileges. Surfaces operational
 * health (process, meetings, sockets, recent errors) so operators can
 * triage issues without shelling into Cloud Logging.
 */

import { useState, useEffect, useCallback } from 'react';
import { RelativeTime } from '../lib/RelativeTime.js';

interface ProcessInfo {
  uptimeSeconds: number;
  cpuSeconds: number;
  nodeVersion: string;
  gitSha: string | null;
  memory: {
    rss: number;
    heapUsed: number;
    heapTotal: number;
    external: number;
  };
}

interface ErrorEntry {
  timestamp: string;
  severity: 'ERROR' | 'CRITICAL';
  message: string;
  detail?: string;
}

interface PersistenceHealth {
  lastSyncSucceededAt: string | null;
  lastSyncFailedAt: string | null;
  lastSyncError: string | null;
  dirtyCount: number;
}

interface Diagnostics {
  process: ProcessInfo;
  meetings: { totalActive: number; totalParticipants: number; totalConnections: number };
  sockets: { totalClients: number };
  http: { total: number; clientErrors: number; serverErrors: number };
  persistence: PersistenceHealth;
  errors: { totalSinceStart: number; recent: ErrorEntry[] };
}

export function DiagnosticsPanel({ refreshTick }: { refreshTick: number }) {
  const [data, setData] = useState<Diagnostics | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchDiagnostics = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/diagnostics');
      if (res.ok) {
        setData(await res.json());
      }
    } catch {
      // Silently fail — the panel will keep showing the last good snapshot.
    } finally {
      setLoading(false);
    }
  }, []);

  // The shared timer in AdminSection drives both this panel and the
  // AdminPanel above it on the same tick — so they stay in lockstep
  // instead of drifting on two independent intervals.
  useEffect(() => {
    fetchDiagnostics();
  }, [fetchDiagnostics, refreshTick]);

  if (loading || !data) {
    return null;
  }

  return (
    <div className="mt-8">
      <h2 className="text-sm font-bold uppercase tracking-wider text-stone-500 dark:text-stone-400 mb-3">
        Admin — Diagnostics
      </h2>

      <div className="bg-white dark:bg-stone-900 rounded-lg shadow-sm dark:shadow-stone-950/50 border border-stone-200 dark:border-stone-700 overflow-hidden">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-4">
          <ProcessSection info={data.process} />
          <MeetingsSection
            totalActive={data.meetings.totalActive}
            totalParticipants={data.meetings.totalParticipants}
            totalConnections={data.meetings.totalConnections}
            totalClients={data.sockets.totalClients}
          />
          <HttpSection counters={data.http} />
          <PersistenceSection health={data.persistence} />
          <ErrorsSection totalSinceStart={data.errors.totalSinceStart} recent={data.errors.recent} />
        </div>
      </div>
    </div>
  );
}

// --- Sub-sections ---

function ProcessSection({ info }: { info: ProcessInfo }) {
  return (
    <Section title="Process">
      {/* Identity first — confirms what's deployed before anything else. */}
      <Row label="Node" value={info.nodeVersion} />
      <Row label="Git SHA" value={info.gitSha ? <code className="font-mono">{info.gitSha.slice(0, 12)}</code> : '—'} />
      {/* Lifetime — uptime is wall-clock; CPU time only ticks while the */}
      {/* kernel actually schedules us, so it lags on throttled hosts. */}
      <Row label="Uptime" value={formatUptime(info.uptimeSeconds)} />
      <Row label="CPU time" value={formatUptime(Math.floor(info.cpuSeconds))} />
      {/* Memory last. */}
      <Row label={<abbr title="Resident Set Size">RSS</abbr>} value={formatBytes(info.memory.rss)} />
      <Row label="Heap" value={`${formatBytes(info.memory.heapUsed)} / ${formatBytes(info.memory.heapTotal)}`} />
    </Section>
  );
}

function MeetingsSection({
  totalActive,
  totalParticipants,
  totalConnections,
  totalClients,
}: {
  totalActive: number;
  totalParticipants: number;
  totalConnections: number;
  totalClients: number;
}) {
  return (
    <Section title="Meetings & sockets">
      <Row label="Active meetings" value={totalActive} />
      <Row label="Total participants" value={totalParticipants} />
      <Row label="Live meeting connections" value={totalConnections} />
      <Row label="Total Socket.IO clients" value={totalClients} />
    </Section>
  );
}

function HttpSection({ counters }: { counters: { total: number; clientErrors: number; serverErrors: number } }) {
  // Pre-compute the error rate so the panel surfaces the ratio rather
  // than asking the operator to do mental arithmetic.
  const errorRate =
    counters.total === 0
      ? '—'
      : `${(((counters.clientErrors + counters.serverErrors) / counters.total) * 100).toFixed(1)}%`;
  return (
    <Section title="HTTP (since start)">
      <Row label="Total responses" value={counters.total.toLocaleString()} />
      <Row label="4xx" value={counters.clientErrors.toLocaleString()} />
      <Row label="5xx" value={counters.serverErrors.toLocaleString()} />
      <Row label="Error rate" value={errorRate} />
    </Section>
  );
}

function PersistenceSection({ health }: { health: PersistenceHealth }) {
  // A failed sync more recent than the last success — or any non-empty
  // backlog combined with a stale success — flags an active outage.
  const failing =
    health.lastSyncFailedAt !== null &&
    (health.lastSyncSucceededAt === null || health.lastSyncFailedAt > health.lastSyncSucceededAt);
  return (
    <Section title="Persistence">
      <Row
        label="Dirty backlog"
        value={
          <span className={health.dirtyCount > 0 ? 'text-amber-600 dark:text-amber-400' : undefined}>
            {health.dirtyCount}
          </span>
        }
      />
      <Row
        label="Last success"
        value={health.lastSyncSucceededAt ? <RelativeTime timestamp={health.lastSyncSucceededAt} /> : 'never'}
      />
      <Row
        label="Last failure"
        value={
          health.lastSyncFailedAt ? (
            <span className={failing ? 'text-red-600 dark:text-red-400' : undefined}>
              <RelativeTime timestamp={health.lastSyncFailedAt} />
            </span>
          ) : (
            'never'
          )
        }
      />
      {health.lastSyncError && (
        <Row
          label="Last error"
          value={
            <span className="text-red-600 dark:text-red-400 truncate max-w-[16rem]" title={health.lastSyncError}>
              {health.lastSyncError}
            </span>
          }
        />
      )}
    </Section>
  );
}

function ErrorsSection({ totalSinceStart, recent }: { totalSinceStart: number; recent: ErrorEntry[] }) {
  return (
    <div className="md:col-span-2">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-stone-500 dark:text-stone-400 mb-2">
        Recent errors{' '}
        <span className="font-normal normal-case tracking-normal text-stone-400 dark:text-stone-500">
          ({totalSinceStart} since start)
        </span>
      </h3>
      {recent.length === 0 ? (
        <p className="text-sm text-stone-400 dark:text-stone-500 italic">No errors recorded.</p>
      ) : (
        <div className="max-h-48 overflow-y-auto border border-stone-200 dark:border-stone-700 rounded text-xs">
          <ul className="divide-y divide-stone-100 dark:divide-stone-700">
            {recent.map((e, i) => (
              <li key={i} className="px-2 py-1.5 flex gap-2">
                <span
                  className={`shrink-0 font-medium uppercase ${
                    e.severity === 'CRITICAL' ? 'text-red-700 dark:text-red-300' : 'text-red-600 dark:text-red-400'
                  }`}
                  aria-label={`severity ${e.severity}`}
                >
                  {e.severity === 'CRITICAL' ? 'CRIT' : 'ERR'}
                </span>
                <span className="shrink-0 text-stone-500 dark:text-stone-400">
                  <RelativeTime timestamp={e.timestamp} />
                </span>
                <span
                  className="text-stone-700 dark:text-stone-300 truncate"
                  title={e.detail ? `${e.message}\n${e.detail}` : e.message}
                >
                  {e.message}
                  {e.detail && <span className="text-stone-500 dark:text-stone-400"> — {e.detail}</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// --- Layout helpers ---

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wider text-stone-500 dark:text-stone-400 mb-2">
        {title}
      </h3>
      <dl className="text-sm space-y-1">{children}</dl>
    </div>
  );
}

function Row({ label, value }: { label: React.ReactNode; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-stone-500 dark:text-stone-400">{label}</dt>
      <dd className="text-stone-700 dark:text-stone-300 text-right">{value}</dd>
    </div>
  );
}

// --- Formatting helpers ---

/** Format a byte count as KiB/MiB/GiB, rounded to one decimal where useful. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

/** Render uptime as "Xd Yh Zm" / "Yh Zm" / "Zm Ws" depending on magnitude. */
function formatUptime(totalSeconds: number): string {
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
