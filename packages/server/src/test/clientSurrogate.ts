/**
 * Test-only client surrogate that mirrors `useSocketConnection`'s wire
 * handling exactly: it listens for `state` and the 15 typed delta
 * events, applies them via the shared `applyDelta` (the same function
 * the real client reducer calls), and tracks `lastSeenVersion` for gap
 * detection. Tests assert against `surrogate.state` to verify the
 * client converges to the same `MeetingState` the server holds.
 *
 * Fault-injection knobs on top of the production behaviour:
 *
 *   1. `options.dropNext` — simulate a missed wire delta without
 *      actually severing the connection. Set to a delta event name
 *      (or `true` to drop the very next delta of any kind); the
 *      surrogate silently ignores that one event and lets the next
 *      arrival trigger gap detection.
 *
 *   2. `delayNext(event, ms)` — hold the next matching delta for `ms`
 *      milliseconds before processing it. Models a delivery that
 *      arrives late but eventually does arrive.
 *
 *   3. `reorderNext(count, permutation?)` — buffer the next `count`
 *      deltas and process them in the given permutation (default:
 *      reverse arrival order). Models out-of-order delivery without
 *      rewriting what the server emitted.
 *
 *   4. `partition(durationMs)` — buffer ALL incoming deltas for
 *      `durationMs`, then flush them in arrival order. Models a
 *      logical partition shorter than the reconnection threshold.
 *
 *   5. `events` records every event the surrogate has seen, so tests
 *      can assert that — for example — a `state` event arrived after a
 *      forced drop (i.e. the resync codepath actually fired).
 *
 * The four fault hooks are mutually exclusive at any instant: a
 * single-shot `dropNext` takes precedence, then `partition`, then
 * `reorderNext`, then `delayNext`. Tests should arm at most one at a
 * time.
 */

import type { Socket as ClientSocket } from 'socket.io-client';
import {
  applyDelta,
  type ClientToServerEvents,
  type MeetingDeltaAction,
  type MeetingState,
  type ServerToClientEvents,
} from '@tcq/shared';

/** Socket.IO client typed against TCQ's events. */
type TypedClientSocket = ClientSocket<ServerToClientEvents, ClientToServerEvents>;

/**
 * Names of the events the surrogate handles as state-mutation deltas
 * (everything that participates in version sequencing). Mirrors
 * `DELTA_EVENT_TYPES` in `useSocketConnection.ts`.
 */
const DELTA_EVENT_TYPES = [
  'chairs:updated',
  'agenda:added',
  'agenda:edited',
  'agenda:deleted',
  'agenda:reordered',
  'queue:added',
  'queue:edited',
  'queue:removed',
  'queue:reordered',
  'queue:closedChanged',
  'speaker:advanced',
  'agenda:advanced',
  'poll:started',
  'poll:stopped',
  'poll:reacted',
] as const satisfies readonly MeetingDeltaAction['type'][];

type DeltaEventName = (typeof DELTA_EVENT_TYPES)[number];

/** Configuration for fault injection. */
export interface SurrogateOptions {
  /**
   * Drop the next received event of this type (or any delta if `true`)
   * exactly once. After dropping, the field is cleared. Used to
   * simulate a missed delta and verify the gap-detection codepath.
   */
  dropNext?: DeltaEventName | true | null;
}

export interface ClientSurrogate {
  /** The most recent `MeetingState` the surrogate has applied. */
  readonly state: MeetingState | null;

  /**
   * Highest `operational.version` the surrogate has applied. `null`
   * before any `state` event has arrived.
   */
  readonly lastSeenVersion: number | null;

  /**
   * Total number of `state:resync` requests this surrogate has
   * issued — incremented every time it detects a forward version gap.
   */
  readonly resyncRequestCount: number;

  /**
   * Sequence of (event, version-or-null) pairs the surrogate has
   * received, in arrival order. Useful for asserting that — for
   * example — a `state` event arrived after a forced drop.
   */
  readonly events: readonly { event: string; version: number | null }[];

  /** Mutable fault-injection knobs (single-shot drop only). */
  readonly options: SurrogateOptions;

  /**
   * Resolve once the surrogate has applied at least one event after
   * `marker`. Default `marker` is the current `events.length`.
   */
  waitForNextEvent(marker?: number): Promise<void>;

  /**
   * Resolve once the surrogate's lastSeenVersion has reached at least
   * `version`. Used by tests waiting for a specific delta or resync to
   * land.
   */
  waitForVersion(version: number): Promise<void>;

