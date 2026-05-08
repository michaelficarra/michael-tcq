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

  test('middle-clicking a tab opens that view in a new browser tab without changing the current one', async ({
    page,
    context,
    browserName,
  }) => {
    // WebKit headless under Playwright does not simulate the native
    // middle-click → new-tab behaviour, so the synthesised event never
    // produces a `page` event. The behaviour itself works in real Safari;
    // we cover it on Chromium and Firefox.
    test.skip(browserName === 'webkit', 'WebKit headless does not open a new tab on middle-click');

    await waitForHomePage(page);

    // Middle-click is the browser-native "open in new tab" gesture. Tabs are
    // rendered as <a href="#…"> so the click falls through to the browser
    // (the React onClick handler only intercepts plain left-click). Listen
    // for the new page on the context, then perform the middle-click.
    const newPagePromise = context.waitForEvent('page');
    await page.getByRole('tab', { name: 'Help' }).click({ button: 'middle' });
    const newPage = await newPagePromise;
    await newPage.waitForLoadState();

    // The new tab lands on the Help view (via hash → tab init in HomePage).
    await expect(newPage).toHaveURL(/#help$/);
    await expect(newPage.getByRole('tab', { name: 'Help' })).toHaveAttribute('aria-selected', 'true');

    // The original tab is unaffected — still on Join Meeting.
    await expect(page.getByRole('tab', { name: 'Join Meeting' })).toHaveAttribute('aria-selected', 'true');

    await newPage.close();
  });
});

test.describe('My Meetings panel', () => {
  test('is hidden for a user with no associated meetings', async ({ page }) => {
    await waitForHomePage(page);
    // Switch to a fresh login that has never appeared in any meeting on this
    // server, so the caller's UserKey is not in any `meeting.users` map and
    // not in any `meeting.participantIds`. The panel renders nothing in
    // that state.
    await switchUser(page, 'mymeetings-fresh-noone');
    await expect(page.getByRole('heading', { name: 'My Meetings' })).toHaveCount(0);
  });

  test('lists a meeting the user just created and links into it', async ({ page }) => {
    // Default mock auth user ('admin') is the chair of the new meeting, so
    // their UserKey lands in `meeting.users` and the panel surfaces it.
    const id = await createMeeting(page);
    await waitForHomePage(page);
    const panel = page.getByRole('heading', { name: 'My Meetings' }).locator('..');
    await expect(panel).toBeVisible();
    const link = panel.getByRole('link', { name: id });
    await expect(link).toBeVisible();
    await link.click();
    await page.waitForURL(`**/meeting/${encodeURIComponent(id)}`);
    expect(page.url()).toContain(`/meeting/${encodeURIComponent(id)}`);
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

  test('visiting /#admin as a non-admin falls back to the Join Meeting view', async ({ page }) => {
    // Switch to a non-admin user first, then try to deep-link to /#admin.
    await waitForHomePage(page);
    await switchUser(page, 'testuser');
    await page.goto('/#admin');
    // The Admin tab button isn't rendered and the Join Meeting view shows
    // instead. The URL hash isn't asserted: depending on whether the browser
    // treats the goto as a hashchange (in-session correction triggers and the
    // hash flips back to #join) or a full reload (no rewrite on initial mount,
    // hash stays #admin), either is acceptable — what matters is that the
    // user sees the Join view rather than a broken Admin one.
    await expect(page.getByRole('tab', { name: 'Admin' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Join Meeting' })).toBeVisible();
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
