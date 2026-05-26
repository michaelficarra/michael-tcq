#!/usr/bin/env node
//
// Regenerate every README screenshot.
//
// Default mode spawns its own isolated server + client on ports
// 3002 / 5175, runs each per-screenshot script in `scripts/screenshots/`
// against it as a child process, then runs `oxipng` over the resulting
// PNGs to compress them losslessly. The isolated server keeps this
// command independent of any `npm run dev` or e2e test session.
//
// Flags:
//   --use-running-server   Skip the spawn and assume dev server is
//                          running on localhost:3000 / 5173. For
//                          fast iteration only; the persistent dev
//                          data store may include prior meetings that
//                          contaminate the "My Meetings" list on
//                          home-page.png. Commit-ready runs must
//                          omit this flag so the harness uses its
//                          isolated fresh-data store.
//   --filter=<substring>   Only run scripts whose filename contains
//                          the substring (matched against the basename).
//   --skip-compress        Skip the post-step `oxipng` invocation.
//   --dry-run              Run each per-screenshot script's seeding +
//                          rendering paths but skip writing the PNG
//                          and skip oxipng. Designed for CI/test-suite
//                          integration to catch protocol drift without
//                          producing committable artefacts.
//
// Ports:
//   3000/5173 — dev mode (npm run dev)
//   3001/5174 — Playwright e2e tests
//   3002/5175 — this script (isolated screenshot harness)
//
// See scripts/screenshots/README.md for how to add a new screenshot.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCREENSHOTS_SCRIPT_DIR = resolve(REPO_ROOT, 'scripts/screenshots');
const SCREENSHOTS_OUTPUT_DIR = resolve(REPO_ROOT, 'docs/screenshots');

const SERVER_PORT = 3002;
const CLIENT_PORT = 5175;

// --- Flag parsing ---------------------------------------------------------

const args = process.argv.slice(2);
const useRunningServer = args.includes('--use-running-server');
const skipCompress = args.includes('--skip-compress');
const dryRun = args.includes('--dry-run');
const filterArg = args.find((a) => a.startsWith('--filter='));
const filter = filterArg ? filterArg.slice('--filter='.length) : null;

if (dryRun) {
  console.log('Dry-run mode: no PNGs will be written and oxipng will be skipped.');
}
if (useRunningServer) {
  console.warn(
    'Warning: --use-running-server reuses the persistent dev-mode data store. ' +
      'Prior meetings will appear in home-page.png. Commit only screenshots generated ' +
      'without this flag.',
  );
}

// --- Server lifecycle -----------------------------------------------------

let serverUrl = 'http://localhost:3000';
let clientUrl = 'http://localhost:5173';
let dataDir = null;
let serverProc = null;

/**
 * Tear down whatever we spawned. Called on normal exit and on signals.
 * Safe to call more than once: each step short-circuits when its target
 * is null/absent.
 */
function cleanup() {
  if (serverProc) {
    try {
      // SIGTERM the entire process group so `concurrently` and its
      // children all stop together. The negative pid sends to the
      // group; we set `detached: true` when spawning so the process
      // group id matches the spawned pid.
      process.kill(-serverProc.pid, 'SIGTERM');
    } catch {
      // Already dead — fine.
    }
    serverProc = null;
  }
  if (dataDir) {
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {}
    dataDir = null;
  }
}
process.on('exit', cleanup);
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});
process.on('SIGTERM', () => {
  cleanup();
  process.exit(143);
});

/**
 * Poll the given URL until it returns a 2xx response or the timeout
 * elapses. Used to detect "client is ready to accept connections" the
 * same way `playwright.config.ts`'s `webServer.url` field does.
 */
async function waitForUrl(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Connection refused — server still booting.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for ${url} (${timeoutMs} ms)`);
}

if (!useRunningServer) {
  // Always start the screenshot server from a fresh, empty data store.
  // `mkdtempSync` produces a unique directory each invocation; the
  // server's file-based persistence is rooted at `DATA_DIR`, so a fresh
  // dir means zero meetings, zero users, zero log entries from any
  // prior run. Without this, persistent state would bleed across runs
  // (notably into the "My Meetings" list on the home page) and the
  // committed screenshots would drift over time.
  dataDir = mkdtempSync(join(tmpdir(), 'tcq-screenshots-'));
  serverUrl = `http://localhost:${SERVER_PORT}`;
  clientUrl = `http://localhost:${CLIENT_PORT}`;

  console.log(`Spawning isolated server on ${serverUrl} and client on ${clientUrl}`);
  console.log(`DATA_DIR=${dataDir} (fresh — no state from prior runs)`);

  // Mirror the shape of `playwright.config.ts`'s `webServer.command` so
  // the screenshot harness produces the same kind of clean test
  // environment as the e2e suite. `detached: true` puts the spawned
  // bash into its own process group so we can SIGTERM the whole group
  // on cleanup.
  const command = [
    `export NODE_ENV=test DATA_DIR=${dataDir} PORT=${SERVER_PORT} K_REVISION=tcq-screenshots-baseline`,
    `&& npm run build -w packages/shared`,
    `&& npx concurrently`,
    `-n server,client`,
    `-c blue,green`,
    `"npm run dev -w packages/server"`,
    `"cd packages/client && npx vite --port ${CLIENT_PORT}"`,
  ].join(' ');

  serverProc = spawn('bash', ['-c', command], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    detached: true,
  });

  // If the server process exits before we reach the polling loop (e.g.
  // a port conflict), surface the failure rather than hanging.
  serverProc.on('exit', (code, signal) => {
    if (code !== null && code !== 0) {
      console.error(`Server process exited with code ${code}`);
      process.exit(1);
    } else if (signal) {
      // SIGTERM during cleanup — expected.
    }
  });

  console.log(`Waiting for client to come up at ${clientUrl} ...`);
  await waitForUrl(clientUrl, 60_000);
  // Also wait on the server's health endpoint — when port 3002 is
  // already bound by a stale `tsx watch` from a previous failed run,
  // the spawned server exits with "port in use" but `concurrently`
  // keeps the client alive. Without this check we'd happily proceed
  // and every script would fail mysteriously.
  console.log(`Waiting for server health at ${serverUrl} ...`);
  await waitForUrl(`${serverUrl}/api/health`, 60_000);
  console.log('Client and server are ready.');

  // Warm up Vite by fetching the page bundle once before the first
  // screenshot script runs. Without this, the alphabetically-first
  // script (active-poll) hits Vite cold and the meeting-page bundle
  // can take >10s to materialise on the first request — long enough
  // to trip Playwright's default action timeout. Subsequent loads are
  // cached. A bare-meeting GET to a non-existent id is fine: Vite
  // serves the SPA shell either way.
  try {
    await fetch(`${clientUrl}/meeting/warmup`);
  } catch {
    // Best-effort. If the warmup request fails the real scripts will
    // surface the underlying problem.
  }
}

