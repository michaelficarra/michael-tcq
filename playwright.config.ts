import { defineConfig } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SERVER_PORT = 3001;
const CLIENT_PORT = 5174;

// Create a fresh temp directory for file-based persistence.
// mkdtempSync runs once when the config is loaded — before any tests start.
const dataDir = mkdtempSync(join(tmpdir(), 'tcq-test-'));

// Clean up the temp directory on exit, even if tests are aborted.
function cleanup() {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {}
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

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${CLIENT_PORT}`,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
    {
      name: 'firefox',
      use: { browserName: 'firefox' },
    },
    {
      name: 'webkit',
      use: { browserName: 'webkit' },
    },
  ],
  webServer: {
    command: [
      // K_REVISION is set so the server emits a non-null revision on the
      // `server:revision` WebSocket event, which the stale-version e2e
      // test relies on as the baseline it compares `/api/version` polls
      // against.
      `export NODE_ENV=test DATA_DIR=${dataDir} PORT=${SERVER_PORT} K_REVISION=tcq-test-baseline`,
      `&& npm run build -w packages/shared`,
      `&& npx concurrently`,
      `-n server,client`,
      `-c blue,green`,
      `"npm run dev -w packages/server"`,
      `"cd packages/client && npx vite --port ${CLIENT_PORT}"`,
    ].join(' '),
    url: `http://localhost:${CLIENT_PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
