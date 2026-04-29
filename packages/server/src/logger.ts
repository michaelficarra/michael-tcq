/**
 * Structured JSON logger for Cloud Logging.
 *
 * Emits one JSON object per line to stdout via `console.log`. Cloud Run's
 * log agent ingests stdout/stderr and treats entries with a recognised
 * `severity` field as structured LogEntry records. See:
 *   - https://cloud.google.com/logging/docs/structured-logging
 *   - https://cloud.google.com/logging/docs/reference/v2/rest/v2/LogEntry
 *
 * Going through `console.log` (rather than a raw `process.stdout.write`)
 * lets vitest's console interception silence passing-test output via
 * `--silent passed-only` while still surfacing logs from failing tests.
 *
 * The output is a zero-dependency line-delimited JSON stream — no pino,
 * winston, or bunyan. Keeping the surface small means we never have to
 * wrestle with transport configuration in production.
 */

import { recordError } from './errorBuffer.js';

/** GCP LogSeverity values, in ascending order of urgency. */
export type Severity = 'DEBUG' | 'INFO' | 'NOTICE' | 'WARNING' | 'ERROR' | 'CRITICAL';

/** Extra fields to merge into the log entry. */
export type LogFields = Record<string, unknown>;

/** Service name included on every entry for easy filtering in Cloud Logging. */
const SERVICE = 'tcq';

/**
 * Render a structured log line and write it to stdout. Every entry carries
 * `severity`, `message`, `time`, `service`, and (when available) `gitSha`
 * so entries can be correlated with a specific deployment.
 */
export function log(severity: Severity, message: string, fields: LogFields = {}): void {
  // Read GIT_SHA lazily per-call so tests that stub the env var are
  // reflected without needing to re-import the module.
  const gitSha = process.env.GIT_SHA;

  const time = new Date().toISOString();
  const entry: LogFields = {
    severity,
    message,
    time,
    service: SERVICE,
    ...(gitSha ? { gitSha } : {}),
    ...fields,
  };

  let line: string;
  try {
    line = JSON.stringify(entry);
  } catch (err) {
    // Serialisation failure must never crash the process — fall back to a
    // best-effort plain-text line on stderr so the operator still sees
    // *something*, and drop the structured entry.
    process.stderr.write(`logger_serialise_failed: ${String(err)} message=${message}\n`);
    return;
  }

  console.log(line);

  // Mirror ERROR/CRITICAL entries into the in-memory ring used by the
  // admin diagnostics endpoint. Done after stdout so a buffer failure
  // could never block the canonical Cloud Logging stream.
  if (severity === 'ERROR' || severity === 'CRITICAL') {
    recordError({ timestamp: time, severity, message, fields });
  }
}

export const debug = (message: string, fields?: LogFields): void => log('DEBUG', message, fields);
export const info = (message: string, fields?: LogFields): void => log('INFO', message, fields);
export const notice = (message: string, fields?: LogFields): void => log('NOTICE', message, fields);
export const warning = (message: string, fields?: LogFields): void => log('WARNING', message, fields);
export const error = (message: string, fields?: LogFields): void => log('ERROR', message, fields);
export const critical = (message: string, fields?: LogFields): void => log('CRITICAL', message, fields);

/**
 * Serialise any thrown value into a JSON-safe shape. Accepts Error instances
 * (preserving stack traces) and arbitrary non-Error throws — promise
 * rejections are especially likely to carry strings, plain objects, or
 * undefined, so we handle those without throwing from the logger.
 */
export function serialiseError(err: unknown): { name: string; message: string; stack?: string } {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  if (typeof err === 'string') {
    return { name: 'NonErrorString', message: err };
  }
  if (err === null || err === undefined) {
    return { name: 'NonError', message: String(err) };
  }
  // Best-effort for objects and other primitives
  try {
    return { name: 'NonError', message: JSON.stringify(err) };
  } catch {
    return { name: 'NonError', message: String(err) };
  }
}

/**
 * Format a `process.hrtime.bigint()` delta (nanoseconds) as a GCP Duration
 * string — seconds with up to 9 fractional digits followed by `"s"`. Used
 * for the `latency` field of `LogEntry.HttpRequest`.
 */
export function formatLatency(elapsedNs: bigint): string {
  const ns = elapsedNs < 0n ? 0n : elapsedNs;
  const seconds = ns / 1_000_000_000n;
  const remainder = ns % 1_000_000_000n;
  // Left-pad the fractional portion to 9 digits so `1.000000050s` renders
  // correctly rather than `1.50s`.
  const fractional = remainder.toString().padStart(9, '0');
  return `${seconds}.${fractional}s`;
}
