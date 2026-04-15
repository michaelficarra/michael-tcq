import { test, expect } from '@playwright/test';
import {
  waitForHomePage,
  createMeeting,
  goToAgendaTab,
  goToQueueTab,
  goToLogTab,
  addAgendaItem,
  startMeeting,
  addQueueEntry,
} from './helpers.js';

test.describe('Keyboard Shortcuts', () => {
  test('pressing "?" opens the keyboard shortcuts dialog', async ({ page }) => {
    await createMeeting(page);
    await page.keyboard.press('?');
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByText('Keyboard Shortcuts')).toBeVisible();
  });

  test('the dialog lists all shortcuts', async ({ page }) => {
    await createMeeting(page);
    await page.keyboard.press('?');

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    // Check that expected shortcuts are listed
    await expect(dialog.getByText('New Topic')).toBeVisible();
    await expect(dialog.getByText('Reply to current topic')).toBeVisible();
    await expect(dialog.getByText('Clarifying Question')).toBeVisible();
    await expect(dialog.getByText('Point of Order')).toBeVisible();
    await expect(dialog.getByText('Next Speaker')).toBeVisible();
    await expect(dialog.getByText('Toggle presentation mode')).toBeVisible();
    await expect(dialog.getByText('Switch to Agenda tab')).toBeVisible();
    await expect(dialog.getByText('Switch to Queue tab')).toBeVisible();
    await expect(dialog.getByText('Switch to Logs tab')).toBeVisible();
    await expect(dialog.getByText('Switch to Help tab')).toBeVisible();
  });

  test('the dialog has an enable/disable toggle', async ({ page }) => {
    await createMeeting(page);
    await page.keyboard.press('?');

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    // Should have a Disable button (shortcuts are enabled by default)
    const toggleButton = dialog.getByRole('button', { name: 'Disable' });
    await expect(toggleButton).toBeVisible();

    // Click to disable
    await toggleButton.click();
    await expect(dialog.getByRole('button', { name: 'Enable' })).toBeVisible();

    // Click to re-enable
    await dialog.getByRole('button', { name: 'Enable' }).click();
    await expect(dialog.getByRole('button', { name: 'Disable' })).toBeVisible();
  });

  test('pressing Escape closes the shortcuts dialog', async ({ page }) => {
    await createMeeting(page);
    await page.keyboard.press('?');

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
  });

  test('pressing "1" switches to Agenda tab', async ({ page }) => {
    await createMeeting(page);
    // Default tab is Queue
    await expect(page.getByRole('tab', { name: 'Queue' })).toHaveAttribute('aria-selected', 'true');

    await page.keyboard.press('1');
    await expect(page.getByRole('tab', { name: 'Agenda' })).toHaveAttribute('aria-selected', 'true');
  });

  test('pressing "2" switches to Queue tab', async ({ page }) => {
    await createMeeting(page);
    // Switch away from Queue first
    await goToAgendaTab(page);
    await expect(page.getByRole('tab', { name: 'Agenda' })).toHaveAttribute('aria-selected', 'true');

    await page.keyboard.press('2');
    await expect(page.getByRole('tab', { name: 'Queue' })).toHaveAttribute('aria-selected', 'true');
  });

  test('pressing "3" switches to Log tab', async ({ page }) => {
    await createMeeting(page);
    await page.keyboard.press('3');
    await expect(page.getByRole('tab', { name: 'Log' })).toHaveAttribute('aria-selected', 'true');
  });

  test('pressing "4" switches to Help tab', async ({ page }) => {
    await createMeeting(page);
    await page.keyboard.press('4');
    await expect(page.getByRole('tab', { name: 'Help' })).toHaveAttribute('aria-selected', 'true');
  });

  test('shortcuts are disabled when typing in a text field', async ({ page }) => {
    await createMeeting(page);
    await goToAgendaTab(page);

    // Click "New Agenda Item" to show the form
    await page.getByRole('button', { name: /New Agenda Item/i }).click();
    const nameInput = page.getByLabel('Agenda Item Name');
    await nameInput.focus();

    // Pressing "1" while focused on an input should type into the field,
    // not switch tabs
    await page.keyboard.press('1');
    await expect(nameInput).toHaveValue('1');

    // The Queue tab should still not be the active one (we're on Agenda)
    await expect(page.getByRole('tab', { name: 'Agenda' })).toHaveAttribute('aria-selected', 'true');
  });
});

test.describe('Error Handling', () => {
  test('non-existent meeting shows error page with "Back to home" link', async ({ page }) => {
    await page.goto('/meeting/does-not-exist-at-all');

    await expect(page.getByText('Back to home')).toBeVisible();

    // The link navigates back to the home page
    await page.getByText('Back to home').click();
    await page.waitForURL('/');
    await expect(page.getByRole('heading', { name: 'Join Meeting' })).toBeVisible();
  });

  test('error banner is not visible when there is no error', async ({ page }) => {
    await createMeeting(page);

    // No error initially — no alert banner should be visible
    await expect(page.getByRole('alert')).not.toBeVisible();
  });
});

test.describe('Real-Time Updates', () => {
  test('connection status indicator is visible when connected', async ({ page }) => {
    await createMeeting(page);

    // The connection status indicator shows "Connected" on hover
    const statusDot = page.getByTitle('Connected');
    await expect(statusDot).toBeVisible();
  });

  test('connection status indicator has accessible label', async ({ page }) => {
    await createMeeting(page);

    const statusDot = page.getByTitle('Connected');
    await expect(statusDot).toBeVisible();
    // Verify it's accessible to screen readers
    await expect(statusDot).toHaveAttribute('aria-label', 'Connected to server');
  });
});

test.describe('User Identity Display', () => {
  test('user names are shown with avatars in the meeting', async ({ page }) => {
    await createMeeting(page);
    await goToAgendaTab(page);
    await addAgendaItem(page, 'Avatar Test Item', 'admin');
    await startMeeting(page);

    // The queue panel should show the current agenda item owner with an avatar
    const queuePanel = page.getByRole('tabpanel', { name: 'Queue' });
    await expect(queuePanel.locator('img').first()).toBeVisible();
  });

  test('avatars that fail to load show a fallback', async ({ page }) => {
    await createMeeting(page);
    await goToAgendaTab(page);
    await addAgendaItem(page, 'Fallback Test', 'admin');
    await startMeeting(page);

    // Avatar images should be present in the queue panel
    const queuePanel = page.getByRole('tabpanel', { name: 'Queue' });
    const firstAvatar = queuePanel.locator('img').first();
    await expect(firstAvatar).toBeVisible();

    // Trigger the error handler by setting an invalid src
    await firstAvatar.evaluate((img: HTMLImageElement) => {
      img.onerror?.(new Event('error'));
    });

    // After the error, the image src should be replaced with a data URI fallback
    await expect(firstAvatar).toHaveAttribute('src', /^data:image\/svg\+xml/);
  });

  test('user badge shows name alongside the avatar', async ({ page }) => {
    await createMeeting(page);
    await goToAgendaTab(page);
    await addAgendaItem(page, 'Badge Name Test', 'admin');
    await startMeeting(page);

    // The "admin" user name should be visible alongside an avatar
    const queuePanel = page.getByRole('tabpanel', { name: 'Queue' });
    await expect(queuePanel.getByText('admin').first()).toBeVisible();
    await expect(queuePanel.locator('img').first()).toBeVisible();
  });
});
