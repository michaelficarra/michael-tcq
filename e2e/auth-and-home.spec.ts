import { test, expect } from '@playwright/test';
import { waitForHomePage, createMeeting } from './helpers.js';

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
    // The New Meeting card should still be visible but Join Meeting card content should be replaced
    await expect(page.getByRole('heading', { name: 'Join Meeting' })).not.toBeVisible();
  });
});

test.describe('Mock Auth User Switcher', () => {
  test('clicking username opens a text input for switching users', async ({ page }) => {
    await waitForHomePage(page);
    const nav = page.getByRole('navigation');
    // Click the username button in the nav
    await nav.getByRole('button').filter({ hasText: 'admin' }).click();
    // A text input should appear
    await expect(nav.getByRole('textbox')).toBeVisible();
  });

  test('switching user changes the displayed identity', async ({ page }) => {
    await waitForHomePage(page);
    const nav = page.getByRole('navigation');
    // Open the user switcher
    await nav.getByRole('button').filter({ hasText: 'admin' }).click();
    const input = nav.getByRole('textbox');
    await input.fill('testuser');
    await input.press('Enter');
    // Wait for the identity to update
    await expect(nav).toContainText('testuser');
  });
});
