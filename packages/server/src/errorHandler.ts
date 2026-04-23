/**
 * Express error-handling middleware.
 *
 * Catches errors that propagate from route handlers (thrown synchronously
 * or via `next(err)`) and emits a structured log entry before responding.
 * Express 5 automatically funnels rejected-promise returns from route
 * handlers into this chain too.
 *
 * The httpLogger's `finish` listener still emits the normal access-log
 * entry for the 500 response. This handler's entry is in addition and
 * carries the serialised stack trace.
 */

import type { ErrorRequestHandler } from 'express';
import { error as logError, serialiseError } from './logger.js';
import { buildHttpRequestField, buildUserFields } from './httpLogger.js';

export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  const httpRequest = buildHttpRequestField(req, 500, 0n, undefined);
  logError('http_request_error', {
    httpRequest,
    ...buildUserFields(req),
    error: serialiseError(err),
  });
  if (res.headersSent) {
    // Headers already flushed — delegate to Express's default, which aborts
    // the connection. Nothing else we can safely do here.
    next(err);
    return;
  }
  res.status(500).json({ error: 'Internal server error' });
};
