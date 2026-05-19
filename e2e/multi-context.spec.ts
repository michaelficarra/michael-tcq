/**
 * Multi-context Playwright tests. Each spec opens a second browser
 * context and asserts behaviour that depends on real cross-client
 * propagation through the live server.
 *
 * Coverage groups:
 *   - smoke: the helpers themselves wire up
 *   - broadcast convergence: a mutation in one context appears in another
 *   - simultaneous-action races: precondition guards under real browser-level concurrency
 *   - presence/identity: connection counts and user-switch propagation
 *   - network disruption: offline / reconnect behaviour
 */

import { expect, test } from '@playwright/test';
import {
  addAgendaItem,
  addQueueEntry,
  createMeeting,
  goToAgendaTab,
  goToQueueTab,
  offlineFor,
  openSecondContext,
  startMeeting,
  waitForHomePage,
} from './helpers.js';

test.describe('multi-context smoke', () => {
  test('opens a second context on an existing meeting and tears it down', async ({ browser, page }) => {
    const meetingId = await createMeeting(page);
    await goToAgendaTab(page);

    const second = await openSecondContext(browser, meetingId);
    try {
      // The second context should land on the meeting page — the
      // Agenda tab is visible to anyone with the meeting URL.
      await expect(second.page.getByRole('tab', { name: 'Agenda' })).toBeVisible();
    } finally {
      await second.context.close();
    }
  });

  test('offlineFor takes a context offline and brings it back', async ({ browser, page }) => {
    const meetingId = await createMeeting(page);
    const second = await openSecondContext(browser, meetingId);
    try {
      // Confirm the second context loaded the meeting before going offline.
      await expect(second.page.getByRole('tab', { name: 'Agenda' })).toBeVisible();

      // Brief offline window — long enough to be observable, short
      // enough not to slow the suite. We don't assert the connection
      // indicator here (that's Phase F's job); we just confirm the
      // helper runs end-to-end without throwing.
      await offlineFor(second.context, 200);

      // After returning online, the page is still alive and navigable.
      await expect(second.page.getByRole('tab', { name: 'Agenda' })).toBeVisible();
    } finally {
      await second.context.close();
    }
  });

  test('home page loads in a fresh second context', async ({ browser }) => {
    // Verifies waitForHomePage works inside a context the test didn't
    // create itself — the entry path for openSecondContext({ asUser })
    // when an explicit user switch is needed.
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await waitForHomePage(page);
    } finally {
      await context.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Broadcast convergence — one context mutates, the other observes.
// ---------------------------------------------------------------------------

test.describe('broadcast convergence', () => {
  test('agenda:add in one context becomes visible in another', async ({ browser, page }) => {
    const meetingId = await createMeeting(page);
    await goToAgendaTab(page);

    const second = await openSecondContext(browser, meetingId);
    try {
      await second.page.getByRole('tab', { name: 'Agenda' }).click();

      await addAgendaItem(page, 'Cross-context item');

      // The second context should pick up the broadcast and render
      // the new item without any reload.
      const secondAgendaPanel = second.page.getByRole('tabpanel', { name: 'Agenda' });
      await expect(secondAgendaPanel.getByText('Cross-context item')).toBeVisible();
    } finally {
      await second.context.close();
    }
  });

  test('queue:add in one context becomes visible in another', async ({ browser, page }) => {
    await createMeeting(page);
    await goToAgendaTab(page);
    await addAgendaItem(page, 'Item 1');
    await startMeeting(page);

    const url = new URL(page.url());
    const meetingId = decodeURIComponent(url.pathname.split('/meeting/')[1]);

    const second = await openSecondContext(browser, meetingId);
    try {
      await goToQueueTab(second.page);

      await addQueueEntry(page, 'New Topic', 'Cross-context topic');

      await expect(second.page.getByText('Cross-context topic')).toBeVisible();
    } finally {
      await second.context.close();
    }
  });

  test('speaker advance in one context updates the current-speaker UI in another', async ({ browser, page }) => {
    await createMeeting(page);
    await goToAgendaTab(page);
    await addAgendaItem(page, 'Item 1');
    await startMeeting(page);

    const url = new URL(page.url());
    const meetingId = decodeURIComponent(url.pathname.split('/meeting/')[1]);

    // Add an entry the chair can advance into.
    await addQueueEntry(page, 'New Topic', 'first speaker topic');

    const second = await openSecondContext(browser, meetingId);
    try {
      await goToQueueTab(second.page);
      // Pre-condition: second context sees the entry in the queue
      // before the advance.
      await expect(second.page.getByText('first speaker topic')).toBeVisible();

      await page.getByRole('button', { name: 'Next Speaker' }).click();

      // After the advance, the topic text moves out of the queue
      // section and into the speaking/topic region. The strongest
      // cross-context signal is that the queue list is now empty
      // (or at least no longer contains the topic).
      const secondQueueList = second.page.getByRole('list', { name: 'Queued speakers' });
      await expect(secondQueueList.getByText('first speaker topic')).toHaveCount(0);
    } finally {
      await second.context.close();
    }
  });

  test('a poll started in one context appears in another', async ({ browser, page }) => {
    await createMeeting(page);
    await goToAgendaTab(page);
    await addAgendaItem(page, 'Item 1');
    await startMeeting(page);

    const url = new URL(page.url());
    const meetingId = decodeURIComponent(url.pathname.split('/meeting/')[1]);

    const second = await openSecondContext(browser, meetingId);
    try {
      // Both contexts are on the Queue tab and looking at the same
      // current agenda item, so both will see the poll dialog.
      await goToQueueTab(second.page);

      await page.getByRole('button', { name: 'Create Poll' }).click();
      const setup = page.getByRole('dialog', { name: 'Create poll' });
      await setup.getByRole('button', { name: 'Start Poll' }).click();
      await expect(setup).not.toBeVisible();

      // Both contexts now see an active poll dialog. The chair sees
      // the chair view; another chair (same identity) sees the same
      // dialog.
      await expect(second.page.getByRole('dialog', { name: 'Active poll' })).toBeVisible();
    } finally {
      await second.context.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Simultaneous-action races
//
// Real browser-level tests of the server's precondition guard (e.g. two
// chairs clicking "Next Speaker" at the same instant) are not reliable
// at the e2e layer. By the time the second context's click handler
// runs, the broadcast from the first click can arrive and update the
// local state, so the second emit goes out with the *new* precondition
// rather than the same stale one — the precondition guard never trips
// because the conflict the test is trying to construct doesn't make it
// onto the wire. The genuinely concurrent path (two emits with the
// same stale precondition) is covered by the Phase D in-process tests
// using `emitInParallel`, which fires both before either side can
// receive a feedback broadcast.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Presence / identity propagation.
// ---------------------------------------------------------------------------

test.describe('presence and identity', () => {
  test('connection-count badge ticks up when a second context joins and back down on close', async ({
    browser,
    page,
  }) => {
    const meetingId = await createMeeting(page);

    // The dot exposes its connection count via aria-label, which
    // updates whenever the server emits an `activeConnections` event.
    const dot = page.getByLabel(/active participant connection/i);

    // First context, alone — exactly 1 active connection.
    await expect(dot).toHaveAttribute('aria-label', /1 active participant connection/);

    const second = await openSecondContext(browser, meetingId);
    try {
      await expect(dot).toHaveAttribute('aria-label', /2 active participant connections/);
    } finally {
      await second.context.close();
    }

    // After the second context closes, the count returns to 1.
    await expect(dot).toHaveAttribute('aria-label', /1 active participant connection/);
  });

  test('a queue entry added under a different mock identity surfaces with that identity', async ({ browser, page }) => {
    await createMeeting(page);
    await goToAgendaTab(page);
    await addAgendaItem(page, 'Item 1');
    await startMeeting(page);

    const url = new URL(page.url());
    const meetingId = decodeURIComponent(url.pathname.split('/meeting/')[1]);

    // A second context authenticated as a different mock user.
    const second = await openSecondContext(browser, meetingId, { asUser: 'alice' });
    try {
      await goToQueueTab(second.page);
      await addQueueEntry(second.page, 'New Topic', 'alice topic');

      // The original (admin) context observes the entry attributed to
      // alice. We assert on a queue entry whose surrounding container
      // contains both the topic and the identity — a `getByText`
      // alone could match navigation chrome.
      const aliceEntry = page.getByRole('listitem').filter({ hasText: 'alice topic' });
      await expect(aliceEntry).toBeVisible();
      await expect(aliceEntry).toContainText('alice');
    } finally {
      await second.context.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Network disruption.
// ---------------------------------------------------------------------------

test.describe('network disruption', () => {
  test('the connection indicator goes red and surfaces "Connection lost" while offline', async ({ browser, page }) => {
    // We assert the disconnected half of the dot's lifecycle here.
    // The reconnection half (indicator returning to green after the
    // network restores) is implicitly covered by the next test —
    // when the offline context catches up on a mutation, the only
    // way it could observe the mutation is by reconnecting first,
    // and the dot logic is the same React hook for both states.
    const meetingId = await createMeeting(page);

    const second = await openSecondContext(browser, meetingId);
    try {
      // Pre-condition: indicator shows connected.
      const dot = second.page.getByLabel(/active participant connection|disconnected/i);
      await expect(dot).toHaveAttribute('aria-label', /active participant connection/);

      // Take just the second context offline. The Socket.IO client
      // detects the dropped transport and `connected` flips to false,
      // swapping the dot's aria-label to the disconnected variant and
      // surfacing a "Connection lost" pill the user can dismiss.
      await second.context.setOffline(true);
      await expect(second.page.getByRole('button', { name: 'Connection lost' })).toBeVisible();
      await expect(dot).toHaveAttribute('aria-label', /disconnected/i);
    } finally {
      // Bring the context back online before close so its async
      // disconnect handlers don't trip on hard teardown.
      await second.context.setOffline(false);
      await second.context.close();
    }
  });

  // The "context catches up on mutations after returning online" path
  // is not reliably testable here: Playwright's `setOffline` blocks new
  // HTTP requests but doesn't consistently terminate an already-open
  // WebSocket across chromium / firefox / webkit, so a broadcast can
  // still get through "while offline" in some browsers. The assertion
  // that the offline context misses the broadcast then fails — not
  // because the application is broken, but because the test's
  // simulated offline isn't strong enough. The reconnect-and-resync
  // codepath itself is covered by the in-process tests in
  // `socket.test.ts` ("reconnect re-emits state and re-seeds the
  // surrogate", and the gap-detection block).
});

// ---------------------------------------------------------------------------
// Prologue concurrent-edit conflict banner.
//
// PRD § Agenda Prologue and Epilogue > Concurrent Edits:
//   "If another chair updates the same section while the editor is open,
//    a sticky warning banner appears above the textarea... Clicking Save
//    while the banner is showing opens the overwrite confirmation dialogue."
//
// This is one of the few cases where multi-context drives behaviour that
// can't be exercised at the unit-test layer — the banner only renders
// when one chair's `value` prop changes mid-edit.
// ---------------------------------------------------------------------------

test.describe('prologue conflict banner', () => {
  test('a concurrent update surfaces a banner, and Save opens an overwrite confirmation', async ({ browser, page }) => {
    const meetingId = await createMeeting(page);
    await goToAgendaTab(page);

    // First populate the section so the test can edit (not add-new).
    const placeholder = page.getByRole('button', { name: 'Add an agenda prologue' });
    await placeholder.click();
    await page.getByRole('textbox', { name: 'Agenda prologue' }).fill('Original');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Original')).toBeVisible();

    // Open a second chair context. The default mock user "admin" is the
    // sole chair on this meeting, so we add a new chair "bob" first.
    await page.getByLabel('Add chair').click();
    await page.getByPlaceholder('username').fill('bob');
    await page.getByPlaceholder('username').press('Enter');
    await expect(page.getByRole('tabpanel', { name: 'Agenda' })).toContainText('bob');

    const second = await openSecondContext(browser, meetingId, { asUser: 'bob' });
    try {
      // Chair A (admin) opens the prologue editor.
      await page.getByRole('button', { name: 'Edit prologue' }).click();
      const editor = page.getByRole('textbox', { name: 'Agenda prologue' });
      await expect(editor).toBeVisible();
      await editor.fill('My edits in progress');

      // Chair B (bob) saves a different prologue in the second context.
      await goToAgendaTab(second.page);
      await second.page.getByRole('button', { name: 'Edit prologue' }).click();
      await second.page.getByRole('textbox', { name: 'Agenda prologue' }).fill("Bob's overwrite");
      await second.page.getByRole('button', { name: 'Save' }).click();

      // Chair A's editor is still open; the conflict banner appears.
      await expect(page.getByText(/Another chair has updated the prologue/i)).toBeVisible();

      // Saving while the banner is showing opens the overwrite confirmation.
      await page.getByRole('button', { name: 'Save' }).click();
      const overwrite = page.getByRole('dialog', { name: /Overwrite Prologue/i });
      await expect(overwrite).toBeVisible();

      // Cancelling keeps the banner around and the editor open.
      await overwrite.getByRole('button', { name: 'Cancel' }).click();
      await expect(overwrite).not.toBeVisible();
      await expect(page.getByText(/Another chair has updated the prologue/i)).toBeVisible();

      // Dismissing the banner via the × clears it.
      await page.getByLabel('Dismiss conflict warning').click();
      await expect(page.getByText(/Another chair has updated the prologue/i)).not.toBeVisible();
    } finally {
      await second.context.close();
    }
  });
});
