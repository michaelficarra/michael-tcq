# TCQ Load Test Harness

A Node-based load harness that spawns N virtual TCQ participants against
a locally running server, ramps up in stages, and reports the per-stage
breaking point.

This is **not** part of `npm test` or `npm run ci` — load tests are
deliberately opt-in (they take minutes, drive sustained CPU load, and
need the dev server running in mock-auth mode).

## Architecture

The harness is multi-process to keep the driver from being the
bottleneck:

- **Parent process** (`run.mjs`) — provisions the fixture meeting,
  connects the chair, runs chair-side scenario behaviour (probe,
  agenda/speaker advances, polls), polls server diagnostics, and
  forks N worker processes.
- **Worker processes** (`worker.mjs`) — each owns ~100 participants
  and runs their per-client scenario behaviour. Workers ship metrics
  samples back to the parent in 100 ms batches over IPC.

Default worker count is `ceil(max-stage / 100)` (capped at 64), so a
ramp topping out at 100 spawns 1 worker, at 1000 spawns 10, at 10000
spawns 64. Override with `--workers <n>` when characterising the
per-process ceiling itself or under unusual memory constraints.

## When to run it

- Before each TC39 plenary, to confirm the deployment can hold the
  expected attendee count.
- After any change to the broadcast path, persistence layer, or
  Socket.IO configuration.
- When debugging a suspected scaling issue.

## Prerequisites

1. Server must be running locally with mock auth (no `GITHUB_CLIENT_ID`
   in the environment) and the load-admin user marked as admin so the
   harness can poll diagnostics:

   ```sh
   ADMIN_USERNAMES=load-admin npm run dev
   ```

2. Nothing else — the harness uses workspace-resolved `socket.io-client`
   and `@tcq/shared`, both already dependencies of the server package.

## Running

```sh
# Plenary (realistic) ramp — 25 → 200 over six stages, 10 min per stage.
node scripts/load-test/run.mjs --scenario plenary

# Stress ramp — same client counts, 3 min per stage.
node scripts/load-test/run.mjs --scenario stress

# Custom: just three stages, 1 min each, no auto-stop.
node scripts/load-test/run.mjs --scenario stress --stages 50,100,200 --stage-ms 60000 --no-stop

# Push to thousands of clients — workers default to 1 per 100 clients,
# so this spawns 25 worker processes.
node scripts/load-test/run.mjs --scenario plenary --stages 500,1000,2500 --stage-ms 120000
```

Pass `--help` for the full flag list.

## Output

Each run writes to `scripts/load-test/runs/<iso-timestamp>/`:

- `events.jsonl` — every per-client and per-server sample, one JSON
  object per line. Useful for drilling into a specific signal.
- `summary.md` — per-stage probe latency table, per-stage server
  resource peaks, total deltas/bytes/errors. The deliverable.

## Scenarios

### `plenary` — realistic plenary mix

- One designated chair drives the meeting flow.
- Each participant adds a queue entry every 60–180 s.
- Chair advances the speaker every 2–4 minutes, the agenda every
  20–40 minutes.
- Twice per agenda item, the chair starts a poll; every participant
  reacts within ~5 s, then the chair stops it.
- Each participant disconnects + reconnects every 10–20 minutes to
  exercise the resync path.

### `stress` — adversarial mix

- Continuous queue churn (add → edit → remove on a 1–3 s loop per
  participant).
- Continuous agenda reorders by the chair.
- A sustained poll with every participant flipping reactions every
  1–3 s.

## Stop conditions

The ramp aborts as soon as any of these triggers (configurable via CLI
flags):

| Signal                    | Default threshold                              |
| ------------------------- | ---------------------------------------------- |
| Probe RTT median          | > 1000 ms                                      |
| Probe RTT p99             | > 5000 ms                                      |
| Server RSS                | > 400 MB (≈ 80% of Cloud Run's 512 MB default) |
| Persistence dirty backlog | > 50 meetings                                  |
| `/api/health` failures    | ≥ 3 in a row                                   |
| Per-client error rate     | > 1%                                           |

Pass `--no-stop` to run every stage to completion regardless.

## Latency probe

Every ~10 s (5 s under stress) the chair emits a `queue:add` whose topic
encodes the emit timestamp in the form `probe-<counter>-<emitMs>`.
Every connected client (including the chair) records `Date.now() -
emitMs` when the matching `queue:added` delta arrives. The chair removes
the probe entry ~2 s later so the queue doesn't accumulate.

This measures the full broadcast path: server validate → mutate →
fan-out → msgpack encode → deflate → kernel send → kernel recv → msgpack
decode → applyDelta. It does **not** isolate any single layer — that's
what dedicated micro-benchmarks would be for, if a future investigation
needs them.

## What this harness does NOT cover

- Cloud Run cold-start latency, Firestore round-trips, or anything else
  that only manifests against the deployed service.
- React rendering cost in real browsers (the harness runs headless and
  does no DOM work).
- OAuth flow load (mock-auth bypasses it; GitHub has its own rate
  limits and they are not the risk).
- CI integration (load tests are not run automatically).
