import { test, expect } from '@playwright/test';
import {
  createMeeting,
  goToAgendaTab,
  goToQueueTab,
  addAgendaItem,
  startMeeting,
  addQueueEntry,
  advanceAgenda,
  switchUser,
  openSecondContext,
} from './helpers.js';
import { installNotificationMock, getNotifications, clearNotifications, setNotificationPermission } from './mocks.js';

/**
 * Browser-notification preferences.
 *
 * `Notification` is fully stubbed (`installNotificationMock`) so each
 * invocation is recorded into `window.__notifications` and read back with
 * `getNotifications`. Permission is programmable per-test.
 *
 * The hook that fires notifications (`useMeetingNotifications`) lives on
 * the meeting page, so all tests navigate to a meeting first.
 */

test.describe('Notifications — permission flow', () => {
  test('first enabling notifications prompts for permission and persists when granted', async ({ page }) => {
    await installNotificationMock(page, 'default');
    // Configure the mock to grant permission when requestPermission is called.
    await page.addInitScript(() => {
      const Notif = (
        window as unknown as { Notification: { requestPermission: () => Promise<NotificationPermission> } }
      ).Notification;
      const original = Notif.requestPermission;
      Notif.requestPermission = async () => {
        const result: NotificationPermission = 'granted';
        await original.call(Notif); // no-op recording
        (
          window as unknown as { __setNotificationPermission: (p: NotificationPermission) => void }
        ).__setNotificationPermission(result);
        return result;
      };
    });

    await createMeeting(page);
    await page.locator('body').press(',');
    const prefs = page.getByRole('dialog', { name: 'Preferences' });
    const toggle = prefs.getByLabel('Notifications', { exact: true });
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await expect(toggle).toBeChecked();
  });

  test('first enabling notifications stays off when permission is denied', async ({ page }) => {
    await installNotificationMock(page, 'default');
    // Configure denial.
    await page.addInitScript(() => {
      const Notif = (
        window as unknown as { Notification: { requestPermission: () => Promise<NotificationPermission> } }
      ).Notification;
      Notif.requestPermission = async () => {
        (
          window as unknown as { __setNotificationPermission: (p: NotificationPermission) => void }
        ).__setNotificationPermission('denied');
        return 'denied';
      };
    });

    await createMeeting(page);
    await page.locator('body').press(',');
    const prefs = page.getByRole('dialog', { name: 'Preferences' });
    const toggle = prefs.getByLabel('Notifications', { exact: true });
    // .check() asserts the box becomes checked, which doesn't happen here
    // (denial flips it back off). Use a raw click and assert the end state.
    await toggle.click();
    await expect(toggle).not.toBeChecked();
  });

  test('revoking permission later self-heals the preference back to off', async ({ page }) => {
    await installNotificationMock(page, 'granted');
    await createMeeting(page);
    // Turn the toggle on.
    await page.locator('body').press(',');
    const prefs = page.getByRole('dialog', { name: 'Preferences' });
    const toggle = prefs.getByLabel('Notifications', { exact: true });
    await toggle.check();
    await expect(toggle).toBeChecked();
    await page.locator('body').press('Escape');

    // Now revoke at the browser level and trigger a state change in-page.
    await setNotificationPermission(page, 'denied');
    await goToAgendaTab(page);
    await addAgendaItem(page, 'Item', 'admin');

    // Re-open Preferences — the toggle should have flipped off without any
    // notification firing.
    await page.locator('body').press(',');
    await expect(prefs.getByLabel('Notifications', { exact: true })).not.toBeChecked();
    const fired = await getNotifications(page);
    expect(fired).toEqual([]);
  });
});

