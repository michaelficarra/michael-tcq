import { test, expect } from '@playwright/test';
import {
  waitForHomePage,
  createMeeting,
  goToAgendaTab,
  goToQueueTab,
  goToLogTab,
  goToHelpTab,
  addAgendaItem,
  startMeeting,
  advanceAgenda,
  addQueueEntry,
} from './helpers.js';

test.describe('Creating a Meeting', () => {
  test('clicking "Start a New Meeting" creates a meeting with a word-based ID and redirects to it', async ({
    page,
  }) => {
    await waitForHomePage(page);
    await page.getByRole('button', { name: 'Start a New Meeting' }).click();

    await page.waitForURL(/\/meeting\//);

    // Meeting ID should be word-based (e.g. "bright-pine-lake")
    const id = decodeURIComponent(new URL(page.url()).pathname.split('/meeting/')[1]);
    expect(id).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);
  });
});

test.describe('Joining a Meeting', () => {
  test('a user can join a meeting by entering its ID on the home page', async ({ page }) => {
    // First create a meeting to get a valid ID
    const meetingId = await createMeeting(page);

    // Go back to the home page and join via the form
    await waitForHomePage(page);
    await page.getByLabel('Meeting ID').fill(meetingId);
    await page.getByRole('button', { name: 'Join' }).click();

    await page.waitForURL(/\/meeting\//);
    expect(page.url()).toContain(encodeURIComponent(meetingId));
  });

  test('navigating directly to /meeting/:id works', async ({ page }) => {
    const meetingId = await createMeeting(page);

    // Navigate directly
    await page.goto(`/meeting/${encodeURIComponent(meetingId)}`);
    await expect(page.getByText('Waiting for the meeting to start')).toBeVisible();
  });

  test('navigating to a non-existent meeting shows an error page with "Back to home" link', async ({ page }) => {
    await page.goto('/meeting/nonexistent-fake-meeting');

    await expect(page.getByText('Back to home')).toBeVisible();

    // Clicking "Back to home" navigates to the home page
    await page.getByText('Back to home').click();
    await page.waitForURL('/');
    await expect(page.getByRole('heading', { name: 'Join Meeting' })).toBeVisible();
  });
});

test.describe('Meeting Flow', () => {
  test('before the meeting starts, the queue view shows waiting message and "Start Meeting" button', async ({
    page,
  }) => {
    await createMeeting(page);

    // Add an agenda item so the Start Meeting button appears
    await goToAgendaTab(page);
    await addAgendaItem(page, 'First Topic', 'admin');
    await goToQueueTab(page);

    await expect(page.getByText('Waiting for the meeting to start')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start Meeting' })).toBeVisible();
  });

  test('clicking "Start Meeting" advances to the first agenda item', async ({ page }) => {
    await createMeeting(page);
    await goToAgendaTab(page);
    await addAgendaItem(page, 'Opening Remarks', 'admin');
    await startMeeting(page);

    // The current agenda item should appear in the Queue panel's Agenda
    // Item section. Scope the assertion because the Agenda panel (always
    // rendered) also contains the item name.
    const queuePanel = page.getByRole('tabpanel', { name: 'Queue' });
    await expect(queuePanel.getByRole('region', { name: 'Agenda Item' })).toContainText('Opening Remarks');
  });

  test('"Next Agenda Item" advances to the next item', async ({ page }) => {
    await createMeeting(page);
    await goToAgendaTab(page);
    await addAgendaItem(page, 'Item One', 'admin');
    await addAgendaItem(page, 'Item Two', 'admin');
    await startMeeting(page);

    await advanceAgenda(page);

    const queuePanel = page.getByRole('tabpanel', { name: 'Queue' });
    await expect(queuePanel.getByRole('region', { name: 'Agenda Item' })).toContainText('Item Two');
  });

  test('completing an agenda item replaces its estimate with the actual elapsed duration', async ({ page }) => {
    await createMeeting(page);
    await goToAgendaTab(page);
    // Seed an obviously-wrong estimate on the first item (99 min → "1h 39m")
    // so we can verify it was overwritten rather than merely left alone.
    await addAgendaItem(page, 'Item One', 'admin', 99);
    await addAgendaItem(page, 'Item Two', 'admin');

    const agendaPanel = page.getByRole('tabpanel', { name: 'Agenda' });
    await expect(agendaPanel.getByText('1h 39m', { exact: true })).toBeVisible();

    await startMeeting(page);

    // Let a handful of ms elapse so the server sees a non-zero duration.
    await page.waitForTimeout(50);

    await advanceAgenda(page);

    await goToAgendaTab(page);
    // Real elapsed time is milliseconds → Math.ceil rounds up to 1 minute.
    await expect(agendaPanel.getByText('1m', { exact: true })).toBeVisible();
    await expect(agendaPanel.getByText('1h 39m', { exact: true })).not.toBeVisible();
  });

  test('"Next Agenda Item" button becomes "Conclude meeting" on the last item', async ({ page }) => {
    await createMeeting(page);
    await goToAgendaTab(page);
    await addAgendaItem(page, 'Only Item', 'admin');
    await startMeeting(page);

    // On the last item the button is relabelled — same dialog flow,
    // just clearer copy for ending the meeting.
    await expect(page.getByRole('button', { name: 'Next Agenda Item' })).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'Conclude meeting' })).toBeVisible();
  });

  test('chair can advance past the final item to record a conclusion; adding a new item auto-activates it', async ({
    page,
  }) => {
    await createMeeting(page);
    await goToAgendaTab(page);
    await addAgendaItem(page, 'Final Item', 'admin');
    await startMeeting(page);

    // Conclude the final item with a conclusion via the same dialog.
    await advanceAgenda(page, 'agreed to revisit next quarter');

    // Past-final UI on the queue tab.
    await goToQueueTab(page);
    await expect(page.getByText(/Meeting concluded/i)).toBeVisible();

    // Add a new agenda item — server auto-activates it as the current
    // item, so the past-final hint goes away and the new item is shown.
    await goToAgendaTab(page);
    await addAgendaItem(page, 'Follow-up', 'admin');
    await goToQueueTab(page);
    await expect(page.getByText(/Meeting concluded/i)).not.toBeVisible();
    // `exact: true` so this matches the agenda item name and not the
    // "Introducing: Follow-up" topic introduction the speaker section
    // renders for the auto-activated item's first presenter.
    await expect(page.getByText('Follow-up', { exact: true })).toBeVisible();
  });

  test('adding a session while concluded does NOT auto-activate (only items do)', async ({ page }) => {
    await createMeeting(page);
    await goToAgendaTab(page);
    await addAgendaItem(page, 'Only Item', 'admin');
    await startMeeting(page);
    await advanceAgenda(page); // conclude the only item

    await goToQueueTab(page);
    await expect(page.getByText(/Meeting concluded/i)).toBeVisible();

    // Add a session header — should NOT auto-activate (sessions never
    // become the current item).
    await goToAgendaTab(page);
    await page.getByRole('button', { name: 'New Session' }).click();
    await page.getByLabel('Session Name').fill('Wrap up');
    await page.getByLabel('Capacity').fill('30');
    await page.getByRole('button', { name: 'Create' }).click();

    await goToQueueTab(page);
    // Meeting still concluded; no current item picked up from the session.
    await expect(page.getByText(/Meeting concluded/i)).toBeVisible();
  });

  test('Next Agenda Item dialog warns about clearing the queue and shows the entry count', async ({ page }) => {
    await createMeeting(page);
    await goToAgendaTab(page);
    await addAgendaItem(page, 'First', 'admin');
    await addAgendaItem(page, 'Second', 'admin');
    await startMeeting(page);

    // Stack a couple of entries in the queue.
    await addQueueEntry(page, 'New Topic', 'A');
    await addQueueEntry(page, 'New Topic', 'B');

    await page.getByRole('button', { name: /^(Next Agenda Item|Conclude meeting)$/ }).click();
    const dialog = page.getByRole('dialog', { name: /confirm agenda advancement/i });
    await expect(dialog).toBeVisible();
    // The dialog body warns about queue clearing and includes the count "2".
    await expect(dialog.getByText(/clear the speaker queue.*2.*entries/i)).toBeVisible();
  });

  test('Ctrl/Cmd+Enter inside the conclusion textarea submits the dialog', async ({ page }) => {
    await createMeeting(page);
    await goToAgendaTab(page);
    await addAgendaItem(page, 'First', 'admin');
    await addAgendaItem(page, 'Second', 'admin');
    await startMeeting(page);

    await page.getByRole('button', { name: /^(Next Agenda Item|Conclude meeting)$/ }).click();
    const dialog = page.getByRole('dialog', { name: /confirm agenda advancement/i });
    await expect(dialog).toBeVisible();

    // The textarea is autofocused; type a conclusion, then submit via
    // Ctrl+Enter on Linux/Windows or Cmd+Enter on macOS.
    const textarea = dialog.getByLabel(/conclusion/i);
    await textarea.fill('Decided via shortcut');
    const submitKey = process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter';
    await textarea.press(submitKey);

    await expect(dialog).not.toBeVisible();
    // Current item should have moved on.
    await expect(page.getByRole('region', { name: 'Agenda Item' })).toContainText('Second');
  });
});

