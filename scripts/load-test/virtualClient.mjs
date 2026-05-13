// One virtual TCQ participant for the load harness.
//
// Owns a single Socket.IO connection authenticated via the mock-auth
// `/api/dev/switch-user` endpoint, keeps a local replica of MeetingState
// in lockstep with the server using `applyDelta`, records per-event
// metrics, and exposes a small API the scenarios drive.
//
// One virtualClient ≈ one tab in a browser. The harness spawns N of them.

import { io } from 'socket.io-client';
import msgpackParser from 'socket.io-msgpack-parser';
import { applyDelta } from '@tcq/shared';

// Every typed delta the server can emit. Listed explicitly (rather than
// generated) so a new event added server-side surfaces here as a missing
// case rather than silently going unmeasured.
export const DELTA_EVENTS = [
  'chairs:updated',
  'agenda:added',
  'agenda:edited',
  'agenda:deleted',
  'agenda:reordered',
  'agenda:prologueSet',
  'agenda:epilogueSet',
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
];

// Probe topic format: `probe-<counter>-<emitMs>`. Plain ASCII so the
// inline-markdown validator on the server accepts it as-is.
export const PROBE_PREFIX = 'probe-';

/**
 * POST /api/dev/switch-user with `username` and return a `cookie` request
 * header string built from the response's Set-Cookie. Re-using the
 * exact pattern from seed-meeting.mjs so the auth flow stays consistent.
 */
async function switchUserCookie(serverUrl, username) {
  const res = await fetch(`${serverUrl}/api/dev/switch-user`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username }),
  });
  if (!res.ok) {
    throw new Error(`switch-user(${username}) failed: ${res.status} ${await res.text()}`);
  }
  const cookies = res.headers.getSetCookie?.() ?? [];
  return cookies.map((c) => c.split(';')[0]).join('; ');
}

/**
 * Spawn one virtual participant.
 *
 * Resolves once the initial `state` snapshot has arrived and the local
 * replica is seeded — so the caller can immediately start driving the
 * scenario without racing the join.
 */
export async function createVirtualClient({ serverUrl, username, meetingId, metrics, label = username }) {
  const t0Auth = performance.now();
  const cookie = await switchUserCookie(serverUrl, username);
  const tAuth = performance.now() - t0Auth;

  const socket = io(serverUrl, {
    transports: ['websocket'],
    extraHeaders: { cookie },
    parser: msgpackParser,
  });

  // Local mirror of MeetingState. Seeded by the first `state` event,
  // mutated by every delta via applyDelta.
  let state = null;
  // The latest version we've successfully applied. Used only for gap
  // detection; applyDelta itself doesn't validate ordering.
  let lastSeenVersion = null;

  // Per-client counters. Flushed at end-of-run by metrics.summarise().
  const counters = {
    label,
    username,
    deltasApplied: 0,
    bytesIn: 0,
    perEvent: {}, // event -> { count, bytes }
    resyncCount: 0,
    reconnectCount: 0,
    errorCount: 0,
  };
  for (const e of DELTA_EVENTS) counters.perEvent[e] = { count: 0, bytes: 0 };

  // Resolve once `state` arrives. If the connection drops before then we
  // reject so run.mjs can give up on this client.
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  socket.on('connect', () => {
    socket.emit('join', meetingId);
  });

  socket.on('connect_error', (err) => {
    counters.errorCount++;
    metrics.write('client_error', { label, kind: 'connect_error', message: String(err?.message ?? err) });
    rejectReady?.(err);
  });

  socket.on('error', (msg) => {
    counters.errorCount++;
    metrics.write('client_error', { label, kind: 'server_error', message: String(msg) });
  });

  socket.on('disconnect', (reason) => {
    metrics.write('disconnect', { label, reason });
  });

  socket.io.on('reconnect', () => {
    counters.reconnectCount++;
    metrics.write('reconnect', { label, count: counters.reconnectCount });
  });

  let firstState = true;
  socket.on('state', (snapshot) => {
    state = snapshot;
    lastSeenVersion = snapshot.operational?.version ?? null;
    if (firstState) {
      firstState = false;
      const tFirstState = performance.now() - t0Auth;
      metrics.write('client_ready', {
        label,
        username,
        authMs: tAuth,
        joinMs: tFirstState,
      });
      resolveReady?.();
      resolveReady = null;
      rejectReady = null;
    }
  });

  // Subscribe to every delta event, apply it, and record latency for
  // probe entries (queue:added with the probe topic prefix).
  for (const event of DELTA_EVENTS) {
    socket.on(event, (delta) => {
      // Defensive — an out-of-order delta arriving before the first
      // `state` would crash applyDelta. Drop it; the snapshot will
      // include its effects.
      if (!state) return;

      // Approximate wire size. msgpack-encoded payloads are smaller
      // than this in practice but the JSON length is a stable
      // upper-bound and good enough for trend analysis.
      const approxBytes = approxSize(delta);
      counters.bytesIn += approxBytes;
      counters.deltasApplied++;
      counters.perEvent[event].count++;
      counters.perEvent[event].bytes += approxBytes;

      // Latency probe — only queue:added carries the topic field where
      // the chair encodes the emit timestamp.
      if (event === 'queue:added' && typeof delta?.entry?.topic === 'string') {
        const topic = delta.entry.topic;
        if (topic.startsWith(PROBE_PREFIX)) {
          // Format: probe-<counter>-<emitMs>
          const parts = topic.split('-');
          const emitMs = Number(parts[2]);
          if (Number.isFinite(emitMs)) {
            const rttMs = Date.now() - emitMs;
            metrics.write('probe', { label, counter: parts[1], rttMs });
          }
        }
      }

      // Gap detection. Server is the source of truth: if the version
      // jumps by more than 1 we've missed a delta and must resync.
      if (typeof delta.version === 'number') {
        const expected = (lastSeenVersion ?? delta.version - 1) + 1;
        if (delta.version > expected) {
          counters.resyncCount++;
          metrics.write('resync_request', { label, expected, got: delta.version });
          socket.emit('state:resync');
          // Don't apply this delta — the upcoming `state` will supersede it.
          return;
        }
        lastSeenVersion = delta.version;
      }

      try {
        state = applyDelta(state, { type: event, delta });
      } catch (err) {
        counters.errorCount++;
        metrics.write('client_error', { label, kind: 'applyDelta_throw', event, message: String(err?.message ?? err) });
      }
    });
  }

  await ready;

  return {
    socket,
    counters,
    /** Read the live local replica. Don't mutate it. */
    getState: () => state,
    /** Untyped passthrough to socket.emit for scenarios. */
    emit: (...args) => socket.emit(...args),
    /** Drop the connection cleanly. */
    disconnect: () => socket.disconnect(),
    /** Force a disconnect+reconnect cycle to exercise the resync path. */
    bounce: () => {
      socket.disconnect();
      // Brief gap so the server registers the disconnect before the
      // client races back.
      setTimeout(() => socket.connect(), 100);
    },
  };
}

// Cheap, allocation-light approximation of the wire size of a delta.
// JSON.stringify is enough — we only need a stable signal for "is the
// payload getting bigger over the run", not absolute bytes-on-the-wire.
function approxSize(obj) {
  try {
    return Buffer.byteLength(JSON.stringify(obj), 'utf8');
  } catch {
    return 0;
  }
}
