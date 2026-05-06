/**
 * Socket-event counters surfaced on the admin diagnostics endpoint.
 *
 * Currently tracks `state:resync` requests — clients send these when
 * they detect a gap in the delta-version sequence. In steady state
 * resyncs should be vanishingly rare (essentially zero per meeting),
 * so a non-trivial running count is a useful signal that the realtime
 * delta path is dropping or mis-applying events somewhere.
 *
 * State is process-local and resets on restart, like the HTTP and
 * error-buffer counters.
 */

let stateResyncs = 0;

export function recordStateResync(): void {
  stateResyncs += 1;
}

export interface SocketCounters {
  stateResyncs: number;
}

export function getSocketCounters(): SocketCounters {
  return { stateResyncs };
}

/** Reset counters. Exposed only for tests. */
export function resetSocketCounters(): void {
  stateResyncs = 0;
}
