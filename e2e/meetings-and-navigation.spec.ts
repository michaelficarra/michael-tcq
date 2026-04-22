import { test, expect } from '@playwright/test';
import {
  waitForHomePage,
  createMeeting,
  goToAgendaTab,
  goToQueueTab,
  goToLogTab,
  goToHelpTab,
  addAgendaItem,
  startMeeting,
} from './helpers.js';

test.describe('Creating a Meeting', () => {
  test('clicking "Start a New Meeting" creates a meeting with a word-based ID and redirects to it', async ({
    page,
  }) => {
    await waitForHomePage(page);
    await page.getByRole('button', { name: 'Start a New Meeting' }).click();

    await page.waitForURL(/\/meeting\//);

    // Meeting ID should be word-based (e.g. "bright-pine-lake")
    const id = decodeURIComponent(new URL(page.url()).pathname.split('/meeting/')[1]);
    expect(id).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);
  });
});

test.describe('Joining a Meeting', () => {
  test('a user can join a meeting by entering its ID on the home page', async ({ page }) => {
    // First create a meeting to get a valid ID
    const meetingId = await createMeeting(page);

    // Go back to the home page and join via the form
    await waitForHomePage(page);
    await page.getByLabel('Meeting ID').fill(meetingId);
    await page.getByRole('button', { name: 'Join' }).click();

    await page.waitForURL(/\/meeting\//);
    expect(page.url()).toContain(encodeURIComponent(meetingId));
  });

  test('navigating directly to /meeting/:id works', async ({ page }) => {
    const meetingId = await createMeeting(page);

    // Navigate directly
    await page.goto(`/meeting/${encodeURIComponent(meetingId)}`);
    await expect(page.getByText('Waiting for the meeting to start')).toBeVisible();
  });

  test('navigating to a non-existent meeting shows an error page with "Back to home" link', async ({ page }) => {
    await page.goto('/meeting/nonexistent-fake-meeting');

    await expect(page.getByText('Back to home')).toBeVisible();

    // Clicking "Back to home" navigates to the home page
    await page.getByText('Back to home').click();
    await page.waitForURL('/');
    await expect(page.getByRole('heading', { name: 'Join Meeting' })).toBeVisible();
  });
});

test.describe('Meeting Flow', () => {
  test('before the meeting starts, the queue view shows waiting message and "Start Meeting" button', async ({
    page,
  }) => {
    await createMeeting(page);

    // Add an agenda item so the Start Meeting button appears
    await goToAgendaTab(page);
    await addAgendaItem(page, 'First Topic', 'admin');
    await goToQueueTab(page);

    await expect(page.getByText('Waiting for the meeting to start')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start Meeting' })).toBeVisible();
  });

  test('clicking "Start Meeting" advances to the first agenda item', async ({ page }) => {
    await createMeeting(page);
    await goToAgendaTab(page);
    await addAgendaItem(page, 'Opening Remarks', 'admin');
    await startMeeting(page);

    // The current agenda item should appear in the Queue panel's Agenda
    // Item section. Scope the assertion because the Agenda panel (always
    // rendered) also contains the item name.
    const queuePanel = page.getByRole('tabpanel', { name: 'Queue' });
    await expect(queuePanel.getByRole('region', { name: 'Agenda Item' })).toContainText('Opening Remarks');
  });

  test('"Next Agenda Item" advances to the next item', async ({ page }) => {
    await createMeeting(page);
    await goToAgendaTab(page);
    await addAgendaItem(page, 'Item One', 'admin');
    await addAgendaItem(page, 'Item Two', 'admin');
    await startMeeting(page);

    await page.getByRole('button', { name: 'Next Agenda Item' }).click();

    const queuePanel = page.getByRole('tabpanel', { name: 'Queue' });
    await expect(queuePanel.getByRole('region', { name: 'Agenda Item' })).toContainText('Item Two');
  });

  test('completing an agenda item replaces its timebox with the actual elapsed time', async ({ page }) => {
    await createMeeting(page);
    await goToAgendaTab(page);
    // Seed an obviously-wrong timebox on the first item (99 min → "1h39m")
    // so we can verify it was overwritten rather than merely left alone.
    await addAgendaItem(page, 'Item One', 'admin', 99);
    await addAgendaItem(page, 'Item Two', 'admin');

    const agendaPanel = page.getByRole('tabpanel', { name: 'Agenda' });
    await expect(agendaPanel.getByText('1h39m', { exact: true })).toBeVisible();

    await startMeeting(page);

    // Let a handful of ms elapse so the server sees a non-zero duration.
    await page.waitForTimeout(50);

    await page.getByRole('button', { name: 'Next Agenda Item' }).click();

    await goToAgendaTab(page);
    // Real elapsed time is milliseconds → Math.ceil rounds up to 1 minute.
    await expect(agendaPanel.getByText('1m', { exact: true })).toBeVisible();
    await expect(agendaPanel.getByText('1h39m', { exact: true })).not.toBeVisible();
  });

  test('"Next Agenda Item" button is hidden on the last agenda item', async ({ page }) => {
    await createMeeting(page);
    await goToAgendaTab(page);
    await addAgendaItem(page, 'Only Item', 'admin');
    await startMeeting(page);

    // Only one agenda item, so "Next Agenda Item" should not be visible
    await expect(page.getByRole('button', { name: 'Next Agenda Item' })).not.toBeVisible();
  });
});

test.describe('Navigation', () => {
  test('meeting page has four tabs: Agenda, Queue, Log, Help', async ({ page }) => {
    await createMeeting(page);

    await expect(page.getByRole('tab', { name: 'Agenda' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Queue' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Log' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Help' })).toBeVisible();
  });

  test('the Agenda tab is the default active tab after creating a meeting', async ({ page }) => {
    await createMeeting(page);

    await expect(page.getByRole('tab', { name: 'Agenda' })).toHaveAttribute('aria-selected', 'true');
  });

  test('the active tab has aria-selected="true"', async ({ page }) => {
    await createMeeting(page);

    // Agenda is the default after creation
    await expect(page.getByRole('tab', { name: 'Agenda' })).toHaveAttribute('aria-selected', 'true');

    // Switch to Queue
    await goToQueueTab(page);
    await expect(page.getByRole('tab', { name: 'Queue' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab', { name: 'Agenda' })).toHaveAttribute('aria-selected', 'false');
  });

  test('clicking each tab shows the corresponding panel', async ({ page }) => {
    await createMeeting(page);

    // Agenda panel is visible by default after creation — verify agenda-specific content
    await expect(page.getByText('No agenda items yet.')).toBeVisible();

    // Switch to Queue — verify queue-specific content
    await goToQueueTab(page);
    await expect(page.getByText('Waiting for the meeting to start')).toBeVisible();
    await expect(page.getByText('No agenda items yet.')).not.toBeVisible();

    // Switch to Log
    await goToLogTab(page);
    await expect(page.getByText('Waiting for the meeting to start')).not.toBeVisible();

    // Switch to Help
    await goToHelpTab(page);
    await expect(page.getByText('Waiting for the meeting to start')).not.toBeVisible();

    // Switch back to Agenda
    await goToAgendaTab(page);
    await expect(page.getByText('No agenda items yet.')).toBeVisible();
  });

  test('top navigation bar shows the TCQ logo linking to home, tabs, and user menu', async ({ page }) => {
    await createMeeting(page);

    const nav = page.getByRole('navigation');
    await expect(nav).toBeVisible();

    // Logo links to home
    const logoLink = nav.getByRole('link', { name: 'TCQ' });
    await expect(logoLink).toBeVisible();

    // Clicking the logo navigates to home
    await logoLink.click();
    await page.waitForURL('/');
    await expect(page.getByRole('heading', { name: 'Join Meeting' })).toBeVisible();
  });

  test('the Help tab is available on the home page', async ({ page }) => {
    await waitForHomePage(page);

    const helpTab = page.getByRole('tab', { name: 'Help' });
    await expect(helpTab).toBeVisible();

    await helpTab.click();
    await expect(helpTab).toHaveAttribute('aria-selected', 'true');
  });
});
