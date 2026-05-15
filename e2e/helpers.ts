/**
 * Shared helpers for Playwright e2e tests.
 *
 * The app runs in mock auth mode during development (no GITHUB_CLIENT_ID),
 * so the default user is automatically logged in as "admin".
 */

import { type Browser, type BrowserContext, type Download, type Locator, type Page, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

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
  // Meeting creation redirects to the Agenda tab — wait for it to become active.
  await expect(page.getByRole('tab', { name: 'Agenda' })).toHaveAttribute('aria-selected', 'true');
  return decodeURIComponent(id);
}

/** Switch to a different mock user via the dev user-switcher. */
export async function switchUser(page: Page, username: string) {
  const nav = page.getByRole('navigation');
  // The dev user-switcher input is now a `UserCombobox` (role=combobox)
  // rather than a plain text input, so we locate it by combobox role.
  const userMenu = nav.getByRole('combobox');
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
 * Click a tab by name and wait for it to become the active one. The post-click
 * assertion uses a CSS-based locator (`page.locator('[role="tab"]')`) rather
 * than `getByRole('tab', ...)` because the latter goes through the browser's
 * accessibility tree, and Firefox's a11y tree can be transiently empty during
 * React commits that follow a state broadcast — which caused repeated
 * Firefox-only CI flakes ("element(s) not found" for the tab locator itself,
 * despite the tab being in the DOM). The CSS locator queries the DOM
 * directly and is not subject to that timing.
 */
async function switchToTab(page: Page, name: string) {
  await page.getByRole('tab', { name }).click();
  await expect(page.locator('[role="tab"]').filter({ hasText: name })).toHaveAttribute('aria-selected', 'true');
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

/**
 * Add an agenda item (must be on the Agenda tab as a chair).
 * `presenters` accepts a single username or an array; the chip combobox
 * commits each entry on Enter. When omitted, the helper adds the default
 * mock-auth user ('admin') so the form passes its "≥1 presenter" check —
 * the form no longer pre-populates the field, so a missing presenter
 * would otherwise silently block submission.
 */
export async function addAgendaItem(page: Page, name: string, presenters?: string | string[], estimate?: number) {
  // Open the form. Playwright's click auto-waits for the button to be actionable,
  // so this handles the race where the meeting state hasn't finished syncing yet
  // when the helper is called.
  await page.getByRole('button', { name: /New Agenda Item/i }).click();

  // Fill in the form
  await page.getByLabel('Agenda Item Name').fill(name);
  const presentersList = presenters === undefined ? ['admin'] : Array.isArray(presenters) ? presenters : [presenters];
  const presentersInput = page.getByLabel('Presenters');
  for (const p of presentersList) {
    await presentersInput.fill(p);
    await presentersInput.press('Enter');
  }
  if (estimate !== undefined) {
    // `exact: true` avoids matching the display-side "Estimate: Xm" aria-label
    // on already-rendered agenda items, which would otherwise make the locator
    // ambiguous once an item with an estimate is in the list.
    await page.getByLabel('Estimate', { exact: true }).fill(String(estimate));
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
 * Advance past the current agenda item via the "Next Agenda Item" button.
 * Always opens the confirmation dialog (so the chair can record a
 * conclusion); this helper fills the conclusion if one is provided and
 * then clicks Advance. Caller must already be on the Queue tab.
 */
export async function advanceAgenda(page: Page, conclusion?: string) {
  // On the last item the button is relabelled "Conclude meeting"; either
  // form opens the same confirmation dialog.
  await page.getByRole('button', { name: /^(Next Agenda Item|Conclude meeting)$/ }).click();
  const dialog = page.getByRole('dialog', { name: /confirm agenda advancement/i });
  await expect(dialog).toBeVisible();
  if (conclusion !== undefined) {
    await dialog.getByLabel(/conclusion/i).fill(conclusion);
  }
  await dialog.getByRole('button', { name: 'Advance' }).click();
  await expect(dialog).not.toBeVisible();
}

/**
 * Add a queue entry by clicking one of the speaker control buttons.
 * Returns when the entry appears in the queue.
 *
 * The button name match is scoped to the "Queue entry types" toolbar group
 * (rendered by SpeakerControls). Without that scope, an entry already in
 * the queue can match the same name — e.g. its clickable type badge
 * ("New Topic:"), or its Edit/Delete buttons with the entry's topic
 * starting with the same word.
 */
export async function addQueueEntry(
  page: Page,
  type: 'New Topic' | 'Discuss Current Topic' | 'Clarifying Question' | 'Point of Order',
  topic?: string,
) {
  const controls = page.getByRole('group', { name: 'Queue entry types' });
  await controls.getByRole('button', { name: type, exact: true }).click();

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

/**
 * Open a second browser context with its own cookies and storage,
 * navigate it directly to an existing meeting, and (optionally)
 * switch to a different mock user. Returns the new context and page
 * so the caller can drive both sides of a multi-client interaction
 * and clean up both contexts at the end of the test.
 *
 * The dev user-switcher requires landing on a page first, so when
 * `asUser` is supplied we visit the home page, switch user, then
 * navigate to the meeting.
 */
export async function openSecondContext(
  browser: Browser,
  meetingId: string,
  options?: { asUser?: string },
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  if (options?.asUser !== undefined) {
    await waitForHomePage(page);
    await switchUser(page, options.asUser);
  }
  await page.goto(`/meeting/${encodeURIComponent(meetingId)}`);
  return { context, page };
}

/**
 * Drag `source` onto `target` using a manual mouse sequence.
 *
 * @dnd-kit (used by agenda and queue lists) listens to native pointer events
 * and requires the activation distance to be exceeded before a drag begins.
 * Playwright's built-in `source.dragTo(target)` is unreliable for this
 * pattern: it can emit a single mousemove that bypasses the activation
 * distance check or skips over interpolation points the library relies on.
 *
 * This helper:
 *  1. Resolves source/target bounding boxes
 *  2. Hovers the source so it is the pointer target
 *  3. Mouses down, then moves through 8 intermediate points to satisfy the
 *     activation distance and produce a smooth drag preview
 *  4. Mouses up on the target
 *
 * Both inputs should be the draggable handles (whole row in the agenda;
 * the ⠿ drag handle in the queue).
 */
export async function dragAndDrop(page: Page, source: Locator, target: Locator): Promise<void> {
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox || !targetBox) throw new Error('Drag-and-drop source/target not visible');

  const sx = sourceBox.x + sourceBox.width / 2;
  const sy = sourceBox.y + sourceBox.height / 2;
  const tx = targetBox.x + targetBox.width / 2;
  const ty = targetBox.y + targetBox.height / 2;

  await page.mouse.move(sx, sy);
  await page.mouse.down();
  // Interpolated path — each step must clear the 5px activation distance.
  const steps = 10;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await page.mouse.move(sx + (tx - sx) * t, sy + (ty - sy) * t, { steps: 2 });
  }
  await page.mouse.up();
}

/** Read a Playwright Download into a UTF-8 string. */
export async function readDownloadedFile(download: Download): Promise<string> {
  const path = await download.path();
  if (!path) throw new Error('Download has no file path (was it cancelled?)');
  return readFile(path, 'utf8');
}

/**
 * Take a context offline for `durationMs` and bring it back online.
 * Models a transient client-side disconnection without destroying the
 * page — Socket.IO will surface a disconnect event and (on return)
 * reconnect.
 */
export async function offlineFor(context: BrowserContext, durationMs: number) {
  await context.setOffline(true);
  await new Promise((r) => setTimeout(r, durationMs));
  await context.setOffline(false);
}