// --- Discover scripts -----------------------------------------------------

const scripts = readdirSync(SCREENSHOTS_SCRIPT_DIR)
  .filter((f) => f.endsWith('.mjs') && f !== 'lib.mjs' && f !== 'seed.mjs')
  .sort();

const selected = filter ? scripts.filter((f) => f.includes(filter)) : scripts;
if (selected.length === 0) {
  console.error(`No scripts matched filter "${filter}". Available:`);
  for (const s of scripts) console.error(`  ${s}`);
  process.exit(1);
}

// --- Run each script ------------------------------------------------------

const results = [];
for (const file of selected) {
  const name = file.replace(/\.mjs$/, '');
  const start = Date.now();
  console.log(`\n→ ${name}`);

  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [join(SCREENSHOTS_SCRIPT_DIR, file)], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      env: {
        ...process.env,
        TCQ_SERVER_URL: serverUrl,
        TCQ_CLIENT_URL: clientUrl,
        // Propagated through to `runScreenshot` in `lib.mjs`; scenarios
        // skip their final page.screenshot when this is set.
        TCQ_SCREENSHOTS_DRY_RUN: dryRun ? '1' : '0',
      },
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });

  const ms = Date.now() - start;
  const outPath = join(SCREENSHOTS_OUTPUT_DIR, `${name}.png`);
  const sizeBytes = !dryRun && code === 0 && existsSync(outPath) ? statSync(outPath).size : null;
  results.push({ name, code, ms, sizeBytes, postSizeBytes: null });
}

// --- Lossless compression -------------------------------------------------

if (!skipCompress && !dryRun && results.some((r) => r.code === 0)) {
  console.log('\nCompressing PNGs with oxipng...');
  try {
    await new Promise((resolveExit, reject) => {
      // -o 4 is a good speed/size tradeoff for screenshots of this scale.
      // --strip safe removes non-critical metadata chunks (tEXt, tIME,
      // etc.) without altering pixels — lossless.
      const child = spawn('npx', ['oxipng', '-o', '4', '--strip', 'safe', join(SCREENSHOTS_OUTPUT_DIR, '*.png')], {
        cwd: REPO_ROOT,
        stdio: 'inherit',
        shell: true,
      });
      child.on('exit', (code) => (code === 0 ? resolveExit() : reject(new Error(`oxipng exited with code ${code}`))));
      child.on('error', reject);
    });
    for (const r of results) {
      if (r.code !== 0) continue;
      const outPath = join(SCREENSHOTS_OUTPUT_DIR, `${r.name}.png`);
      if (existsSync(outPath)) r.postSizeBytes = statSync(outPath).size;
    }
  } catch (err) {
    console.error(`oxipng failed: ${err.message}`);
    console.error('Screenshots were still generated; just not compressed.');
  }
}

// --- Summary --------------------------------------------------------------

function fmtBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

console.log('\nResults');
console.log('-------');
for (const r of results) {
  const status = r.code === 0 ? 'OK  ' : 'FAIL';
  const sizeLine =
    r.postSizeBytes != null && r.sizeBytes != null
      ? `${fmtBytes(r.sizeBytes)} → ${fmtBytes(r.postSizeBytes)}`
      : r.sizeBytes != null
        ? fmtBytes(r.sizeBytes)
        : '—';
  console.log(`  ${status}  ${r.name.padEnd(24)} ${String(r.ms).padStart(5)} ms   ${sizeLine}`);
}

const failed = results.filter((r) => r.code !== 0);
if (failed.length) {
  console.error(`\n${failed.length} of ${results.length} screenshot script(s) failed.`);
  process.exit(1);
}
console.log(`\nAll ${results.length} screenshots regenerated successfully.`);

// Force-exit so we don't linger on stdio pipes inherited by the spawned
// server (`concurrently` keeps writing periodic-sync log lines and
// would otherwise hold the event loop open indefinitely). cleanup()
// already runs as the exit handler — it SIGTERMs the server group
// and rms the data dir.
process.exit(0);
