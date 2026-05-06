/**
 * Test-only client surrogate that mirrors `useSocketConnection`'s wire
 * handling exactly: it listens for `state` and the 15 typed delta
 * events, applies them via the shared `applyDelta` (the same function
 * the real client reducer calls), and tracks `lastSeenVersion` for gap
 * detection. Tests assert against `surrogate.state` to verify the
 * client converges to the same `MeetingState` the server holds.
 *
 * Two test-specific knobs on top of the production behaviour:
 *
 *   1. `dropNext` lets a test simulate a missed wire delta without
 *      actually severing the connection. Set it to a delta event name
 *      (or `true` to drop the very next delta of any kind); the
 *      surrogate silently ignores that one event and lets the next
 *      arrival trigger gap detection.
 *
 *   2. `events` records every event the surrogate has seen, so tests
 *      can assert that — for example — a `state` event arrived after a
 *      forced drop (i.e. the resync codepath actually fired).
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

  /** Mutable fault-injection knobs. */
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

  /** Tear down the surrogate's listeners. Does not disconnect the socket. */
  detach(): void;
}

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

  // --- delta listeners ---
  type DeltaEnvelope = { version: number };
  type DeltaListener = (delta: DeltaEnvelope) => void;
  const deltaListeners: { event: DeltaEventName; listener: DeltaListener }[] = [];
  for (const eventType of DELTA_EVENT_TYPES) {
    const listener: DeltaListener = (delta) => {
      // Forced-drop path: simulate a missed wire delta.
      if (options.dropNext === eventType || options.dropNext === true) {
        options.dropNext = null;
        // Still record it so tests can see the drop happened, but tag
        // it specially so they can distinguish. Notify waiters so a
        // pending `waitForNextEvent` resolves on the drop the same way
        // it would on an applied delta.
        events.push({ event: `${eventType}[dropped]`, version: delta.version });
        notifyWaiters();
        return;
      }
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
      }
      // Late/duplicate deltas are dropped silently, matching the real
      // client; deliberately skipped from `events` to avoid noise.
    };
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
    detach() {
      socket.off('state', handleState);
      for (const { event, listener } of deltaListeners) {
        socket.off(event, listener);
      }
    },
  };
}
