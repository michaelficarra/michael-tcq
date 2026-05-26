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

  // The dialog is a native modal <dialog>, so the platform provides Esc and
  // back-gesture dismissal, light dismiss, focus trapping, and focus
  // restoration. These tests pin those behaviours down in real browsers
  // (jsdom can't simulate them, so the component tests only cover the wiring).

  test('Escape dismisses the modal', async ({ page }) => {
    await createMeeting(page);
    await page.locator('body').press(',');
    const prefs = page.getByRole('dialog', { name: 'Preferences' });
    await expect(prefs).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(prefs).not.toBeVisible();
  });

  test('the ✕ button dismisses the modal', async ({ page }) => {
    await createMeeting(page);
    await page.locator('body').press(',');
    const prefs = page.getByRole('dialog', { name: 'Preferences' });
    await expect(prefs).toBeVisible();

    await prefs.getByRole('button', { name: 'Close' }).click();
    await expect(prefs).not.toBeVisible();
  });

  test('light dismiss: clicking the backdrop dismisses the modal', async ({ page }) => {
    await createMeeting(page);
    await page.locator('body').press(',');
    const prefs = page.getByRole('dialog', { name: 'Preferences' });
    await expect(prefs).toBeVisible();

    // Click the top-left backdrop region — well outside the centred content
    // box. Handled by `closedby="any"` where supported, and by the JS
    // outside-click fallback in Safari.
    await page.mouse.click(8, 300);
    await expect(prefs).not.toBeVisible();
  });

  test('clicking inside the content box does not dismiss the modal', async ({ page }) => {
    await createMeeting(page);
    await page.locator('body').press(',');
    const prefs = page.getByRole('dialog', { name: 'Preferences' });
    await expect(prefs).toBeVisible();

    await prefs.getByRole('heading', { name: 'Preferences' }).click();
    await expect(prefs).toBeVisible();
  });

  test('focus is trapped inside the dialog and restored to the opener on close', async ({ page, browserName }) => {
    // Native <dialog> focus restoration stopped landing on the opener in WebKit
    // when the app's first `popover` elements were introduced (a4d4519c). The
    // mechanism is still unexplained — focus trapping (below) works, only the
    // post-close restoration fails. Quarantined pending a dedicated dive.
    test.fixme(
      browserName === 'webkit',
      'WebKit: native <dialog> focus restoration not landing on opener since a4d4519c',
    );
    await createMeeting(page);
    // Give a known element focus so we can assert restoration lands back on it.
    const queueTab = page.getByRole('tab', { name: 'Queue' });
    await queueTab.focus();

    await page.keyboard.press(',');
    const prefs = page.getByRole('dialog', { name: 'Preferences' });
    await expect(prefs).toBeVisible();

    // showModal() moves focus into the dialog and traps it there; Tabbing a
    // few times must never escape the dialog subtree.
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Tab');
      expect(await prefs.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    }

    await page.keyboard.press('Escape');
    await expect(prefs).not.toBeVisible();
    // Native focus restoration returns focus to the element that opened it.
    await expect(queueTab).toBeFocused();
  });

  test('Escape while editing a saved topic does not dismiss the modal', async ({ page }) => {
    await createMeeting(page);
    await page.locator('body').press(',');
    const prefs = page.getByRole('dialog', { name: 'Preferences' });
    await expect(prefs).toBeVisible();

    // Add a fresh saved topic and start editing it. The mock-auth user
    // already has a seeded topic, so target the newly-appended row via
    // .last() to avoid a strict-mode clash with the existing input.
    await prefs.getByRole('button', { name: 'Add saved topic' }).click();
    const input = prefs.getByLabel('Saved topic text').last();
    await input.fill('A topic');

    // Esc inside the row's text input is handled locally by the row (which
    // calls preventDefault), so it must not reach the dialog as a close
    // request — the modal stays open for continued editing.
    await input.press('Escape');
    await expect(prefs).toBeVisible();
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
    // Close the preferences modal. Wait for the close (and its exit
    // animation) to fully commit: the native <dialog> stays mounted, so an
    // un-named getByRole('dialog') below would transiently match the still-
    // fading Preferences dialog alongside the shortcuts one.
    await page.locator('body').press('Escape');
    await expect(prefs).not.toBeVisible();

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
