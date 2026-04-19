/**
 * Shared helpers for Playwright e2e tests.
 *
 * The app runs in mock auth mode during development (no GITHUB_CLIENT_ID),
 * so the default user is automatically logged in as "admin".
 */

import { type Page, expect } from '@playwright/test';

/** Wait for the home page to be loaded and the user to be authenticated. */
export async function waitForHomePage(page: Page) {
  await page.goto('/');
  // The home page shows "Join Meeting" and "New Meeting" cards
  await expect(page.getByRole('heading', { name: 'Join Meeting' })).toBeVisible();
}

/** Create a new meeting and navigate to it. Returns the meeting ID. */
export async function createMeeting(page: Page): Promise<string> {
  await waitForHomePage(page);
  await page.getByRole('button', { name: 'Start a New Meeting' }).click();
  // Wait for navigation to /meeting/:id
  await page.waitForURL(/\/meeting\//);
  const url = new URL(page.url());
  const id = url.pathname.split('/meeting/')[1];
  // Wait for meeting to load (queue tab is default)
  await expect(page.getByText('Waiting for the meeting to start')).toBeVisible();
  return decodeURIComponent(id);
}

/** Switch to a different mock user via the dev user-switcher. */
export async function switchUser(page: Page, username: string) {
  const nav = page.getByRole('navigation');
  // Click the username in the nav bar to open the switcher
  const userMenu = nav.getByRole('textbox');
  // If the form isn't visible, click the user button to show it
  if (!(await userMenu.isVisible())) {
    await nav.getByRole('button').filter({ hasText: /\w/ }).last().click();
  }
  await userMenu.fill(username);
  await userMenu.press('Enter');
  // The form submission triggers a full page reload — wait for it
  await expect(userMenu).not.toBeVisible();
}

/**
 * Click a tab by name and wait for it to become the active one. We wait for
 * `aria-selected="true"` rather than returning immediately after click so
 * that callers that assert against the newly-active panel don't race React's
 * state commit — this has been a source of Firefox-only CI flakiness in the
 * past.
 */
async function switchToTab(page: Page, name: string) {
  const tab = page.getByRole('tab', { name });
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}

/** Navigate to the Agenda tab. */
export async function goToAgendaTab(page: Page) {
  await switchToTab(page, 'Agenda');
}

/** Navigate to the Queue tab. */
export async function goToQueueTab(page: Page) {
  await switchToTab(page, 'Queue');
}

/** Navigate to the Log tab. */
export async function goToLogTab(page: Page) {
  await switchToTab(page, 'Log');
}

/** Navigate to the Help tab. */
export async function goToHelpTab(page: Page) {
  await switchToTab(page, 'Help');
}

/** Add an agenda item (must be on the Agenda tab as a chair). */
export async function addAgendaItem(page: Page, name: string, owner?: string, timebox?: number) {
  // Click the "New Agenda Item" button to show the form
  const addButton = page.getByRole('button', { name: /New Agenda Item/i });
  if (await addButton.isVisible()) {
    await addButton.click();
  }

  // Fill in the form
  await page.getByLabel('Agenda Item Name').fill(name);
  if (owner) {
    await page.getByLabel('Owner').fill(owner);
  }
  if (timebox !== undefined) {
    await page.getByLabel(/timebox/i).fill(String(timebox));
  }

  // Count items before adding by checking visible item text
  const agendaPanel = page.getByRole('tabpanel', { name: 'Agenda' });
  const countBefore = await agendaPanel
    .locator('li')
    .count()
    .catch(() => 0);

  await page.getByRole('button', { name: 'Create' }).click();

  // Wait for the new item to appear in the list
  await expect(agendaPanel.locator('li')).toHaveCount(countBefore + 1);
}

/** Start the meeting (clicks Start Meeting on the Queue tab). */
export async function startMeeting(page: Page) {
  await goToQueueTab(page);
  await page.getByRole('button', { name: 'Start Meeting' }).click();
  // Wait for the agenda item to appear
  await expect(page.getByText('Waiting for the meeting to start')).not.toBeVisible();
}

/**
 * Add a queue entry by clicking one of the speaker control buttons.
 * Returns when the entry appears in the queue.
 */
export async function addQueueEntry(
  page: Page,
  type: 'New Topic' | 'Discuss Current Topic' | 'Clarifying Question' | 'Point of Order',
  topic?: string,
) {
  await page.getByRole('button', { name: type }).click();

  if (topic) {
    // The entry opens in edit mode — type the topic and save
    const input = page.getByLabel('Topic description');
    await input.fill(topic);
    await page.getByRole('button', { name: 'Save' }).click();
  }
}

/**
 * Locate a section on the Queue tab by its visible heading text.
 * Sections have headings like "Agenda Item", "Speaking", "Topic", "Speaker Queue".
 */
export function queueSection(page: Page, headingText: string) {
  return page.getByRole('region', { name: headingText });
}
