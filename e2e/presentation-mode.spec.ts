import { test, expect } from '@playwright/test';
import {
  createMeeting,
  goToAgendaTab,
  goToQueueTab,
  goToLogTab,
  addAgendaItem,
  startMeeting,
  addQueueEntry,
} from './helpers.js';
import { installFullscreenMock, triggerFullscreenExit } from './mocks.js';

/**
 * Presentation mode (`f` shortcut) hides the navigation bar and every
 * `.presentation-hidden` chrome element while leaving meeting content
 * visible. The implementation enters/exits the browser's fullscreen API,
 * which is unreliable to drive across the three Playwright engines, so we
 * stub the API and synthesise the change event from `mocks.installFullscreenMock`.
 */

test.describe('Presentation Mode', () => {
  test.beforeEach(async ({ page }) => {
    await installFullscreenMock(page);
  });

  test('pressing "f" enters presentation mode and hides the nav bar and chrome controls', async ({ page }) => {
    await createMeeting(page);
    await goToAgendaTab(page);
    await addAgendaItem(page, 'Item', 'admin');
    await startMeeting(page);

    // Sanity: NavBar is visible (the "Open menu" hamburger lives in it).
    await expect(page.getByLabel('Open menu')).toBeVisible();

    await page.locator('body').press('f');

    // In presentation mode the NavBar is not rendered.
    await expect(page.getByLabel('Open menu')).not.toBeVisible();
    // The agenda-item section's chair action (Next Agenda Item / Conclude
    // meeting) is wrapped in `presentation-hidden`.
    await expect(page.getByRole('button', { name: /^(Next Agenda Item|Conclude meeting)$/ })).not.toBeVisible();
    // Queue entry-type buttons are inside `<SpeakerControls>` which is also
    // `presentation-hidden`.
    await expect(page.getByRole('button', { name: 'New Topic', exact: true })).not.toBeVisible();
  });

  test('agenda content, current speaker, and queue items remain visible in presentation mode', async ({ page }) => {
    await createMeeting(page);
    await goToAgendaTab(page);
    await addAgendaItem(page, 'Visible item', 'admin');
    await startMeeting(page);
    await addQueueEntry(page, 'New Topic', 'A speaker topic');
    await expect(page.getByRole('list', { name: 'Queued speakers' }).getByText('A speaker topic')).toBeVisible();

    await page.locator('body').press('f');

    // Current agenda item still rendered.
    await expect(page.getByRole('region', { name: 'Agenda Item' })).toContainText('Visible item');
    // Speaker section still rendered.
    await expect(page.getByRole('region', { name: 'Speaking' })).toBeVisible();
    // Queued speaker entry still rendered (just without the edit / delete /
    // drag-handle chrome).
    await expect(page.getByRole('list', { name: 'Queued speakers' }).getByText('A speaker topic')).toBeVisible();
  });

  test('timers remain visible in presentation mode', async ({ page }) => {
    await createMeeting(page);
    await goToAgendaTab(page);
    // No estimate — keeps the rendered times to the count-up alone (no
    // "expected to end by HH:MM" suffix that would also match a timer regex).
    await addAgendaItem(page, 'Timed item', 'admin');
    await startMeeting(page);

    await page.locator('body').press('f');

    // Timer is a count-up in M:SS format — visible regardless of presentation mode.
    await expect(page.getByRole('region', { name: 'Agenda Item' }).getByText(/^\d+:\d{2}$/)).toBeVisible();
  });

  test('Export button is hidden in presentation mode', async ({ page }) => {
    await createMeeting(page);
    await goToAgendaTab(page);
    await addAgendaItem(page, 'Item', 'admin');
    await startMeeting(page);

    // Generate a log entry so the Export button would normally show.
    await addQueueEntry(page, 'New Topic', 'Something');
    await page.getByRole('button', { name: 'Next Speaker' }).click();
    await page.getByRole('button', { name: 'Next Speaker' }).click();

    await goToLogTab(page);
    await expect(page.getByRole('button', { name: 'Export' })).toBeVisible();

    await page.locator('body').press('f');
    await expect(page.getByRole('button', { name: 'Export' })).not.toBeVisible();
  });

  test('pressing "f" again exits presentation mode', async ({ page }) => {
    await createMeeting(page);
    await goToAgendaTab(page);
    await addAgendaItem(page, 'Item', 'admin');
    await startMeeting(page);

    await page.locator('body').press('f');
    await expect(page.getByLabel('Open menu')).not.toBeVisible();

    await page.locator('body').press('f');
    await expect(page.getByLabel('Open menu')).toBeVisible();
  });

  test('exiting fullscreen via the browser (mocked Esc) returns to normal mode', async ({ page }) => {
    await createMeeting(page);
    await goToAgendaTab(page);
    await addAgendaItem(page, 'Item', 'admin');
    await startMeeting(page);

    await page.locator('body').press('f');
    await expect(page.getByLabel('Open menu')).not.toBeVisible();

    // Simulate the browser firing fullscreenchange after the user pressed Esc.
    await triggerFullscreenExit(page);
    await expect(page.getByLabel('Open menu')).toBeVisible();
  });
});
