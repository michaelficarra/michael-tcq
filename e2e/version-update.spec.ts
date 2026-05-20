import { test, expect } from '@playwright/test';

/**
 * Covers the stale-version reload flow that handles a Cloud Run redeploy.
 * Cloud Run leaves the old revision running until in-flight requests
 * drain, so existing WebSocket clients stay pinned to it. The client
 * polls `/api/version`; when the JSON `revision` field changes from
 * the value observed on first poll, a banner appears and the page
 * reloads after a short grace period.
 *
 * The poll interval is 30 s and the reload countdown is 10 s. To keep
 * the test fast and deterministic, Playwright's synthetic clock drives
 * both timers. The `/api/version` endpoint is intercepted so the test
 * controls the revision the client sees on each poll, without needing
 * an actual redeploy.
 */
test.describe('Stale-version reload', () => {
  test('shows a reload banner and reloads when /api/version revision changes', async ({ page }) => {
    let revision = 'tcq-001-abc';
    await page.route('**/api/version', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ sha: 'sha-1', revision }),
      });
    });

    await page.clock.install();

    // Wait for the hook's first poll to land so the baseline revision is
    // recorded before we flip the mock.
    const firstPoll = page.waitForResponse((r) => r.url().endsWith('/api/version'));
    await page.goto('/');
    await firstPoll;
    await expect(page.getByRole('heading', { name: 'Join Meeting' })).toBeVisible();

    // Simulate a redeploy: subsequent /api/version responses return a
    // different revision name.
    revision = 'tcq-002-def';

    // Advance past the 30-second poll interval. The next poll sees a
    // diverged revision and flips the hook into "stale".
    const stalePoll = page.waitForResponse((r) => r.url().endsWith('/api/version'));
    await page.clock.runFor(30_500);
    await stalePoll;

    const banner = page.getByRole('alert');
    await expect(banner).toContainText('A new version of TCQ is available');
    await expect(banner).toContainText('Reloading in 10 seconds');

    // The countdown decrements once per second.
    await page.clock.runFor(1_000);
    await expect(banner).toContainText('Reloading in 9 seconds');

    await page.clock.runFor(1_000);
    await expect(banner).toContainText('Reloading in 8 seconds');

    // Drain the rest of the countdown — the banner triggers
    // window.location.reload() once the counter reaches 0.
    const reloaded = page.waitForEvent('load');
    await page.clock.runFor(10_000);
    await reloaded;

    // After reload the new page's first poll returns the (now current)
    // revision, so the banner should not be present.
    await expect(page.getByRole('heading', { name: 'Join Meeting' })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('"Reload now" button reloads immediately without waiting for the countdown', async ({ page }) => {
    let revision = 'tcq-001-abc';
    await page.route('**/api/version', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ sha: 'sha-1', revision }),
      });
    });
    await page.clock.install();

    const firstPoll = page.waitForResponse((r) => r.url().endsWith('/api/version'));
    await page.goto('/');
    await firstPoll;
    await expect(page.getByRole('heading', { name: 'Join Meeting' })).toBeVisible();

    revision = 'tcq-002-def';
    const stalePoll = page.waitForResponse((r) => r.url().endsWith('/api/version'));
    await page.clock.runFor(30_500);
    await stalePoll;

    const banner = page.getByRole('alert');
    await expect(banner).toBeVisible();

    const reloaded = page.waitForEvent('load');
    await banner.getByRole('button', { name: 'Reload now' }).click();
    await reloaded;

    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('does not show the banner when the deployed revision stays stable', async ({ page }) => {
    await page.route('**/api/version', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ sha: 'sha-1', revision: 'tcq-001-abc' }),
      });
    });
    await page.clock.install();

    const firstPoll = page.waitForResponse((r) => r.url().endsWith('/api/version'));
    await page.goto('/');
    await firstPoll;
    await expect(page.getByRole('heading', { name: 'Join Meeting' })).toBeVisible();

    // Drive multiple poll cycles forward — the revision never changes,
    // so the banner should never appear.
    await page.clock.runFor(120_000);
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
});