  /**
   * Hold the next delta of `event` (or any delta, if `true`) for `ms`
   * milliseconds before processing it. Single-shot: applies to exactly
   * one delta and then clears.
   */
  delayNext(event: DeltaEventName | true, ms: number): void;

  /**
   * Buffer the next `count` deltas to arrive, then process them in the
   * given `permutation` (an array of indices into the buffer). The
   * default permutation reverses arrival order, so e.g.
   * `reorderNext(3)` delivers the 3rd-then-2nd-then-1st arrival to the
   * application logic.
   */
  reorderNext(count: number, permutation?: readonly number[]): void;

  /**
   * Stop processing any deltas for `durationMs` while leaving the
   * underlying socket connected. After the duration elapses, all
   * buffered deltas are flushed in arrival order.
   */
  partition(durationMs: number): void;

  /** Tear down the surrogate's listeners. Does not disconnect the socket. */
  detach(): void;
}

/** A delta envelope as it arrives off the wire. */
type DeltaEnvelope = { version: number };

/** A delta held in a fault-injection buffer. */
type BufferedDelta = { eventType: DeltaEventName; delta: DeltaEnvelope };

/**
 * Wrap a connected Socket.IO client with the version-tracking and
 * delta-application logic the real React client runs in
 * `useSocketConnection` + `MeetingContext`. The socket should already
 * have completed the `join` handshake (so a `state` event is incoming
 * or about to arrive) — the surrogate seeds itself off the first
 * `state` event it sees.
 */
