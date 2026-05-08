#!/usr/bin/env node
//
// TCQ load-test orchestrator (multi-process driver).
//
// Architecture:
//
//   parent (this file)
//     ├── provisions the fixture meeting
//     ├── connects the chair virtualClient (drives meeting flow)
//     ├── runs chair-side scenario behavior (probe, advances, polls)
//     ├── polls server diagnostics (/api/admin/diagnostics)
//     └── forks N worker processes and routes add_client requests
//
//   worker (worker.mjs)
//     ├── owns ~allClients/N participant virtualClients
//     ├── runs participant-side scenario behavior per client
//     └── ships metrics samples back over IPC in 100-ms batches
//
// One process can hold ~700–1000 socket.io-client instances before its
// V8 heap and event loop saturate; multi-process distributes that
// across cores so we can characterise the server independently of the
// driver's own ceiling.
//
// Output goes to scripts/load-test/runs/<timestamp>/{events.jsonl,summary.md}.
//
// Usage:
//   node scripts/load-test/run.mjs --scenario plenary --stages 25,50,100 --stage-ms 60000
//
// Prerequisites:
//   - Server running locally with mock auth (no GITHUB_CLIENT_ID set).
//   - Server started with ADMIN_USERNAMES=load-admin so the orchestrator
//     can poll /api/admin/diagnostics. The harness's chair user is
//     `load-admin` and that user is also the meeting chair, so the same
//     session has admin + chair powers.
//
// The harness deliberately does NOT auto-start the server — it should
// run against an `npm run dev` you can observe (CPU, memory, logs).

import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { fork } from 'node:child_process';
import os from 'node:os';
import { io } from 'socket.io-client';
import msgpackParser from 'socket.io-msgpack-parser';
import { applyDelta } from '@tcq/shared';

import { createVirtualClient } from './virtualClient.mjs';
import { createMetrics, summariseLatency } from './metrics.mjs';
import { startServerProbe } from './serverProbe.mjs';

// --- Constants ------------------------------------------------------------

const SERVER = process.env.LOAD_TEST_SERVER ?? 'http://localhost:3000';
const ADMIN_USERNAME = 'load-admin';
const PARTICIPANT_PREFIX = 'load-';

const STOP_DEFAULTS = {
  latencyMedianMs: 1000,
  latencyP99Ms: 5000,
  dirtyBacklog: 50,
  rssMb: 400,
  errorRate: 0.01,
  warmupMs: 5000,
};

// Target participant count per worker process. Determined empirically:
// one Node process holds ~700–1000 socket.io-client instances before
// its V8 heap and event loop saturate, but it starts dropping ping
// responses well before then. ~100 per worker keeps per-process load
// comfortably below that ceiling, leaves plenty of CPU headroom for
// applyDelta and per-event metrics, and is the default the user
// settled on after live ramp testing.
const PARTICIPANTS_PER_WORKER = 100;

// Hard ceiling on worker count to avoid pathological cases (e.g. a
// stage of 100k clients would otherwise try to fork 1000 workers).
// 64 leaves the user well-resourced for any realistic scenario without
// running into PID/fd limits on a typical dev box.
const MAX_WORKERS = 64;

function computeDefaultWorkers(stages) {
  const maxStage = Math.max(...stages, 1);
  return Math.min(MAX_WORKERS, Math.max(1, Math.ceil(maxStage / PARTICIPANTS_PER_WORKER)));
}

// --- CLI parsing ----------------------------------------------------------

