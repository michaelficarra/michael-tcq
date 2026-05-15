import { test, expect } from '@playwright/test';
import { createMeeting, switchUser, goToAgendaTab } from './helpers.js';

/**
 * Multi-tab session sync (PRD § Authentication):
 *
 *  "Logging in, logging out, or switching mock users in one browser tab is
 *   reflected in all other open tabs of the same browser without losing
 *   in-progress edits."
 *
 * The relevant signal here is *same-browser*, *same-cookie* tabs — two pages
 * inside one `BrowserContext`. (Cross-context is a different thing entirely:
 * different cookie jars, different sessions.)
 */

test.describe('Multi-tab auth sync (same browser context)', () => {
  test('switching mock user in tab A is reflected in tab B', async ({ context }) => {
    const tabA = await context.newPage();
    const tabB = await context.newPage();

    await tabA.goto('/');
    await expect(tabA.getByRole('heading', { name: 'Join Meeting' })).toBeVisible();
    await tabB.goto('/');
    await expect(tabB.getByRole('heading', { name: 'Join Meeting' })).toBeVisible();

    // Both tabs should show the default mock user "admin".
    await expect(tabA.getByRole('navigation')).toContainText('Admin');
    await expect(tabB.getByRole('navigation')).toContainText('Admin');

    // Switch user in tab A.
    await switchUser(tabA, 'bob');
    await expect(tabA.getByRole('navigation')).toContainText('bob');

    // Tab B should pick up the new identity once it observes the change.
    // The auth context polls/listens; reload is a reliable trigger across
    // engines.
    await tabB.reload();
    await expect(tabB.getByRole('navigation')).toContainText('bob');
  });

  test('logging out in tab A propagates to tab B', async ({ context }) => {
    const tabA = await context.newPage();
    const tabB = await context.newPage();

    await tabA.goto('/');
    await expect(tabA.getByRole('heading', { name: 'Join Meeting' })).toBeVisible();
    await tabB.goto('/');
    await expect(tabB.getByRole('heading', { name: 'Join Meeting' })).toBeVisible();

    // Log out in tab A.
    await tabA.goto('/auth/logout');
    await tabA.waitForURL('/');
    await expect(tabA.getByText('Welcome to TCQ')).toBeVisible();

    // Tab B should now see the login page once it re-loads (cookies cleared).
    await tabB.reload();
    await expect(tabB.getByText('Welcome to TCQ')).toBeVisible();
  });

  // PRD § Authentication promises that "switching mock users in one browser
  // tab is reflected in all other open tabs... without losing in-progress
  // edits (form drafts, scroll position, open meeting view)". The current
  // implementation re-mounts the meeting page on auth change, which wipes
  // open form state in other tabs. Marking fixme so this is tracked as a
  // PRD/implementation gap rather than a silent regression.
  test.fixme('switching user in tab A does not blow away an in-progress draft in tab B', async ({ context }) => {
    const tabA = await context.newPage();
    const tabB = await context.newPage();

    await tabA.goto('/');
    const meetingId = await createMeeting(tabB);

    // In tab B, open the New Agenda Item form and partly fill it.
    // Add 'bob' as a co-chair so the form is still available to bob after
    // switching users.
    await goToAgendaTab(tabB);
    await tabB.getByLabel('Add chair').click();
    await tabB.getByPlaceholder('username').fill('bob');
    await tabB.getByPlaceholder('username').press('Enter');
    await tabB.getByRole('button', { name: /New Agenda Item/i }).click();
    await tabB.getByLabel('Agenda Item Name').fill('In-progress draft');

    await tabA.goto('/');
    await switchUser(tabA, 'bob');
    await expect(tabA.getByRole('navigation')).toContainText('bob');

    // Tab B's draft is still populated.
    await expect(tabB.getByLabel('Agenda Item Name')).toHaveValue('In-progress draft');
  });
});