export function createClientSurrogate(socket: TypedClientSocket, options: SurrogateOptions = {}): ClientSurrogate {
  let state: MeetingState | null = null;
  let lastSeenVersion: number | null = null;
  let resyncRequestCount = 0;
  const events: { event: string; version: number | null }[] = [];
  const waiters: (() => void)[] = [];
  const versionWaiters: { version: number; resolve: () => void }[] = [];

  // Fault-injection state. At most one of delayState / reorderState /
  // partitionUntil should be set at a time; tests are expected to arm a
  // single fault, drive deltas through it, and let it clear before
  // arming another. Concurrent faults aren't supported and the priority
  // order in `deliver()` is the documented behaviour if a test does it.
  let delayState: { event: DeltaEventName | true; ms: number } | null = null;
  let reorderState: {
    remaining: number;
    buffer: BufferedDelta[];
    permutation: readonly number[] | null;
  } | null = null;
  // Binary flag rather than a timestamp comparison so a delta arriving
  // after `partitionUntil` but before the flush timer fires can't slip
  // past while older buffered deltas are still waiting — that ordering
  // would surface buffered deltas as late duplicates and silently drop
  // them.
  let partitioned = false;
  let partitionBuffer: BufferedDelta[] = [];
  // Outstanding setTimeout handles, cleared on detach so tests don't
  // leak timers past their lifetime.
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();

  function notifyWaiters() {
    while (waiters.length > 0) waiters.shift()!();
    if (lastSeenVersion !== null) {
      const remaining: typeof versionWaiters = [];
      for (const w of versionWaiters) {
        if (lastSeenVersion >= w.version) w.resolve();
        else remaining.push(w);
      }
      versionWaiters.length = 0;
      versionWaiters.push(...remaining);
    }
  }

  // --- state listener ---
  function handleState(meeting: MeetingState) {
    state = meeting;
    lastSeenVersion = meeting.operational.version;
    events.push({ event: 'state', version: lastSeenVersion });
    notifyWaiters();
  }
  socket.on('state', handleState);

  /**
   * The "real" per-delta logic — applied once a delta has cleared all
   * fault-injection gates. Mirrors what `useSocketConnection` does on
   * the real client.
   */
  function processDelta(eventType: DeltaEventName, delta: DeltaEnvelope) {
    const lastSeen = lastSeenVersion;
    if (lastSeen === null) return;
    const expected = lastSeen + 1;
    if (delta.version === expected) {
      lastSeenVersion = delta.version;
      if (state) {
        state = applyDelta(state, { type: eventType, delta } as MeetingDeltaAction);
      }
      events.push({ event: eventType, version: delta.version });
      notifyWaiters();
      return;
    }
    if (delta.version > expected) {
      resyncRequestCount += 1;
      events.push({ event: `${eventType}[gap]`, version: delta.version });
      socket.emit('state:resync');
      notifyWaiters();
      return;
    }
    // Late/duplicate deltas (delta.version <= lastSeen) are dropped
    // silently, matching the real client; deliberately skipped from
    // `events` to avoid noise.
  }

  /**
   * Receive-side dispatcher. Decides whether the delta is dropped,
   * buffered (partition / reorder), delayed, or processed immediately.
   * Called from every delta listener.
   */
  function deliver(eventType: DeltaEventName, delta: DeltaEnvelope) {
    // Forced drop — single-shot, takes precedence so existing tests
    // using `options.dropNext` keep their semantics.
    if (options.dropNext === eventType || options.dropNext === true) {
      options.dropNext = null;
      events.push({ event: `${eventType}[dropped]`, version: delta.version });
      notifyWaiters();
      return;
    }
    // Partition: buffer until release, regardless of other knobs.
    if (partitioned) {
      partitionBuffer.push({ eventType, delta });
      return;
    }
    // Reorder: buffer until N collected, then deliver in permutation
    // order via processDelta directly (don't re-enter `deliver` to
    // avoid double-application of other faults).
    if (reorderState !== null) {
      reorderState.buffer.push({ eventType, delta });
      reorderState.remaining -= 1;
      if (reorderState.remaining === 0) {
        const buf = reorderState.buffer;
        // Default: deliver in reverse arrival order. Indices [n-1, ..., 0].
        const perm = reorderState.permutation ?? buf.map((_, i) => buf.length - 1 - i);
        reorderState = null;
        for (const i of perm) processDelta(buf[i].eventType, buf[i].delta);
      }
      return;
    }
    // Delay: schedule processing for later.
    if (delayState !== null && (delayState.event === eventType || delayState.event === true)) {
      const ms = delayState.ms;
      delayState = null;
      const timer = setTimeout(() => {
        pendingTimers.delete(timer);
        processDelta(eventType, delta);
      }, ms);
      pendingTimers.add(timer);
      return;
    }
    // No fault armed — process synchronously.
    processDelta(eventType, delta);
  }

  // --- delta listeners ---
  type DeltaListener = (delta: DeltaEnvelope) => void;
  const deltaListeners: { event: DeltaEventName; listener: DeltaListener }[] = [];
  for (const eventType of DELTA_EVENT_TYPES) {
    const listener: DeltaListener = (delta) => deliver(eventType, delta);
    socket.on(eventType, listener);
    deltaListeners.push({ event: eventType, listener });
  }

  return {
    get state() {
      return state;
    },
    get lastSeenVersion() {
      return lastSeenVersion;
    },
    get resyncRequestCount() {
      return resyncRequestCount;
    },
    get events() {
      return events;
    },
    options,
    waitForNextEvent(marker = events.length) {
      return new Promise<void>((resolve) => {
        if (events.length > marker) {
          resolve();
          return;
        }
        waiters.push(resolve);
      });
    },
    waitForVersion(version) {
      return new Promise<void>((resolve) => {
        if (lastSeenVersion !== null && lastSeenVersion >= version) {
          resolve();
          return;
        }
        versionWaiters.push({ version, resolve });
      });
    },
    delayNext(event, ms) {
      delayState = { event, ms };
    },
    reorderNext(count, permutation) {
      if (count < 1) throw new Error('reorderNext: count must be >= 1');
      if (permutation !== undefined) {
        if (permutation.length !== count) {
          throw new Error('reorderNext: permutation length must equal count');
        }
        const seen = new Set(permutation);
        if (seen.size !== count) {
          throw new Error('reorderNext: permutation must contain each index exactly once');
        }
        for (const i of permutation) {
          if (!Number.isInteger(i) || i < 0 || i >= count) {
            throw new Error('reorderNext: permutation indices must be integers in [0, count)');
          }
        }
      }
      reorderState = { remaining: count, buffer: [], permutation: permutation ?? null };
    },
    partition(durationMs) {
      if (durationMs < 0) throw new Error('partition: durationMs must be >= 0');
      partitioned = true;
      const timer = setTimeout(() => {
        pendingTimers.delete(timer);
        partitioned = false;
        const buf = partitionBuffer;
        partitionBuffer = [];
        // Flush in arrival order through the normal per-delta path.
        // Faults armed during the partition are not re-evaluated for
        // the buffered deltas — the partition consumes them.
        for (const b of buf) processDelta(b.eventType, b.delta);
      }, durationMs);
      pendingTimers.add(timer);
    },
    detach() {
      socket.off('state', handleState);
      for (const { event, listener } of deltaListeners) {
        socket.off(event, listener);
      }
      for (const t of pendingTimers) clearTimeout(t);
      pendingTimers.clear();
    },
  };
}