function parseArgs(argv) {
  const args = {
    scenario: 'plenary',
    stages: [25, 50, 75, 100, 150, 200],
    stageMs: null,
    workers: null, // resolved below from max stage size
    stop: { ...STOP_DEFAULTS },
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--scenario') args.scenario = argv[++i];
    else if (a === '--stages') args.stages = argv[++i].split(',').map((n) => Number(n.trim()));
    else if (a === '--stage-ms') args.stageMs = Number(argv[++i]);
    else if (a === '--workers') args.workers = Number(argv[++i]);
    else if (a === '--rss-mb') args.stop.rssMb = Number(argv[++i]);
    else if (a === '--latency-median-ms') args.stop.latencyMedianMs = Number(argv[++i]);
    else if (a === '--latency-p99-ms') args.stop.latencyP99Ms = Number(argv[++i]);
    else if (a === '--no-stop') args.noStop = true;
    else if (a === '--help' || a === '-h') {
      console.log(`Usage: node scripts/load-test/run.mjs [options]
  --scenario <plenary|stress>   Workload to run (default: plenary).
  --stages <n,n,n>              Cumulative client counts per stage.
                                Default: 25,50,75,100,150,200
  --stage-ms <ms>               Per-stage duration. Default: plenary=600000 (10m),
                                stress=180000 (3m).
  --workers <n>                 Number of worker processes. Default: derived
                                as ceil(max-stage / ${PARTICIPANTS_PER_WORKER}),
                                capped at ${MAX_WORKERS}. So a max stage of 100
                                gets 1 worker, 1000 gets 10, 10000 gets ${MAX_WORKERS}.
                                Override only when characterising the
                                per-process ceiling itself or with unusual
                                memory constraints. Available cores on this
                                machine: ${os.cpus().length}.
  --rss-mb <n>                  Stop if server RSS exceeds this (default: 400 MB).
  --latency-median-ms <n>       Stop if median probe RTT exceeds this (default: 1000).
  --latency-p99-ms <n>          Stop if p99 probe RTT exceeds this (default: 5000).
  --no-stop                     Run every stage to completion regardless.`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (args.stageMs == null) args.stageMs = args.scenario === 'stress' ? 3 * 60_000 : 10 * 60_000;
  if (args.workers == null) args.workers = computeDefaultWorkers(args.stages);
  return args;
}

// --- Auth helper (only for fixture provisioning + admin probe cookie) ----

async function switchUserCookie(username) {
  const res = await fetch(`${SERVER}/api/dev/switch-user`, {
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

// --- Fixture meeting provisioning ----------------------------------------

const AGENDA_NAMES = [
  'Iterator helpers for Stage 4',
  'Pattern matching for Stage 2.7',
  'Temporal API: normative changes',
  'Async context for Stage 3',
  'Explicit resource management',
  'Decimal for Stage 2',
  'Joint iteration for Stage 2.7',
  'Signals for Stage 1',
  'Promise.withResolvers for Stage 4',
  'Set methods: Stage 4 fix',
  'RegExp modifiers for Stage 4',
  'Float16Array for Stage 3',
  'Error.isError for Stage 3',
  'Import attributes for Stage 4',
  'ShadowRealm: Stage 3 update',
  'Throw expressions for Stage 2',
  'Extractors for Stage 2',
  'Math.sum for Stage 2.7',
  'Symbol predicates for Stage 3',
  'Intl.MessageFormat for Stage 2',
  'String.dedent for Stage 2.7',
  'Structs for Stage 2',
  'Source phase imports update',
  'Module harmony status',
  'Array grouping follow-up',
  'Atomics.pause report',
  'Pipeline operator alternatives',
  'Decorator metadata interop',
  'Type annotations: parser feedback',
  'Test262 status update',
];

const SESSION_BLOCKS = [
  { name: 'Day 1 — Morning Session', capacity: 210 },
  { name: 'Day 1 — Afternoon Session', capacity: 210 },
  { name: 'Day 2 — Morning Session', capacity: 210 },
  { name: 'Day 2 — Afternoon Session', capacity: 210 },
];

async function provisionFixtureMeeting() {
  await switchUserCookie(ADMIN_USERNAME);
  const adminCookie = await switchUserCookie(ADMIN_USERNAME);
  const createRes = await fetch(`${SERVER}/api/meetings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({ chairs: [ADMIN_USERNAME] }),
  });
  if (!createRes.ok) {
    throw new Error(`create meeting failed: ${createRes.status} ${await createRes.text()}`);
  }
  const { id: meetingId } = await createRes.json();

  await new Promise((doneSeed, failSeed) => {
    const socket = io(SERVER, {
      transports: ['websocket'],
      extraHeaders: { cookie: adminCookie },
      parser: msgpackParser,
    });

    let state = null;
    const actions = [];

    for (const name of AGENDA_NAMES) {
      actions.push(() => socket.emit('agenda:add', { name, presenterUsernames: [ADMIN_USERNAME], duration: 15 }));
    }
    let sessionTargets = null;
    SESSION_BLOCKS.forEach((session, k) => {
      actions.push(() => {
        if (sessionTargets === null) {
          const itemIds = state.agenda.filter((e) => e.kind !== 'session').map((e) => e.id);
          const N = itemIds.length;
          const K = SESSION_BLOCKS.length;
          sessionTargets = SESSION_BLOCKS.map((_, i) => {
            const idx = Math.floor((i * N) / K);
            return idx === 0 ? null : itemIds[idx - 1];
          });
        }
        socket.emit('session:add', { name: session.name, capacity: session.capacity });
      });
      actions.push(() => {
        const newSessionId = state.agenda.at(-1).id;
        socket.emit('agenda:reorder', { id: newSessionId, afterId: sessionTargets[k] });
      });
    });

    let i = 0;
    function step() {
      if (i >= actions.length) {
        socket.disconnect();
        doneSeed();
        return;
      }
      const action = actions[i++];
      action();
    }

    socket.on('connect', () => socket.emit('join', meetingId));
    socket.on('error', (msg) => failSeed(new Error(`fixture seed error: ${msg}`)));
    socket.on('state', (s) => {
      state = s;
      step();
    });
    for (const e of ['agenda:added', 'agenda:reordered']) {
      socket.on(e, (delta) => {
        state = applyDelta(state, { type: e, delta });
        step();
      });
    }
    setTimeout(() => failSeed(new Error('fixture seed timed out')), 30_000);
  });

  return { meetingId, adminCookie };
}

// --- Worker pool ----------------------------------------------------------
//
// Each worker is a forked Node process running worker.mjs. The parent
// holds an array of `{ proc, ready, pendingAdds }` records and routes
// add_client requests round-robin. Worker → parent metrics arrive as
// batches and are appended to the same metrics stream the chair and
// server-probe write to.

function spawnWorker({ workerId, scenario, meetingId, metrics }) {
  const proc = fork(resolve(import.meta.dirname, 'worker.mjs'), [], {
    env: process.env,
    silent: false,
  });

  let resolveReady;
  const ready = new Promise((res) => {
    resolveReady = res;
  });

  // Per-stage callback slot. main() sets this before sending add_client
  // requests and clears it once the stage's pending acks all arrive.
  // Using a slot rather than ad-hoc listener swapping keeps the
  // persistent message handler simple and avoids races where a metrics
  // batch arrives in the gap between removeListener / addListener.
  const handle = { workerId, proc, ready, onClientResult: null };

  proc.on('message', (msg) => {
    if (msg.type === 'ready') {
      resolveReady();
    } else if (msg.type === 'metrics') {
      metrics.appendBatch(msg.samples);
    } else if (msg.type === 'client_added' || msg.type === 'client_failed') {
      if (msg.type === 'client_failed') {
        metrics.write('client_error', {
          label: msg.username,
          kind: 'create_threw',
          message: msg.error,
        });
      }
      handle.onClientResult?.(workerId, msg);
    } else if (msg.type === 'fatal') {
      console.error(`[worker ${workerId}] fatal: ${msg.message}`);
    }
  });

  proc.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) {
      console.error(`[worker ${workerId}] exited unexpectedly (code=${code}, signal=${signal})`);
      metrics.write('worker_exit', { workerId, code, signal });
    }
  });

  proc.send({ type: 'init', meetingId, serverUrl: SERVER, scenario });

  return handle;
}

// --- Stop-condition evaluation -------------------------------------------

function evaluateStopConditions({ samples, stop, sinceMs }) {
  const recentProbe = samples.filter((s) => s.category === 'probe' && s.ts >= sinceMs).map((s) => s.rttMs);
  if (recentProbe.length >= 5) {
    const summary = summariseLatency(recentProbe);
    if (summary.p50 > stop.latencyMedianMs) {
      return { hit: 'latency_median', value: summary.p50, threshold: stop.latencyMedianMs };
    }
    if (summary.p99 > stop.latencyP99Ms) {
      return { hit: 'latency_p99', value: summary.p99, threshold: stop.latencyP99Ms };
    }
  }
  const recentDiag = samples.filter((s) => s.category === 'server_diag' && s.ts >= sinceMs);
  for (const d of recentDiag) {
    if (d.rssMb > stop.rssMb) return { hit: 'rss', value: d.rssMb, threshold: stop.rssMb };
    if (d.dirtyCount > stop.dirtyBacklog) {
      return { hit: 'dirty_backlog', value: d.dirtyCount, threshold: stop.dirtyBacklog };
    }
  }
  const recentHealth = samples.filter((s) => s.category === 'server_health' && s.ts >= sinceMs);
  const healthMisses = recentHealth.filter((s) => s.ok === false).length;
  if (healthMisses >= 3) return { hit: 'health_failed', value: healthMisses, threshold: 3 };

  const recentClientErrors = samples.filter((s) => s.category === 'client_error' && s.ts >= sinceMs).length;
  const recentClientReady = samples.filter((s) => s.category === 'client_ready').length;
  if (recentClientReady > 0 && recentClientErrors / Math.max(1, recentClientReady) > stop.errorRate) {
    return {
      hit: 'client_error_rate',
      value: recentClientErrors / recentClientReady,
      threshold: stop.errorRate,
    };
  }
  return null;
}

// --- Summary writer ------------------------------------------------------

function writeSummary({ summaryPath, args, runStart, stages, stopReason, samples }) {
  const lines = [];
  const wallSeconds = ((Date.now() - runStart) / 1000).toFixed(0);
  lines.push(`# Load-test run summary`);
  lines.push('');
  lines.push(`- Scenario: \`${args.scenario}\``);
  lines.push(`- Workers: ${args.workers}`);
  lines.push(`- Wall-clock duration: ${wallSeconds} s`);
  lines.push(`- Stages reached: ${stages.length}`);
  lines.push(
    `- Stop reason: ${stopReason ? `**${stopReason.hit}** (${JSON.stringify(stopReason)})` : 'completed normally'}`,
  );
  lines.push('');
  lines.push(`## Per-stage probe latency (ms)`);
  lines.push('');
  lines.push(`| Stage | Clients | Probe samples | p50 | p95 | p99 | max |`);
  lines.push(`|------:|--------:|--------------:|----:|----:|----:|----:|`);
  for (const stage of stages) {
    const probes = samples
      .filter((s) => s.category === 'probe' && s.ts >= stage.startedAt && s.ts <= (stage.endedAt ?? Date.now()))
      .map((s) => s.rttMs);
    const sum = summariseLatency(probes);
    lines.push(
      `| ${stage.index} | ${stage.clients} | ${sum.count ?? 0} | ${fmt(sum.p50)} | ${fmt(sum.p95)} | ${fmt(sum.p99)} | ${fmt(sum.max)} |`,
    );
  }
  lines.push('');
  lines.push(`## Server resource peaks per stage`);
  lines.push('');
  lines.push(`| Stage | Peak RSS (MB) | Peak heap (MB) | Peak dirty backlog | Resync requests Δ |`);
  lines.push(`|------:|--------------:|---------------:|-------------------:|------------------:|`);
  for (const stage of stages) {
    const diag = samples.filter(
      (s) => s.category === 'server_diag' && s.ts >= stage.startedAt && s.ts <= (stage.endedAt ?? Date.now()),
    );
    const peakRss = diag.length === 0 ? null : Math.max(...diag.map((d) => d.rssMb ?? 0));
    const peakHeap = diag.length === 0 ? null : Math.max(...diag.map((d) => d.heapUsedMb ?? 0));
    const peakDirty = diag.length === 0 ? null : Math.max(...diag.map((d) => d.dirtyCount ?? 0));
    const firstResync = diag[0]?.resyncRequests ?? null;
    const lastResync = diag.at(-1)?.resyncRequests ?? null;
    const resyncDelta = firstResync != null && lastResync != null ? lastResync - firstResync : null;
    lines.push(`| ${stage.index} | ${fmt(peakRss)} | ${fmt(peakHeap)} | ${fmt(peakDirty)} | ${fmt(resyncDelta)} |`);
  }
  lines.push('');
  lines.push(`## Aggregate event counts`);
  lines.push('');
  // Counts derived directly from the events stream, since per-client
  // counters live in worker processes and aren't directly addressable
  // from the parent. The events stream is the source of truth.
  const count = (cat) => samples.filter((s) => s.category === cat).length;
  lines.push(`- Client connects (\`client_ready\`): ${count('client_ready')}`);
  lines.push(`- Client errors (\`client_error\`): ${count('client_error')}`);
  lines.push(`- Resync requests (\`resync_request\`): ${count('resync_request')}`);
  lines.push(`- Reconnect events (\`reconnect\`): ${count('reconnect')}`);
  lines.push(`- Disconnect events (\`disconnect\`): ${count('disconnect')}`);
  lines.push(`- Probe samples received: ${count('probe')}`);
  lines.push('');
  writeFileSync(summaryPath, lines.join('\n'));
}

function fmt(n) {
  if (n == null) return '—';
  if (typeof n !== 'number') return String(n);
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

// --- Main ----------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);

  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = resolve(import.meta.dirname, 'runs', runId);
  const eventsPath = resolve(runDir, 'events.jsonl');
  const summaryPath = resolve(runDir, 'summary.md');
  const metrics = createMetrics(eventsPath);
  console.log(`[run] writing to ${runDir}`);
  console.log(`[run] scenario=${args.scenario} workers=${args.workers}`);

  // Sanity-check the server is up before doing anything.
  try {
    const r = await fetch(`${SERVER}/api/health`);
    if (!r.ok) throw new Error(`/api/health returned ${r.status}`);
  } catch (err) {
    console.error(`[run] server not reachable at ${SERVER}: ${err.message}`);
    console.error(`[run] start the server first with: ADMIN_USERNAMES=${ADMIN_USERNAME} npm run dev`);
    process.exit(1);
  }

  console.log(`[run] provisioning fixture meeting…`);
  const { meetingId, adminCookie } = await provisionFixtureMeeting();
  console.log(`[run] meeting ${meetingId} ready`);
  metrics.write('fixture_ready', { meetingId });

  // Server probe stays in the parent — one source of truth, no IPC.
  const probe = startServerProbe({ serverUrl: SERVER, adminCookie, metrics });

  // Chair stays in the parent: it drives the meeting flow, owns the
  // probe emit, and is the primary read source for chair-side scenario
  // logic that needs synchronous access to MeetingState.
  console.log(`[run] connecting chair (${ADMIN_USERNAME})…`);
  const chair = await createVirtualClient({
    serverUrl: SERVER,
    username: ADMIN_USERNAME,
    meetingId,
    metrics,
    label: 'chair',
  });

  await new Promise((resolveMeeting, rejectMeeting) => {
    chair.emit('meeting:nextAgendaItem', { currentAgendaItemId: null }, (ack) => {
      if (ack?.ok === false) rejectMeeting(new Error(`start meeting failed: ${ack.error}`));
      else resolveMeeting();
    });
  });
  console.log(`[run] meeting started`);

  // Spawn the worker pool. Each worker imports the scenario module and
  // is ready to accept add_client messages once it ack's `ready`.
  const workers = [];
  for (let workerId = 0; workerId < args.workers; workerId++) {
    workers.push(spawnWorker({ workerId, scenario: args.scenario, meetingId, metrics }));
  }
  await Promise.all(workers.map((w) => w.ready));
  console.log(`[run] ${workers.length} worker(s) ready`);

  // Start the chair-side scenario behavior in the parent. The chair
  // half drives the meeting (probes, advances, polls) and is the same
  // for any number of participants.
  const scenarioModule = await import(
    args.scenario === 'stress' ? './scenarios/stress.mjs' : './scenarios/plenary.mjs'
  );
  const chairBehavior = scenarioModule.startChairBehavior(chair, {}, metrics);

  // Per-stage ramp. New participants are distributed round-robin
  // across workers so the per-process load stays even.
  const stageRecords = [];
  let stopReason = null;
  let createdSoFar = 0;

  for (const [stageIndex, targetCount] of args.stages.entries()) {
    const toAdd = targetCount - createdSoFar;
    if (toAdd <= 0) continue;
    console.log(`[run] stage ${stageIndex}: ramping to ${targetCount} participants (+${toAdd})…`);
    metrics.write('stage_ramp_start', { stageIndex, targetCount, adding: toAdd });

    // Wait for all add_client requests in this stage to ack (success
    // or failure — `client_failed` is recorded as a client_error
    // sample and counts toward stop conditions, but doesn't abort the
    // ramp). The persistent message handler in spawnWorker routes acks
    // through each worker's `onClientResult` slot.
    let pendingAcks = toAdd;
    const ackPromise = new Promise((resolveAck) => {
      const handler = () => {
        pendingAcks--;
        if (pendingAcks <= 0) {
          for (const w of workers) w.onClientResult = null;
          resolveAck();
        }
      };
      for (const w of workers) w.onClientResult = handler;
    });

    // Send `add_client` messages round-robin across workers. Each
    // worker processes them one at a time (its own pacing); per-worker
    // serialisation keeps the connect storm gentle.
    for (let i = 0; i < toAdd; i++) {
      const idx = createdSoFar + i + 1;
      const username = `${PARTICIPANT_PREFIX}${idx}`;
      const w = workers[i % workers.length];
      w.proc.send({ type: 'add_client', username });
    }

    await ackPromise;
    createdSoFar = targetCount;
    console.log(`[run] stage ${stageIndex}: ${targetCount} participants connected`);

    const stage = { index: stageIndex, clients: targetCount, startedAt: Date.now(), endedAt: null };
    stageRecords.push(stage);
    metrics.write('stage_started', stage);

    // Run for stageMs, polling stop conditions every 5 s.
    const stageEnd = Date.now() + args.stageMs;
    const sinceMs = stage.startedAt + STOP_DEFAULTS.warmupMs;
    while (Date.now() < stageEnd) {
      await new Promise((r) => setTimeout(r, 5000));
      if (args.noStop) continue;
      const reason = evaluateStopConditions({ samples: metrics.all(), stop: args.stop, sinceMs });
      if (reason) {
        stopReason = { ...reason, stageIndex, atClients: targetCount };
        console.log(`[run] stop condition hit: ${reason.hit} (value=${reason.value}, threshold=${reason.threshold})`);
        break;
      }
    }
    stage.endedAt = Date.now();
    metrics.write('stage_ended', stage);
    if (stopReason) break;
  }

  console.log(`[run] tearing down…`);
  chairBehavior.stop();
  // Ask each worker to stop its participants and exit. They flush
  // their pending metrics batch first.
  for (const w of workers) {
    try {
      w.proc.send({ type: 'stop' });
    } catch {
      // Worker may have already exited — fine.
    }
  }
  // Wait briefly for workers to exit cleanly; force-kill any stragglers.
  await Promise.race([
    Promise.all(workers.map((w) => new Promise((res) => w.proc.once('exit', res)))),
    new Promise((res) => setTimeout(res, 5000)),
  ]);
  for (const w of workers) {
    if (!w.proc.killed && w.proc.exitCode === null) {
      w.proc.kill('SIGTERM');
    }
  }

  await new Promise((r) => setTimeout(r, 500));
  chair.disconnect();
  probe.stop();
  await new Promise((r) => setTimeout(r, 500));

  writeSummary({
    summaryPath,
    args,
    runStart: stageRecords[0]?.startedAt ?? Date.now(),
    stages: stageRecords,
    stopReason,
    samples: metrics.all(),
  });
  await metrics.close();
  console.log(`[run] summary written to ${summaryPath}`);
  console.log(`[run] events written to ${eventsPath}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('[run] fatal:', err);
  process.exit(1);
});
