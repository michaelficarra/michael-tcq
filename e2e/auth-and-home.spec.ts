import { test, expect } from '@playwright/test';
import { waitForHomePage, createMeeting, switchUser } from './helpers.js';

test.describe('Authentication / Login', () => {
  test('mock auth auto-logs in as default user', async ({ page }) => {
    await waitForHomePage(page);
    // The nav bar should show the "Admin" display name
    await expect(page.getByRole('navigation')).toContainText('Admin');
  });

  test('unauthenticated users see the login page', async ({ page }) => {
    // Log out first to clear mock auth
    await page.goto('/auth/logout');
    await page.waitForURL('/');
    await expect(page.getByText('Welcome to TCQ')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Log in with GitHub' })).toBeVisible();
  });

  test('after logout, visiting / shows the login page', async ({ page }) => {
    await page.goto('/auth/logout');
    await page.waitForURL('/');
    // Explicitly navigate to / again
    await page.goto('/');
    await expect(page.getByText('Welcome to TCQ')).toBeVisible();
  });

  test('visiting /auth/github re-authenticates after logout', async ({ page }) => {
    await page.goto('/auth/logout');
    await page.waitForURL('/');
    // Re-authenticate via the mock auth flow
    await page.goto('/auth/github');
    await waitForHomePage(page);
    await expect(page.getByRole('navigation')).toContainText('Admin');
  });
});

test.describe('Home Page', () => {
  test('shows Join Meeting and New Meeting cards', async ({ page }) => {
    await waitForHomePage(page);
    await expect(page.getByRole('heading', { name: 'Join Meeting' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'New Meeting' })).toBeVisible();
    // Join Meeting card has a text input and Join button
    await expect(page.getByRole('textbox')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Join' })).toBeVisible();
    // New Meeting card has a Start button
    await expect(page.getByRole('button', { name: 'Start a New Meeting' })).toBeVisible();
  });

  test('Join Meeting shows error for non-existent meeting ID', async ({ page }) => {
    await waitForHomePage(page);
    await page.getByRole('textbox').fill('nonexistent-meeting-id');
    await page.getByRole('button', { name: 'Join' }).click();
    await expect(page.getByText('Meeting not found')).toBeVisible();
  });

  test('"Start a New Meeting" creates a meeting and redirects', async ({ page }) => {
    const id = await createMeeting(page);
    expect(id).toBeTruthy();
    expect(page.url()).toContain(`/meeting/${encodeURIComponent(id)}`);
  });

  test('has Join Meeting and Help tabs', async ({ page }) => {
    await waitForHomePage(page);
    await expect(page.getByRole('tab', { name: 'Join Meeting' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Help' })).toBeVisible();
  });

  test('clicking Help tab shows help content', async ({ page }) => {
    await waitForHomePage(page);
    await page.getByRole('tab', { name: 'Help' }).click();
    // Help tab should now be selected and show help content
    await expect(page.getByRole('tab', { name: 'Help' })).toHaveAttribute('aria-selected', 'true');
    // The URL fragment tracks the active tab so the view is bookmarkable.
    await expect(page).toHaveURL(/#help$/);
    // The New Meeting card should still be visible but Join Meeting card content should be replaced
    await expect(page.getByRole('heading', { name: 'Join Meeting' })).not.toBeVisible();
  });

  test('visiting /#help directly lands on the Help tab', async ({ page }) => {
    // Note: don't use waitForHomePage here — it goto('/') and would clobber the hash.
    await page.goto('/#help');
    await expect(page.getByRole('tab', { name: 'Help' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('heading', { name: 'Join Meeting' })).not.toBeVisible();
  });
});

test.describe('Admin Tab', () => {
  // Default mock-auth user is "admin" and `.env.test` sets ADMIN_USERNAMES=admin,
  // so the test browser starts logged in as an admin. Switching to any other
  // login (e.g. "testuser") gives us a non-admin to exercise the hidden case.

  test('Admin tab is visible for admin users', async ({ page }) => {
    await waitForHomePage(page);
    await expect(page.getByRole('tab', { name: 'Admin' })).toBeVisible();
  });

  test('clicking Admin tab shows Active Meetings and Diagnostics panels', async ({ page }) => {
    await waitForHomePage(page);
    await page.getByRole('tab', { name: 'Admin' }).click();
    await expect(page.getByRole('tab', { name: 'Admin' })).toHaveAttribute('aria-selected', 'true');
    // The two panels (with their renamed headers — no "Admin —" prefix) replace the Join cards
    await expect(page.getByRole('heading', { name: 'Active Meetings' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Diagnostics' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Join Meeting' })).not.toBeVisible();
  });

  test('Admin tab is hidden for non-admin users', async ({ page }) => {
    await waitForHomePage(page);
    await switchUser(page, 'testuser');
    // The Admin tab button is conditionally rendered, so it isn't in the DOM at all —
    // toHaveCount(0) is more reliable than not.toBeVisible() for absent elements.
    await expect(page.getByRole('tab', { name: 'Admin' })).toHaveCount(0);
    // The other two tabs are still present.
    await expect(page.getByRole('tab', { name: 'Join Meeting' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Help' })).toBeVisible();
  });

  test('losing admin status while on Admin tab falls back to Join Meeting', async ({ page }) => {
    await waitForHomePage(page);
    await page.getByRole('tab', { name: 'Admin' }).click();
    await expect(page.getByRole('heading', { name: 'Active Meetings' })).toBeVisible();
    // Switching user triggers a full page reload, so the new HomePage instance
    // initialises with activeTab='join'. (If the fallback ever needs to handle
    // an in-place admin downgrade, the useEffect in HomePage covers it too.)
    await switchUser(page, 'testuser');
    await expect(page.getByRole('tab', { name: 'Admin' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Join Meeting' })).toBeVisible();
  });

  test('visiting /#admin directly lands on the Admin tab for admin users', async ({ page }) => {
    // Note: don't use waitForHomePage here — it goto('/') and would clobber the hash.
    await page.goto('/#admin');
    await expect(page.getByRole('tab', { name: 'Admin' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('heading', { name: 'Active Meetings' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Diagnostics' })).toBeVisible();
  });

  test('visiting /#admin as a non-admin self-corrects to /#join', async ({ page }) => {
    // Switch to a non-admin user first, then try to deep-link to /#admin.
    await waitForHomePage(page);
    await switchUser(page, 'testuser');
    await page.goto('/#admin');
    // Admin button isn't rendered, the Join Meeting view is shown,
    // and the URL has been rewritten so it doesn't claim an Admin view.
    await expect(page.getByRole('tab', { name: 'Admin' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Join Meeting' })).toBeVisible();
    await expect(page).toHaveURL(/#join$/);
  });
});

test.describe('User Badge in Nav', () => {
  test('user badge with avatar and name is visible in the navigation bar', async ({ page }) => {
    await waitForHomePage(page);
    const nav = page.getByRole('navigation');
    // Badge should show an avatar image and the user's name
    await expect(nav.locator('img').first()).toBeVisible();
    await expect(nav).toContainText('Admin');
  });

  test('user badge is visible on the meeting page nav bar', async ({ page }) => {
    const id = await createMeeting(page);
    await page.goto(`/meeting/${id}`);
    const nav = page.getByRole('navigation');
    await expect(nav.locator('img').first()).toBeVisible();
    await expect(nav).toContainText('Admin');
  });
});

test.describe('Mock Auth User Switcher', () => {
  test('clicking username opens an input for switching users', async ({ page }) => {
    await waitForHomePage(page);
    const nav = page.getByRole('navigation');
    // Click the username button in the nav
    await nav.getByRole('button').filter({ hasText: 'admin' }).click();
    // The switcher input is now a UserCombobox (role=combobox).
    await expect(nav.getByRole('combobox')).toBeVisible();
  });

  test('switching user changes the displayed identity', async ({ page }) => {
    await waitForHomePage(page);
    const nav = page.getByRole('navigation');
    // Open the user switcher
    await nav.getByRole('button').filter({ hasText: 'admin' }).click();
    const input = nav.getByRole('combobox');
    await input.fill('testuser');
    await input.press('Enter');
    // Wait for the identity to update
    await expect(nav).toContainText('testuser');
  });
});
