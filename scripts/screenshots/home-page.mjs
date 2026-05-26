#!/usr/bin/env node
// home-page.png — the home page showing the Join/New Meeting cards and
// the populated "My Meetings" panel with a single active meeting
// chaired by `chicoxyzzy`. The viewer is `chicoxyzzy`, deliberately
// chosen because they aren't a chair or participant on any other
// screenshot's seeded meeting — so /api/my-meetings returns exactly
// one row even in a full regen run where multiple meetings are
// created across the suite.
//
// Height ~500: fits the heading, the two large cards, and the My
// Meetings table with one row, with minimal empty space below.
// Standalone-runnable against the default dev server on
// localhost:3000/5173.

import { getUrls, runScreenshot } from './lib.mjs';
import { populate } from './seed.mjs';

const { serverUrl, clientUrl } = getUrls();

const { chairSocket } = await populate(serverUrl, { chairs: ['chicoxyzzy'] });

try {
  await runScreenshot('home-page', { viewport: { width: 800, height: 500 } }, async ({ page, switchUser }) => {
    await page.goto(`${clientUrl}/`);
    await switchUser('chicoxyzzy');
    // Wait until the My Meetings table has at least one row — the
    // panel hides itself while loading or when empty, so this guards
    // against capturing the home page before /api/my-meetings resolves.
    await page.getByRole('heading', { name: 'My Meetings' }).waitFor();
    await page.locator('table tbody tr').first().waitFor();
  });
} finally {
  await chairSocket.close();
}
