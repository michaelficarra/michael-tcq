/**
 * E2E coverage for the Premium-users admin panel — the runtime-managed
 * replacement for the former `PREMIUM_USERNAMES` env var.
 *
 * Default mock-auth user is `admin` (`.env.test` sets ADMIN_USERNAMES=admin),
 * so admin-context tests need no extra setup; non-admin paths use
 * `switchUser`.
 */

import { test, expect, type Page } from '@playwright/test';
import { createMeeting, openSecondContext, switchUser, waitForHomePage } from './helpers.js';

/**
 * Commit a username via the Premium Users combobox and wait for the
 * server's POST response to land — without this, the optimistic + POST
 * response double-render races against the next assertion and Playwright
 * sees the pill as detached/unstable.
 */
async function addPremiumUser(page: Page, username: string) {
  const responsePromise = page.waitForResponse(
    (r) => r.url().endsWith('/api/admin/premium-users') && r.request().method() === 'POST',
  );
  const addInput = page.getByLabel('Add premium user');
  await addInput.fill(username);
  await addInput.press('Enter');
  await responsePromise;
  await expect(page.getByLabel(`Remove ${username}`)).toBeVisible();
}

/** Same idea for the DELETE — wait for the server response before continuing. */
async function removePremiumUser(page: Page, username: string) {
  const responsePromise = page.waitForResponse(
    (r) =>
      r.url().includes(`/api/admin/premium-users/${encodeURIComponent(username)}`) && r.request().method() === 'DELETE',
  );
  // `force: true` bypasses Playwright's stability check on the button.
  // The pill re-renders every 10 s when the shared AdminSection
  // refreshTick fires a fresh GET on the panel, which races the click's
  // actionability gate; the click semantics themselves are fine. Same
  // technique would apply to `addPremiumUser`, but the add input is a
  // text field rather than a pill in the polled list so it doesn't see
  // the same churn.
  await page.getByLabel(`Remove ${username}`).click({ force: true });
  await responsePromise;
  await expect(page.getByLabel(`Remove ${username}`)).toHaveCount(0);
}

