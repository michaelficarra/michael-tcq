#!/usr/bin/env node
//
// Load-test worker process.
//
// Hosted by run.mjs as a child process via child_process.fork. Owns a
// slice of the virtual participants — typically a few hundred — so the
// per-process CPU and heap stay below the single-process ceiling we hit
// somewhere around 1k clients in one Node process.
//
// IPC protocol with the parent:
//
//   parent → worker:
//     { type: 'init', meetingId, serverUrl, scenario }
//     { type: 'add_client', username }
//     { type: 'stop' }
//
//   worker → parent:
//     { type: 'ready' }
//     { type: 'metrics', samples: [...] }    // batched every ~100 ms
//     { type: 'client_added', username }
//     { type: 'client_failed', username, error }
//     { type: 'fatal', message }

import { createVirtualClient } from './virtualClient.mjs';

let config = null;
let scenarioModule = null;
const clients = new Map(); // username -> { client, behavior }
const metrics = createRemoteMetrics();

// Ship metrics to the parent in 100-ms batches so per-event IPC overhead
// doesn't swamp the worker's event loop. flushNow is exposed so the
// shutdown path can drain pending samples before the worker exits.
function createRemoteMetrics() {
  let buffer = [];
  let flushTimer = null;
  function flush() {
    if (buffer.length > 0) {
      try {
        process.send({ type: 'metrics', samples: buffer });
      } catch {
        // Parent may have already disconnected; lose the batch.
      }
      buffer = [];
    }
    flushTimer = null;
  }
  return {
    write(category, data) {
      buffer.push({ ts: Date.now(), category, ...data });
      if (!flushTimer) flushTimer = setTimeout(flush, 100);
    },
    // Workers don't compute their own summary — `all()` and `close()`
    // are no-ops here. The parent's metrics is the source of truth.
    all() {
      return [];
    },
    close() {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      flush();
      return Promise.resolve();
    },
  };
}

process.on('message', async (msg) => {
  try {
    if (msg.type === 'init') {
      config = msg;
      // Dynamic import so the worker only loads the scenario it needs.
      // Path is relative to this file (scripts/load-test/worker.mjs).
      const url = msg.scenario === 'stress' ? './scenarios/stress.mjs' : './scenarios/plenary.mjs';
      scenarioModule = await import(url);
      process.send({ type: 'ready' });
    } else if (msg.type === 'add_client') {
      try {
        const client = await createVirtualClient({
          serverUrl: config.serverUrl,
          username: msg.username,
          meetingId: config.meetingId,
          metrics,
          label: msg.username,
        });
        const behavior = scenarioModule.startParticipantBehavior(client, {}, metrics);
        clients.set(msg.username, { client, behavior });
        process.send({ type: 'client_added', username: msg.username });
      } catch (err) {
        process.send({ type: 'client_failed', username: msg.username, error: String(err?.message ?? err) });
      }
    } else if (msg.type === 'stop') {
      for (const { client, behavior } of clients.values()) {
        try {
          behavior.stop();
        } catch {
          // ignore individual cleanup errors — best effort
        }
        try {
          client.disconnect();
        } catch {
          // ignore
        }
      }
      clients.clear();
      await metrics.close();
      // Brief delay to let the final metrics batch flush via the IPC
      // pipe before exit() yanks it.
      setTimeout(() => process.exit(0), 200);
    }
  } catch (err) {
    try {
      process.send({ type: 'fatal', message: String(err?.message ?? err) });
    } catch {
      // parent disconnected
    }
    process.exit(1);
  }
});

// Surface uncaught errors to the parent so a crashing worker doesn't
// just vanish silently.
process.on('uncaughtException', (err) => {
  try {
    process.send({ type: 'fatal', message: `uncaught: ${err?.message ?? err}` });
  } catch {
    // ignore
  }
  process.exit(1);
});

// If the parent dies, the worker would otherwise linger forever — exit
// cleanly so it doesn't hold port allocations or open sockets.
process.on('disconnect', () => {
  process.exit(0);
});