test.describe('Notifications — events', () => {
  test("a notification fires when the user's queue entry reaches the head", async ({ page, browser }) => {
    await installNotificationMock(page, 'granted');
    // Set up meeting in admin's session.
    await createMeeting(page);
    await goToAgendaTab(page);
    await addAgendaItem(page, 'Item', 'admin');
    await startMeeting(page);

    // Switch the same page to bob (so we test bob's notifications).
    await switchUser(page, 'bob');
    // Bob enables notifications.
    await page.locator('body').press(',');
    await page.getByRole('dialog', { name: 'Preferences' }).getByLabel('Notifications', { exact: true }).check();
    await page.locator('body').press('Escape');

    // Bob queues a New Topic. Once it's the head of the queue, the
    // "You're up next" notification should fire.
    await goToQueueTab(page);
    await clearNotifications(page);
    await addQueueEntry(page, 'New Topic', "Bob's topic");

    // The hook diffs prev vs current state and fires when head changes.
    await expect
      .poll(async () => (await getNotifications(page)).some((n) => n.title === "You're up next"))
      .toBeTruthy();
  });

  test('"Meeting started" notification fires on the initial transition; agenda-advance does not also fire', async ({
    page,
  }) => {
    await installNotificationMock(page, 'granted');
    await createMeeting(page);

    // Admin enables notifications.
    await page.locator('body').press(',');
    await page.getByRole('dialog', { name: 'Preferences' }).getByLabel('Notifications', { exact: true }).check();
    await page.locator('body').press('Escape');

    await goToAgendaTab(page);
    await addAgendaItem(page, 'First', 'admin');
    await clearNotifications(page);
    await startMeeting(page);

    await expect
      .poll(async () => (await getNotifications(page)).some((n) => n.title === 'Meeting started'))
      .toBeTruthy();
    // Mutually exclusive: no "Agenda advanced" notification on the first transition.
    const fired = await getNotifications(page);
    expect(fired.some((n) => n.title === 'Agenda advanced')).toBe(false);
  });

  test('"Agenda advanced" notification fires on subsequent advances', async ({ page }) => {
    await installNotificationMock(page, 'granted');
    await createMeeting(page);

    await page.locator('body').press(',');
    await page.getByRole('dialog', { name: 'Preferences' }).getByLabel('Notifications', { exact: true }).check();
    await page.locator('body').press('Escape');

    await goToAgendaTab(page);
    await addAgendaItem(page, 'First', 'admin');
    await addAgendaItem(page, 'Second', 'admin');
    await startMeeting(page);

    // Clear after the initial "Meeting started" fires.
    await clearNotifications(page);
    await advanceAgenda(page);
    await expect
      .poll(async () => (await getNotifications(page)).some((n) => n.title === 'Agenda advanced'))
      .toBeTruthy();
  });

  // Multi-context notification assertions: bob's second context has trouble
  // joining the meeting reliably within this test setup — admin's `Connected
  // — 1 active connection` indicator stays at 1 instead of incrementing.
  // Pending follow-up: install the notification mock at the BrowserContext
  // boundary before any navigation and verify cross-context join.
  test.fixme('"Poll started" notification fires for participants but not the chair who started it', async ({
    page,
    browser,
  }) => {
    await installNotificationMock(page, 'granted');
    await createMeeting(page);
    await goToAgendaTab(page);
    await addAgendaItem(page, 'Item', 'admin');
    await startMeeting(page);
    const meetingId = page.url().split('/meeting/')[1];

    // Admin enables notifications too — to verify they're NOT notified.
    await page.locator('body').press(',');
    await page.getByRole('dialog', { name: 'Preferences' }).getByLabel('Notifications', { exact: true }).check();
    await page.locator('body').press('Escape');

    // Bob's context with the notification mock pre-installed at the
    // context level so it applies on the very first navigation.
    const bobContext = await browser.newContext();
    await installNotificationMock(bobContext, 'granted');
    const bobPage = await bobContext.newPage();
    try {
      // Switch user before joining the meeting (mirrors openSecondContext).
      await bobPage.goto('/');
      await expect(bobPage.getByRole('heading', { name: 'Join Meeting' })).toBeVisible();
      const nav = bobPage.getByRole('navigation');
      const userMenu = nav.getByRole('combobox');
      if (!(await userMenu.isVisible())) {
        await nav.getByRole('button').filter({ hasText: /\w/ }).last().click();
      }
      await userMenu.fill('bob');
      await userMenu.press('Enter');
      await expect(userMenu).not.toBeVisible();
      await bobPage.goto(`/meeting/${encodeURIComponent(meetingId)}`);

      // Bob enables notifications.
      await bobPage.locator('body').press(',');
      await bobPage.getByRole('dialog', { name: 'Preferences' }).getByLabel('Notifications', { exact: true }).check();
      await bobPage.locator('body').press('Escape');

      await clearNotifications(page);
      await clearNotifications(bobPage);

      // Admin starts a poll.
      await page.getByRole('button', { name: 'Create Poll' }).click();
      await page.getByRole('dialog', { name: 'Create poll' }).getByRole('button', { name: 'Start Poll' }).click();

      // Bob receives the notification.
      await expect
        .poll(async () => (await getNotifications(bobPage)).some((n) => n.title === 'Poll started'))
        .toBeTruthy();
      // Admin (the chair who started it) does not.
      const adminFired = await getNotifications(page);
      expect(adminFired.some((n) => n.title === 'Poll started')).toBe(false);
    } finally {
      await bobContext.close();
    }
  });

  test('point-of-order and overrun notifications are off by default', async ({ page }) => {
    await installNotificationMock(page, 'granted');
    await createMeeting(page);

    // Admin enables the top-level toggle. Per-event toggles default to on
    // EXCEPT point-of-order and agenda-item-overrun (off by default).
    await page.locator('body').press(',');
    const prefs = page.getByRole('dialog', { name: 'Preferences' });
    await prefs.getByLabel('Notifications', { exact: true }).check();
    await expect(prefs.getByLabel('When a point of order is raised')).not.toBeChecked();
    await expect(prefs.getByLabel('When the current agenda item exceeds its time estimate')).not.toBeChecked();
  });

  test.fixme('point-of-order notification fires when enabled and another user raises one', async ({
    page,
    browser,
  }) => {
    await installNotificationMock(page, 'granted');
    await createMeeting(page);
    await goToAgendaTab(page);
    await addAgendaItem(page, 'Item', 'admin');
    await startMeeting(page);
    const meetingId = page.url().split('/meeting/')[1];

    // Admin enables notifications and turns on the POO sub-toggle.
    await page.locator('body').press(',');
    const prefs = page.getByRole('dialog', { name: 'Preferences' });
    await prefs.getByLabel('Notifications', { exact: true }).check();
    await prefs.getByLabel('When a point of order is raised').check();
    await page.locator('body').press('Escape');

    // Bob (second context) raises a Point of Order. We don't need the
    // notification mock in bob's context since we're only asserting admin's
    // notifications, so openSecondContext is fine here.
    const { context: bobContext, page: bobPage } = await openSecondContext(browser, meetingId, { asUser: 'bob' });
    try {
      await goToQueueTab(bobPage);
      await addQueueEntry(bobPage, 'Point of Order', 'Off topic');

      await expect
        .poll(async () => (await getNotifications(page)).some((n) => n.title === 'Point of order'))
        .toBeTruthy();
    } finally {
      await bobContext.close();
    }
  });
});