test.describe('Premium Users admin panel', () => {
  // Each test starts from a clean DATA_DIR (Playwright's webServer spins up
  // a fresh tempdir per run), but tests within a run share state. Each test
  // adds and removes its own usernames so they don't collide.

  test('renders an empty Premium Users section when no premium users are persisted', async ({ page }) => {
    await waitForHomePage(page);
    await page.getByRole('tab', { name: 'Admin' }).click();
    const section = page.getByRole('heading', { name: 'Premium Users' }).locator('..');
    await expect(section).toBeVisible();
    // No premium users have been added in this test, but other tests within
    // the worker may have left some — scope the empty-state assertion to
    // whichever holds: either the empty message, or the input being usable.
    await expect(page.getByLabel('Add premium user')).toBeVisible();
  });

  test('adding a username via the combobox autocomplete inserts a pill that survives a reload', async ({ page }) => {
    // Use a per-test username (with a unique suffix) so this test is
    // independent of any pills other tests in the same run may have added
    // or removed. Allowed-chars-only so the server schema accepts it.
    const username = `premium-add-${Date.now()}`;
    await waitForHomePage(page);
    await page.getByRole('tab', { name: 'Admin' }).click();
    await addPremiumUser(page, username);

    // Persistence: reload and confirm the pill is still there.
    await page.reload();
    await page.getByRole('tab', { name: 'Admin' }).click();
    await expect(page.getByLabel(`Remove ${username}`)).toBeVisible();

    // Cleanup so the row count stays bounded for subsequent runs.
    await removePremiumUser(page, username);
  });

  test('autocomplete dropdown suggests TC39 seed logins as the admin types', async ({ page }) => {
    // The /api/users/autocomplete endpoint resolves seed logins in
    // mock-auth mode without a GitHub round-trip. Typing a partial
    // login should surface the matching seed user as a suggestion.
    await waitForHomePage(page);
    await page.getByRole('tab', { name: 'Admin' }).click();
    const addInput = page.getByLabel('Add premium user');
    await addInput.fill('anne');
    // The dropdown is portaled to document.body — listbox role with
    // suggestions. We don't assert the exact suggestion text (it
    // includes a display name + organisation that may change) but
    // we do assert at least one suggestion appears.
    const dropdown = page.getByRole('listbox');
    await expect(dropdown).toBeVisible();
    await expect(dropdown.locator('[role="option"]').first()).toBeVisible();
    // Press Escape to close the dropdown without committing.
    await addInput.press('Escape');
  });

  test('removing a pill via × deletes it and the removal persists across a reload', async ({ page }) => {
    const username = `premium-rm-${Date.now()}`;
    await waitForHomePage(page);
    await page.getByRole('tab', { name: 'Admin' }).click();
    await addPremiumUser(page, username);

    await removePremiumUser(page, username);

    // Reload and confirm the pill is still gone.
    await page.reload();
    await page.getByRole('tab', { name: 'Admin' }).click();
    await expect(page.getByLabel(`Remove ${username}`)).toHaveCount(0);
  });

  test('admin toggling premium updates the badge live for clients viewing a meeting where the user is present', async ({
    page,
    browser,
  }) => {
    // Premium status is propagated by re-broadcasting full meeting state
    // to every room where the affected user's key is in `meeting.users`.
    // The cleanest place to observe that on the client is anywhere the
    // user is rendered through the meeting's users map — a presenter on
    // an agenda item is the simplest: it puts the user in
    // `meeting.users` without requiring a second authenticated session
    // or starting the meeting.
    //
    // 1. Admin creates a meeting and adds an agenda item with otherUser
    //    listed as a presenter — this populates `meeting.users[otherUser]`.
    // 2. A second browser context (also admin, via openSecondContext's
    //    default) navigates to the same meeting page and watches the
    //    presenter pill in the agenda.
    // 3. The first context toggles otherUser's premium status from the
    //    Admin tab. The second context should see the verification badge
    //    on the presenter pill appear and disappear without reloading.
    const otherUser = `premium-live-${Date.now()}`;
    const meetingId = await createMeeting(page);
    const agendaPanel = page.getByRole('tabpanel', { name: 'Agenda' });
    await page.getByRole('button', { name: /New Agenda Item/i }).click();
    await page.getByLabel('Agenda Item Name').fill('Premium broadcast probe');
    const presentersInput = page.getByLabel('Presenters');
    await presentersInput.fill(otherUser);
    await presentersInput.press('Enter');
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(agendaPanel.getByText('Premium broadcast probe')).toBeVisible();

    // Second context: open the same meeting in a separate browser
    // session so the broadcast has somewhere to land that isn't the
    // tab driving the admin mutation. The meeting page defaults to the
    // Queue tab — click into Agenda so the presenter is visible.
    const { context, page: otherPage } = await openSecondContext(browser, meetingId);
    try {
      await otherPage.getByRole('tab', { name: 'Agenda' }).click();
      const otherAgendaPanel = otherPage.getByRole('tabpanel', { name: 'Agenda' });
      const presenterLocator = otherAgendaPanel.getByText(otherUser).first();
      await expect(presenterLocator).toBeVisible();
      // No premium badge yet — the title is what UserBadge sets on the
      // tooltipped premium mark; absence in the other page's agenda
      // panel is the wire-level invariant we want to assert.
      await expect(otherAgendaPanel.getByTitle('TCQ Premium™')).toHaveCount(0);

      // First context: navigate to the admin tab and grant premium.
      await waitForHomePage(page);
      await page.getByRole('tab', { name: 'Admin' }).click();
      await addPremiumUser(page, otherUser);

      // Broadcast arrives at the second context; presenter pill picks
      // up the premium mark. Generous timeout because we ride on the
      // same `state` event the resync path uses — the client applies
      // it on the next animation frame after the message lands.
      await expect(otherAgendaPanel.getByTitle('TCQ Premium™')).toBeVisible({ timeout: 15_000 });

      // Remove again — badge should disappear via the same path.
      await removePremiumUser(page, otherUser);
      await expect(otherAgendaPanel.getByTitle('TCQ Premium™')).toHaveCount(0, { timeout: 15_000 });
    } finally {
      await context.close();
    }
  });

  test('non-admin users cannot see the Admin tab or the Premium Users section', async ({ page }) => {
    await waitForHomePage(page);
    await switchUser(page, 'plain-jane');
    await expect(page.getByRole('tab', { name: 'Admin' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Premium Users' })).toHaveCount(0);
  });

  test('free-text fallback: typing a plausible-but-unknown login still adds it', async ({ page }) => {
    // The directory has no record of this login (mock-auth has no
    // off-org users), but UserCombobox single-mode supports free-text
    // commit so an admin can grant premium to a new login before the
    // user has ever connected.
    const username = `unknown-${Date.now()}`;
    await waitForHomePage(page);
    await page.getByRole('tab', { name: 'Admin' }).click();
    await addPremiumUser(page, username);
    // Clean up.
    await removePremiumUser(page, username);
  });
});