test.describe('Navigation', () => {
  test('meeting page has four tabs: Agenda, Queue, Log, Help', async ({ page }) => {
    await createMeeting(page);

    await expect(page.getByRole('tab', { name: 'Agenda' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Queue' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Log' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Help' })).toBeVisible();
  });

  test('the Agenda tab is the default active tab after creating a meeting', async ({ page }) => {
    await createMeeting(page);

    await expect(page.getByRole('tab', { name: 'Agenda' })).toHaveAttribute('aria-selected', 'true');
  });

  test('the active tab has aria-selected="true"', async ({ page }) => {
    await createMeeting(page);

    // Agenda is the default after creation
    await expect(page.getByRole('tab', { name: 'Agenda' })).toHaveAttribute('aria-selected', 'true');

    // Switch to Queue
    await goToQueueTab(page);
    await expect(page.getByRole('tab', { name: 'Queue' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab', { name: 'Agenda' })).toHaveAttribute('aria-selected', 'false');
  });

  test('clicking each tab shows the corresponding panel', async ({ page }) => {
    await createMeeting(page);

    // Agenda panel is visible by default after creation — verify agenda-specific content
    await expect(page.getByText('No agenda items yet.')).toBeVisible();

    // Switch to Queue — verify queue-specific content
    await goToQueueTab(page);
    await expect(page.getByText('Waiting for the meeting to start')).toBeVisible();
    await expect(page.getByText('No agenda items yet.')).not.toBeVisible();

    // Switch to Log
    await goToLogTab(page);
    await expect(page.getByText('Waiting for the meeting to start')).not.toBeVisible();

    // Switch to Help
    await goToHelpTab(page);
    await expect(page.getByText('Waiting for the meeting to start')).not.toBeVisible();

    // Switch back to Agenda
    await goToAgendaTab(page);
    await expect(page.getByText('No agenda items yet.')).toBeVisible();
  });

  test('the active-tab underline slides to align with the selected tab', async ({ page }) => {
    await createMeeting(page);

    const tablist = page.getByRole('tablist', { name: 'Meeting views' });
    // The sliding underline is the decorative aria-hidden element inside the tablist.
    const indicator = tablist.locator('[aria-hidden="true"]');

    // Polls until the underline has settled aligned to the named tab — i.e. its x and
    // width match the tab's (within a px or two). This both waits out the slide animation
    // and ignores the underline's 0-width initial state, then returns the settled left x.
    const settledUnderTab = async (tabName: string): Promise<number> => {
      let x = NaN;
      await expect
        .poll(async () => {
          const tab = await page.getByRole('tab', { name: tabName }).boundingBox();
          const ind = await indicator.boundingBox();
          if (!tab || !ind) return false;
          x = ind.x;
          return Math.abs(ind.x - tab.x) <= 2 && Math.abs(ind.width - tab.width) <= 2;
        })
        .toBe(true);
      return x;
    };

    // Initially the underline sits under the default-active Agenda tab.
    const agendaX = await settledUnderTab('Agenda');

    // Switching to Help moves the underline rightward to sit under the Help tab.
    await goToHelpTab(page);
    const helpX = await settledUnderTab('Help');

    // It actually moved (slid) rightward, rather than staying put.
    expect(helpX).toBeGreaterThan(agendaX);
  });

  test('top navigation bar shows the TCQ logo linking to home, tabs, and user menu', async ({ page }) => {
    await createMeeting(page);

    const nav = page.getByRole('navigation');
    await expect(nav).toBeVisible();

    // Logo links to home
    const logoLink = nav.getByRole('link', { name: 'TCQ' });
    await expect(logoLink).toBeVisible();

    // Clicking the logo navigates to home
    await logoLink.click();
    await page.waitForURL('/');
    await expect(page.getByRole('heading', { name: 'Join Meeting' })).toBeVisible();
  });

  test('the Help tab is available on the home page', async ({ page }) => {
    await waitForHomePage(page);

    const helpTab = page.getByRole('tab', { name: 'Help' });
    await expect(helpTab).toBeVisible();

    await helpTab.click();
    await expect(helpTab).toHaveAttribute('aria-selected', 'true');
  });

  test('browser back/forward traverses tab history before leaving the meeting page', async ({ page }) => {
    // Each tab click is a real history entry (pushState), so the browser
    // back button steps backwards through the tabs the user visited and
    // only leaves the meeting page once the tab stack is exhausted.
    // "Start a New Meeting" navigates to `/meeting/:id#agenda`, so the
    // first meeting-page history entry already carries the #agenda hash.
    const meetingId = await createMeeting(page);
    // Meeting IDs are `[a-z]+-[a-z]+-[a-z]+` and encodeURIComponent is a
    // no-op for those unreserved chars, so the path is safe to drop into
    // a regex without escaping.
    const meetingPath = `/meeting/${encodeURIComponent(meetingId)}`;

    await expect(page.getByRole('tab', { name: 'Agenda' })).toHaveAttribute('aria-selected', 'true');

    await goToQueueTab(page);
    await expect(page).toHaveURL(new RegExp(`${meetingPath}#queue$`));

    await goToLogTab(page);
    await expect(page).toHaveURL(new RegExp(`${meetingPath}#log$`));

    // Back: Log → Queue.
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`${meetingPath}#queue$`));
    await expect(page.getByRole('tab', { name: 'Queue' })).toHaveAttribute('aria-selected', 'true');

    // Back again: Queue → Agenda (the initial #agenda entry from creation).
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`${meetingPath}#agenda$`));
    await expect(page.getByRole('tab', { name: 'Agenda' })).toHaveAttribute('aria-selected', 'true');

    // Forward: Agenda → Queue again.
    await page.goForward();
    await expect(page).toHaveURL(new RegExp(`${meetingPath}#queue$`));
    await expect(page.getByRole('tab', { name: 'Queue' })).toHaveAttribute('aria-selected', 'true');

    // Two more back steps exit to the previous page (the home page that
    // created the meeting): one for #queue → #agenda, one for the meeting
    // page itself. Verifies the meeting-page tab history doesn't trap the
    // user — back eventually escapes to the referring page.
    await page.goBack();
    await page.goBack();
    await page.waitForURL('/');
    await expect(page.getByRole('heading', { name: 'Join Meeting' })).toBeVisible();
  });

  test('middle-clicking a meeting tab opens that view in a new browser tab without changing the current one', async ({
    page,
    context,
    browserName,
  }) => {
    // WebKit headless under Playwright does not simulate the native
    // middle-click → new-tab behaviour, so the synthesised event never
    // produces a `page` event. The behaviour itself works in real Safari;
    // we cover it on Chromium and Firefox.
    test.skip(browserName === 'webkit', 'WebKit headless does not open a new tab on middle-click');

    const meetingId = await createMeeting(page);

    // Tabs render as <a href="#…">, so a real middle-click falls through to
    // the browser and opens the destination in a new tab. Listen for the
    // new context-level page event before performing the click.
    const newPagePromise = context.waitForEvent('page');
    await page.getByRole('tab', { name: 'Queue' }).click({ button: 'middle' });
    const newPage = await newPagePromise;
    await newPage.waitForLoadState();

    // New tab loads the same meeting URL with the Queue hash — and the
    // MeetingPage's hash → tab init lands on the Queue panel.
    await expect(newPage).toHaveURL(new RegExp(`/meeting/${encodeURIComponent(meetingId)}#queue$`));
    await expect(newPage.getByRole('tab', { name: 'Queue' })).toHaveAttribute('aria-selected', 'true');

    // The original tab is unaffected — still on Agenda.
    await expect(page.getByRole('tab', { name: 'Agenda' })).toHaveAttribute('aria-selected', 'true');

    await newPage.close();
  });
});
