/**
 * HTTP request access-logging middleware.
 *
 * Emits one structured log entry per response, shaped for Cloud Logging's
 * special handling of `httpRequest` fields. When Cloud Logging sees a
 * top-level `httpRequest` object matching LogEntry.HttpRequest, it renders
 * the entry inline in the Logs Explorer and makes each field queryable as
 * a first-class attribute rather than a generic jsonPayload value.
 *
 *   https://cloud.google.com/logging/docs/reference/v2/rest/v2/LogEntry#HttpRequest
 *   https://cloud.google.com/logging/docs/structured-logging
 *
 * Authenticated user fields (`ghUsername`, `ghid`, `isAdmin`) ride alongside
 * at the top level — they're not part of the GCP schema but are the
 * primary thing we'll filter on.
 */

import type { RequestHandler } from 'express';
import { log, formatLatency } from './logger.js';

/** Truncate strings we log to avoid unbounded field sizes. */
const USER_AGENT_MAX = 200;

/**
 * Paths that should not be logged. Cloud Run's uptime probe hits
 * `/api/health` very frequently and it would dominate the log volume.
 */
const SKIP_PATHS = new Set(['/api/health']);

function selectSeverity(status: number): 'INFO' | 'WARNING' | 'ERROR' {
  if (status >= 500) return 'ERROR';
  if (status >= 400) return 'WARNING';
  return 'INFO';
}

/**
 * Shape the response side of a LogEntry.HttpRequest. Exported so the
 * Express error-handling middleware can produce a consistent payload
 * for the error entry it logs alongside the normal access log.
 */
export function buildHttpRequestField(
  req: {
    method: string;
    originalUrl: string;
    httpVersion: string;
    ip?: string;
    get(name: string): string | undefined;
  },
  status: number,
  latencyNs: bigint,
  responseSize: string | undefined,
): Record<string, unknown> {
  const httpRequest: Record<string, unknown> = {
    requestMethod: req.method,
    requestUrl: req.originalUrl,
    status,
    protocol: `HTTP/${req.httpVersion}`,
    latency: formatLatency(latencyNs),
  };

  const userAgent = req.get('user-agent');
  if (userAgent) httpRequest.userAgent = userAgent.slice(0, USER_AGENT_MAX);

  const referer = req.get('referer');
  if (referer) httpRequest.referer = referer;

  if (req.ip) httpRequest.remoteIp = req.ip;

  if (responseSize) httpRequest.responseSize = responseSize;

  return httpRequest;
}

/**
 * Extract the user identity fields to merge into a log entry, if any.
 * Grouped under `user` so attribution stays together and doesn't collide
 * with other top-level fields in Cloud Logging.
 */
export function buildUserFields(req: {
  session?: { user?: { ghid?: number; ghUsername?: string; isAdmin?: boolean } };
}): { user?: { ghid?: number; ghUsername?: string; isAdmin?: boolean } } {
  const u = req.session?.user;
  if (!u) return {};
  return { user: { ghid: u.ghid, ghUsername: u.ghUsername, isAdmin: u.isAdmin } };
}

/**
 * Express middleware that logs an access-log entry when the response
 * finishes. Must be mounted after session/auth middleware so `req.session.user`
 * is populated, and before the route handlers so every request passes
 * through.
 */
export const httpLogger: RequestHandler = (req, res, next) => {
  // Bypass health checks to avoid a constant stream of identical entries
  // from Cloud Run's uptime probe.
  if (SKIP_PATHS.has(req.path)) {
    next();
    return;
  }

  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const latencyNs = process.hrtime.bigint() - start;
    const contentLength = res.getHeader('content-length');
    // `content-length` from Express may be a number or a string; coerce to
    // the string form GCP expects (HttpRequest.responseSize is an int64).
    const responseSize =
      typeof contentLength === 'number'
        ? String(contentLength)
        : typeof contentLength === 'string'
          ? contentLength
          : undefined;

    const httpRequest = buildHttpRequestField(req, res.statusCode, latencyNs, responseSize);
    const severity = selectSeverity(res.statusCode);

    log(severity, 'http_request', {
      httpRequest,
      ...buildUserFields(req),
    });
  });

  next();
};
