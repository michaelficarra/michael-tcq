/**
 * HTTP response counters.
 *
 * Bumped from the access-log middleware on every response so the admin
 * diagnostics endpoint can summarise traffic since process start
 * without requiring a Cloud Logging query. Three counters: total
 * responses, 4xx responses, 5xx responses.
 *
 * State is process-local and resets on restart, like the error ring.
 */

let total = 0;
let clientErrors = 0;
let serverErrors = 0;

export function recordHttpResponse(status: number): void {
  total += 1;
  if (status >= 500) serverErrors += 1;
  else if (status >= 400) clientErrors += 1;
}

export interface HttpCounters {
  total: number;
  clientErrors: number;
  serverErrors: number;
}

export function getHttpCounters(): HttpCounters {
  return { total, clientErrors, serverErrors };
}

/** Reset counters. Exposed only for tests. */
export function resetHttpCounters(): void {
  total = 0;
  clientErrors = 0;
  serverErrors = 0;
}
