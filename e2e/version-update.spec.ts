import { test, expect } from '@playwright/test';
import { createMeeting } from './helpers.js';

/**
 * Covers the stale-version reload flow that handles a Cloud Run redeploy.
 * Cloud Run leaves the old revision running until in-flight requests
 * drain, so existing WebSocket clients stay pinned to it. The server
 * emits its `K_REVISION` over the WebSocket on connect; the client uses
 * that as the baseline and polls `/api/version` over HTTP. When the
 * polled revision diverges from the WebSocket's baseline, a banner
 * appears and the page reloads after a short grace period.
 *
 * Anchoring the baseline to the WebSocket — rather than to the first
 * HTTP /api/version response — avoids a race where a deploy slips
 * between the page's first HTTP call and its WebSocket handshake,
 * landing them on different revisions and falsely flagging the tab
 * as stale.
 *
 * The Playwright test server sets `K_REVISION=tcq-test-baseline` (see
 * `playwright.config.ts`) so the WebSocket emits a concrete baseline.
 * Polls are mocked via `page.route` so the test controls what the
 * client sees as the "current" revision on each poll. The synthetic
 * clock advances both the 30 s poll interval and the 10 s reload
 * countdown without real-time waits.
 */
test.describe('Stale-version reload', () => {
  test('banner appears + page reloads when a poll observes a revision different from the WebSocket baseline', async ({
    page,
  }) => {
    // Start by mirroring the WebSocket baseline so the first poll after
    // join is a no-op; only when we flip the mock should the banner appear.
    let revision: string = 'tcq-test-baseline';
    await page.route('**/api/version', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ sha: 'sha-1', revision }),
      });
    });

    await page.clock.install();

    // Land in a meeting page so the WebSocket connects and the
    // `server:revision` event reaches the client. The first /api/version
    // poll fires immediately after the baseline arrives; wait for it to
    // settle before flipping the mock, otherwise we'd race and the very
    // first poll could see the diverged revision (still a valid trigger,
    // but harder to reason about which poll caused the banner).
    const firstPoll = page.waitForResponse((r) => r.url().endsWith('/api/version'));
    await createMeeting(page);
    await firstPoll;

    // Simulate a redeploy: subsequent /api/version responses report a
    // different revision than the one the WebSocket bound to.
    revision = 'tcq-002-def';

    // Advance past the 30 s poll interval — the next poll observes a
    // diverged revision and flips the hook into "stale".
    const stalePoll = page.waitForResponse((r) => r.url().endsWith('/api/version'));
    await page.clock.runFor(30_500);
    await stalePoll;

    const banner = page.getByRole('alert').filter({ hasText: 'A new version of TCQ' });
    await expect(banner).toContainText('Reloading in 10 seconds');

    // The countdown decrements once per second.
    await page.clock.runFor(1_000);
    await expect(banner).toContainText('Reloading in 9 seconds');

    // Point the mock back at the baseline so the post-reload page's
    // first poll matches and doesn't immediately re-trigger the banner.
    revision = 'tcq-test-baseline';

    // Drain the rest of the countdown — the banner triggers
    // window.location.reload() once the counter reaches 0.
    const reloaded = page.waitForEvent('load');
    await page.clock.runFor(10_000);
    await reloaded;
  });

  test('"Reload now" button reloads immediately without waiting for the countdown', async ({ page }) => {
    let revision: string = 'tcq-test-baseline';
    await page.route('**/api/version', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ sha: 'sha-1', revision }),
      });
    });
    await page.clock.install();

    const firstPoll = page.waitForResponse((r) => r.url().endsWith('/api/version'));
    await createMeeting(page);
    await firstPoll;

    revision = 'tcq-002-def';
    const stalePoll = page.waitForResponse((r) => r.url().endsWith('/api/version'));
    await page.clock.runFor(30_500);
    await stalePoll;

    const banner = page.getByRole('alert').filter({ hasText: 'A new version of TCQ' });
    await expect(banner).toBeVisible();

    // Restore the baseline so the post-reload page doesn't immediately
    // re-trigger the banner.
    revision = 'tcq-test-baseline';

    const reloaded = page.waitForEvent('load');
    await banner.getByRole('button', { name: 'Reload now' }).click();
    await reloaded;
  });

  test('no banner when the polled revision matches the WebSocket baseline', async ({ page }) => {
    await page.route('**/api/version', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ sha: 'sha-1', revision: 'tcq-test-baseline' }),
      });
    });
    await page.clock.install();
    await createMeeting(page);

    // Drive multiple poll cycles forward — the revision matches the
    // baseline every time, so the banner should never appear.
    await page.clock.runFor(120_000);
    await expect(page.getByRole('alert').filter({ hasText: 'A new version of TCQ' })).toHaveCount(0);
  });

  test('no banner when /api/version returns 204 (server has no GIT_SHA)', async ({ page }) => {
    // Mirrors local-dev / test behaviour: GIT_SHA unset → /api/version
    // returns 204, and the staleness check skips comparison.
    await page.route('**/api/version', async (route) => {
      await route.fulfill({ status: 204 });
    });
    await page.clock.install();
    await createMeeting(page);

    await page.clock.runFor(120_000);
    await expect(page.getByRole('alert').filter({ hasText: 'A new version of TCQ' })).toHaveCount(0);
  });
});
