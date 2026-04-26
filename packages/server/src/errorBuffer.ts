/**
 * In-memory ring buffer of recent ERROR/CRITICAL log entries.
 *
 * Used by the admin diagnostics endpoint so operators can spot recent
 * failures from the home page without shelling into Cloud Logging.
 *
 * State is process-local and resets on restart — the buffer is
 * best-effort and intentionally bounded so a flood of errors can't
 * grow memory unbounded.
 */

export interface ErrorBufferEntry {
  /** ISO 8601 timestamp matching the structured log line. */
  timestamp: string;
  /** Log severity — always 'ERROR' or 'CRITICAL' here. */
  severity: 'ERROR' | 'CRITICAL';
  /** Short human-readable message. */
  message: string;
  /**
   * Truncated single-line summary of additional log fields, suitable
   * for rendering in the admin UI. Full structured detail still lives
   * in Cloud Logging — this is only a preview.
   */
  detail?: string;
}

/** Maximum number of entries retained. Older entries are evicted FIFO. */
const MAX_ENTRIES = 50;

/** Maximum length of the rendered `detail` preview. */
const MAX_DETAIL_LENGTH = 200;

/** Newest-last circular array. Insertions append, eviction shifts. */
const buffer: ErrorBufferEntry[] = [];

/** Monotonic count of recorded errors since process start. */
let totalCount = 0;

/**
 * Record an error log entry. Called by the logger for every ERROR or
 * CRITICAL line so capture is automatic across HTTP, socket, and
 * application code paths.
 */
export function recordError(entry: {
  timestamp: string;
  severity: 'ERROR' | 'CRITICAL';
  message: string;
  fields?: Record<string, unknown>;
}): void {
  const detail = renderDetail(entry.fields);
  buffer.push({
    timestamp: entry.timestamp,
    severity: entry.severity,
    message: entry.message,
    ...(detail ? { detail } : {}),
  });
  if (buffer.length > MAX_ENTRIES) buffer.shift();
  totalCount += 1;
}

/** Snapshot of the most recent entries, newest-first. */
export function getRecentErrors(): ErrorBufferEntry[] {
  return [...buffer].reverse();
}

/** Total errors recorded since process start (not bounded by ring size). */
export function getErrorCount(): number {
  return totalCount;
}

/** Reset state — exposed only for tests. */
export function resetErrorBuffer(): void {
  buffer.length = 0;
  totalCount = 0;
}

/**
 * Render a compact one-line summary of the structured log fields. Used
 * to give admins enough context to recognise the failure without dumping
 * full payloads into the UI.
 */
function renderDetail(fields: Record<string, unknown> | undefined): string {
  if (!fields) return '';
  // Prefer the most diagnostic field if present.
  const errMessage = pickErrorMessage(fields);
  const summary = errMessage ?? safeStringify(fields);
  if (!summary) return '';
  return summary.length > MAX_DETAIL_LENGTH ? summary.slice(0, MAX_DETAIL_LENGTH - 1) + '…' : summary;
}

function pickErrorMessage(fields: Record<string, unknown>): string | undefined {
  const err = fields.error;
  if (err && typeof err === 'object' && err !== null && 'message' in err) {
    const msg = (err as { message: unknown }).message;
    if (typeof msg === 'string') return msg;
  }
  return undefined;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}
