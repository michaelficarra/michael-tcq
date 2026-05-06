/**
 * Multi-context Playwright tests. Each spec opens a second browser
 * context and asserts behaviour that depends on real cross-client
 * propagation through the live server.
 *
 * Phase A populates this file with a single smoke spec that just
 * proves the helpers wire up. Subsequent phases (E and F) add
 * convergence, race, and network-disruption coverage.
 */

import { expect, test } from '@playwright/test';
import { createMeeting, goToAgendaTab, offlineFor, openSecondContext, waitForHomePage } from './helpers.js';

test.describe('multi-context smoke', () => {
  test('opens a second context on an existing meeting and tears it down', async ({ browser, page }) => {
    const meetingId = await createMeeting(page);
    await goToAgendaTab(page);

    const second = await openSecondContext(browser, meetingId);
    try {
      // The second context should land on the meeting page — the
      // Agenda tab is visible to anyone with the meeting URL.
      await expect(second.page.getByRole('tab', { name: 'Agenda' })).toBeVisible();
    } finally {
      await second.context.close();
    }
  });

  test('offlineFor takes a context offline and brings it back', async ({ browser, page }) => {
    const meetingId = await createMeeting(page);
    const second = await openSecondContext(browser, meetingId);
    try {
      // Confirm the second context loaded the meeting before going offline.
      await expect(second.page.getByRole('tab', { name: 'Agenda' })).toBeVisible();

      // Brief offline window — long enough to be observable, short
      // enough not to slow the suite. We don't assert the connection
      // indicator here (that's Phase F's job); we just confirm the
      // helper runs end-to-end without throwing.
      await offlineFor(second.context, 200);

      // After returning online, the page is still alive and navigable.
      await expect(second.page.getByRole('tab', { name: 'Agenda' })).toBeVisible();
    } finally {
      await second.context.close();
    }
  });

  test('home page loads in a fresh second context', async ({ browser }) => {
    // Verifies waitForHomePage works inside a context the test didn't
    // create itself — the entry path for openSecondContext({ asUser })
    // when an explicit user switch is needed.
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await waitForHomePage(page);
    } finally {
      await context.close();
    }
  });
});
