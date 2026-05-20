import { test, expect } from '@playwright/test';
import { createMeeting, waitForHomePage } from './helpers.js';
import { installMatchMediaMock, setSystemDark } from './mocks.js';

/**
 * Preferences modal: opened via the hamburger menu or the `,` shortcut.
 * Exposes the keyboard-shortcut toggle, notification toggles, and the
 * Colour scheme select. Choices persist immediately to localStorage.
 *
 * The colour-scheme `system` branch reads `prefers-color-scheme`, so we
 * stub `matchMedia` via `installMatchMediaMock` and flip it with
 * `setSystemDark` for deterministic assertions.
 */

test.describe('Preferences modal', () => {
  test.fixme('opens from the hamburger menu', async ({ page }) => {
    await createMeeting(page);
    await page.getByLabel('Open menu').click();
    await page.getByRole('menuitem', { name: 'Preferences' }).click();
    await expect(page.getByRole('dialog', { name: 'Preferences' })).toBeVisible();
  });

  test('opens via the "," keyboard shortcut', async ({ page }) => {
    await createMeeting(page);
    await page.locator('body').press(',');
    await expect(page.getByRole('dialog', { name: 'Preferences' })).toBeVisible();
  });

  test('clicking outside the hamburger dropdown dismisses it', async ({ page }) => {
    await createMeeting(page);
    await page.getByLabel('Open menu').click();
    await expect(page.getByRole('menuitem', { name: 'Preferences' })).toBeVisible();

    // Click somewhere on the page body that is not the menu.
    await page.mouse.click(10, 200);
    await expect(page.getByRole('menuitem', { name: 'Preferences' })).not.toBeVisible();
  });

  test('the shortcuts toggle mirrors the ? dialog state', async ({ page, browserName }) => {
    // Flaky on Firefox (~2–3% even after defensive waits, rAF position
    // measurement, and outside-click closest()). The remaining race is in
    // React 18 StrictMode's mount-unmount-mount of newly-portaled subtrees
    // combined with Firefox's getBoundingClientRect timing on a fresh portal.
    // Skip on Firefox until we can either move the dropdown off the portal or
    // land a more invasive refactor; the same behaviour is exercised on
    // chromium and webkit.
    test.fixme(browserName === 'firefox', 'flaky on firefox — portal + StrictMode race');
    await createMeeting(page);
    // Disable via Preferences modal first.
    await page.locator('body').press(',');
    const prefs = page.getByRole('dialog', { name: 'Preferences' });
    await prefs.getByLabel('Keyboard shortcuts').uncheck();
    await expect(prefs.getByLabel('Keyboard shortcuts')).not.toBeChecked();
    // Close via Escape.
    await page.locator('body').press('Escape');
    // Wait for the modal-close commit to finish. Firefox has been observed
    // to flake on the menuitem click below when the dropdown opens while
    // React is still committing the modal unmount: the outside-click
    // pointerdown handler in HamburgerMenu can detach the menuitem before
    // Playwright dispatches the click.
    await expect(prefs).not.toBeVisible();

    // The shortcuts dialog can still be opened — but `?` is now disabled.
    // Re-enable from the preferences modal via hamburger menu.
    await page.getByLabel('Open menu').click();
    // Wait for the dropdown to be present before targeting a menuitem
    // inside it. Same render-timing race as above.
    await expect(page.getByRole('menu')).toBeVisible();
    await page.getByRole('menuitem', { name: 'Preferences' }).click();
    await prefs.getByLabel('Keyboard shortcuts').check();
    await expect(prefs.getByLabel('Keyboard shortcuts')).toBeChecked();
    // Close the preferences modal.
    await page.locator('body').press('Escape');

    // Now `?` should open the keyboard shortcuts dialog, and the toggle
    // there should read "Disable" (i.e. shortcuts currently enabled).
    await page.locator('body').press('?');
    const shortcutsDialog = page.getByRole('dialog');
    await expect(shortcutsDialog).toBeVisible();
    await expect(shortcutsDialog.getByRole('button', { name: 'Disable' })).toBeVisible();
  });
});

test.describe('Preferences — Colour scheme', () => {
  test.beforeEach(async ({ page }) => {
    await installMatchMediaMock(page, false);
  });

  test('selecting Dark applies the dark class to <html>', async ({ page }) => {
    await waitForHomePage(page);
    await page.getByLabel('Open menu').click();
    await page.getByRole('menuitem', { name: 'Preferences' }).click();
    const prefs = page.getByRole('dialog', { name: 'Preferences' });
    await prefs.getByLabel('Colour scheme').selectOption({ label: 'Dark' });

    await expect(page.locator('html')).toHaveClass(/(^|\s)dark(\s|$)/);
  });

  test('selecting Light removes the dark class', async ({ page }) => {
    await waitForHomePage(page);
    await page.getByLabel('Open menu').click();
    await page.getByRole('menuitem', { name: 'Preferences' }).click();
    const prefs = page.getByRole('dialog', { name: 'Preferences' });
    await prefs.getByLabel('Colour scheme').selectOption({ label: 'Dark' });
    await expect(page.locator('html')).toHaveClass(/(^|\s)dark(\s|$)/);

    await prefs.getByLabel('Colour scheme').selectOption({ label: 'Light' });
    await expect(page.locator('html')).not.toHaveClass(/(^|\s)dark(\s|$)/);
  });

  test('System scheme follows the matchMedia stub', async ({ page }) => {
    await waitForHomePage(page);
    // Start with the System default — light by default in the mock.
    await page.getByLabel('Open menu').click();
    await page.getByRole('menuitem', { name: 'Preferences' }).click();
    const prefs = page.getByRole('dialog', { name: 'Preferences' });
    await prefs.getByLabel('Colour scheme').selectOption({ label: 'System' });

    // Flip the mocked OS to dark — the live `change` listener should apply.
    await setSystemDark(page, true);
    await expect(page.locator('html')).toHaveClass(/(^|\s)dark(\s|$)/);

    await setSystemDark(page, false);
    await expect(page.locator('html')).not.toHaveClass(/(^|\s)dark(\s|$)/);
  });

  test('colour-scheme choice persists across reload', async ({ page }) => {
    await waitForHomePage(page);
    await page.getByLabel('Open menu').click();
    await page.getByRole('menuitem', { name: 'Preferences' }).click();
    const prefs = page.getByRole('dialog', { name: 'Preferences' });
    await prefs.getByLabel('Colour scheme').selectOption({ label: 'Dark' });
    await expect(page.locator('html')).toHaveClass(/(^|\s)dark(\s|$)/);

    await page.reload();
    // The dark class should be re-applied from localStorage on load.
    await expect(page.locator('html')).toHaveClass(/(^|\s)dark(\s|$)/);
  });
});
