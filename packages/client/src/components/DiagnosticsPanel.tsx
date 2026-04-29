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

interface Diagnostics {
  process: ProcessInfo;
  meetings: { totalActive: number; totalParticipants: number; totalConnections: number };
  sockets: { totalClients: number };
  errors: { totalSinceStart: number; recent: ErrorEntry[] };
}

export function DiagnosticsPanel() {
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

  useEffect(() => {
    fetchDiagnostics();
    // Mirrors the AdminPanel cadence so the two sections refresh together.
    const interval = setInterval(fetchDiagnostics, 10_000);
    return () => clearInterval(interval);
  }, [fetchDiagnostics]);

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
      <Row label="Uptime" value={formatUptime(info.uptimeSeconds)} />
      {/* CPU time vs uptime: on a host that throttles or pauses idle */}
      {/* containers (e.g. Cloud Run), this can lag uptime substantially. */}
      <Row label="CPU time" value={formatUptime(Math.floor(info.cpuSeconds))} />
      <Row label="Node" value={info.nodeVersion} />
      <Row label="Git SHA" value={info.gitSha ? <code className="font-mono">{info.gitSha.slice(0, 12)}</code> : '—'} />
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
