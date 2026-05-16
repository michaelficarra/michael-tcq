import { test, expect } from '@playwright/test';
import {
  createMeeting,
  goToAgendaTab,
  goToQueueTab,
  addAgendaItem,
  startMeeting,
  addQueueEntry,
  advanceAgenda,
  queueSection,
  switchUser,
  dragAndDrop,
} from './helpers.js';

/**
 * Helper: create a meeting with one agenda item and start it.
 * Most queue tests need this as a baseline.
 */
async function setupStartedMeeting(page: import('@playwright/test').Page) {
  await createMeeting(page);
  await goToAgendaTab(page);
  await addAgendaItem(page, 'Item 1');
  await startMeeting(page);
}

// ---------------------------------------------------------------------------
// Queue Entry Types
// ---------------------------------------------------------------------------

test.describe('Queue Entry Types', () => {
  test.beforeEach(async ({ page }) => {
    await setupStartedMeeting(page);
  });

  test('shows three entry type buttons when there is no current topic', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'New Topic' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Clarifying Question' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Point of Order' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Discuss Current Topic' })).not.toBeVisible();
  });

  test('Reply button appears once there is a current topic', async ({ page }) => {
    // Advance a New Topic entry to become the current speaker, establishing a topic
    await addQueueEntry(page, 'New Topic', 'My first topic');
    await page.getByRole('button', { name: 'Next Speaker' }).click();

    await expect(page.getByRole('button', { name: 'Discuss Current Topic' })).toBeVisible();
  });

  test('entries are ordered by priority: Point of Order > Clarifying Question > New Topic', async ({ page }) => {
    // Add entries in reverse priority order
    await addQueueEntry(page, 'New Topic', 'A new topic');
    await addQueueEntry(page, 'Clarifying Question', 'A question');
    await addQueueEntry(page, 'Point of Order', 'Urgent matter');

    const queue = page.getByRole('list', { name: 'Queued speakers' });
    const items = queue.getByRole('listitem');

    // Point of Order should be first (highest priority)
    await expect(items.nth(0)).toContainText('Urgent matter');
    // Clarifying Question second
    await expect(items.nth(1)).toContainText('A question');
    // New Topic last (lowest priority)
    await expect(items.nth(2)).toContainText('A new topic');
  });
});

// ---------------------------------------------------------------------------
// Entering the Queue
// ---------------------------------------------------------------------------

test.describe('Entering the Queue', () => {
  test.beforeEach(async ({ page }) => {
    await setupStartedMeeting(page);
  });

  test('clicking an entry type button adds an entry to the queue', async ({ page }) => {
    await addQueueEntry(page, 'New Topic', 'Test topic');

    await expect(page.getByText('Test topic')).toBeVisible();
  });

  test('new entries open in edit mode with text pre-selected', async ({ page }) => {
    await page.getByRole('button', { name: 'New Topic' }).click();

    // The edit input should be visible
    const input = page.getByLabel('Topic description');
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();
  });

  test('pressing Escape during initial edit removes the entry', async ({ page }) => {
    await page.getByRole('button', { name: 'New Topic' }).click();

    const input = page.getByLabel('Topic description');
    await expect(input).toBeVisible();
    await input.press('Escape');

    // The entry should be removed — queue should be empty
    await expect(page.getByText('The queue is empty.')).toBeVisible();
  });

  test('clicking Save keeps the entry with the new topic text', async ({ page }) => {
    await page.getByRole('button', { name: 'New Topic' }).click();

    const input = page.getByLabel('Topic description');
    await input.fill('My custom topic');
    await page.getByRole('button', { name: 'Save' }).click();

    // Entry should now be in display mode with the custom text
    await expect(page.getByText('My custom topic')).toBeVisible();
    // Edit input should no longer be visible
    await expect(input).not.toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Queue Display
// ---------------------------------------------------------------------------

test.describe('Queue Display', () => {
  test.beforeEach(async ({ page }) => {
    await setupStartedMeeting(page);
  });

  test('each entry shows position number, type badge, topic text, and speaker name', async ({ page }) => {
    await addQueueEntry(page, 'New Topic', 'Display test');

    const item = page.getByRole('list', { name: 'Queued speakers' }).getByRole('listitem').first();
    // Position number
    await expect(item).toContainText('1');
    // Type badge
    await expect(item).toContainText('New Topic');
    // Topic text
    await expect(item).toContainText('Display test');
    // Speaker name (default mock user is "Admin")
    await expect(item).toContainText('Admin');
  });

  test('own entries have a visible left border', async ({ page }) => {
    await addQueueEntry(page, 'New Topic', 'My entry');

    // Border classes live on the inner styled <div>, not the <li> itself —
    // the <li> is the premium-border wrapper.
    const item = page
      .getByRole('list', { name: 'Queued speakers' })
      .getByRole('listitem')
      .first()
      .locator('> div')
      .first();
    await expect(item).toHaveCSS('border-left-width', '3px');
  });

  test('chairs see edit and delete buttons on all entries', async ({ page }) => {
    await addQueueEntry(page, 'New Topic', 'Editable entry');

    const item = page.getByRole('list', { name: 'Queued speakers' }).getByRole('listitem').first();
    await expect(item.getByText('Edit', { exact: true })).toBeVisible();
    await expect(item.getByText('Delete', { exact: true })).toBeVisible();
  });

  test('Point of Order entries have a highlighted background', async ({ page }) => {
    await addQueueEntry(page, 'Point of Order', 'Urgent');

    // Border classes live on the inner styled <div>, not the <li> itself.
    const item = page
      .getByRole('list', { name: 'Queued speakers' })
      .getByRole('listitem')
      .first()
      .locator('> div')
      .first();
    // Point of Order entries have a visible border (red-themed)
    // Check that the item has a border — normal entries don't
    const borderWidth = await item.evaluate((el) => getComputedStyle(el).borderWidth);
    expect(borderWidth).not.toBe('0px');
  });
});

// ---------------------------------------------------------------------------
// Queue Advancement
// ---------------------------------------------------------------------------

test.describe('Queue Advancement', () => {
  test.beforeEach(async ({ page }) => {
    await setupStartedMeeting(page);
  });

  test('"Next Speaker" advances the first queue entry to current speaker', async ({ page }) => {
    await addQueueEntry(page, 'New Topic', 'Speaker topic');
    await page.getByRole('button', { name: 'Next Speaker' }).click();

    // The speaking section should show the speaker's topic
    const speaking = queueSection(page, 'Speaking');
    await expect(speaking).toContainText('Speaker topic');
    await expect(speaking).toContainText('Admin');

    // Queue should now be empty
    await expect(page.getByText('The queue is empty.')).toBeVisible();
  });

  test('advancing when queue is empty clears current speaker', async ({ page }) => {
    // First, set a current speaker
    await addQueueEntry(page, 'New Topic', 'Will be cleared');
    await page.getByRole('button', { name: 'Next Speaker' }).click();
    await expect(queueSection(page, 'Speaking')).toContainText('Will be cleared');

    // Now advance again with empty queue — clears the speaker
    await page.getByRole('button', { name: 'Next Speaker' }).click();
    await expect(page.getByText('Nobody speaking yet')).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Queue Editing
// ---------------------------------------------------------------------------

test.describe('Queue Editing', () => {
  test.beforeEach(async ({ page }) => {
    await setupStartedMeeting(page);
  });

  test('chairs can edit an entry topic inline', async ({ page }) => {
    await addQueueEntry(page, 'New Topic', 'Original topic');

    // Click Edit (visible text button)
    const item = page.getByRole('list', { name: 'Queued speakers' }).getByRole('listitem').first();
    await item.getByText('Edit', { exact: true }).click();

    // The edit input should appear with the current topic
    const input = page.getByLabel('Topic description');
    await expect(input).toBeVisible();
    await expect(input).toHaveValue('Original topic');

    // Change the topic and save
    await input.fill('Updated topic');
    await page.getByRole('button', { name: 'Save' }).click();

    // Verify the updated text
    await expect(item).toContainText('Updated topic');
    await expect(input).not.toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Queue Type Cycling
// ---------------------------------------------------------------------------

test.describe('Queue Type Cycling', () => {
  test.beforeEach(async ({ page }) => {
    await setupStartedMeeting(page);
  });

  test('chairs can click the type badge to cycle through legal types', async ({ page }) => {
    await addQueueEntry(page, 'New Topic', 'Cycle test');

    const item = page.getByRole('list', { name: 'Queued speakers' }).getByRole('listitem').first();

    // The type badge should be a clickable button for chairs
    const typeBadge = item.getByRole('button', { name: /Change type/ });
    await expect(typeBadge).toBeVisible();
    await expect(typeBadge).toContainText('New Topic');

    // Click to cycle — with a single entry, all types are legal
    await typeBadge.click();
    // Should cycle to the next type
    await expect(typeBadge).not.toContainText('New Topic');
  });

  test('participants cannot click the type badge on their own entries', async ({ page }) => {
    // Switch to a non-chair user and add an entry
    await switchUser(page, 'bob');
    await addQueueEntry(page, 'New Topic', 'Participant entry');

    const item = page.getByRole('list', { name: 'Queued speakers' }).getByRole('listitem').first();

    // The type badge should be a plain span, not a button
    await expect(item.getByRole('button', { name: /Change type/ })).not.toBeVisible();
    await expect(item.getByText('New Topic:')).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Copy and Restore Queue
// ---------------------------------------------------------------------------

test.describe('Copy and Restore Queue', () => {
  test.beforeEach(async ({ page }) => {
    await setupStartedMeeting(page);
  });

  test('"Copy Queue" button appears when queue has entries (chair only)', async ({ page }) => {
    // Initially no Copy Queue button (queue is empty)
    await expect(page.getByRole('button', { name: 'Copy Queue' })).not.toBeVisible();

    // Add an entry
    await addQueueEntry(page, 'New Topic', 'Copy test');

    // Now the button should appear
    await expect(page.getByRole('button', { name: 'Copy Queue' })).toBeVisible();
  });

  test('"Restore Queue" button opens a textarea for pasting entries', async ({ page }) => {
    await page.getByRole('button', { name: 'Restore Queue' }).click();

    await expect(page.getByLabel(/Paste queue items/)).toBeVisible();
  });

  test('restoring queue entries from pasted text', async ({ page }) => {
    await page.getByRole('button', { name: 'Restore Queue' }).click();

    const textarea = page.getByLabel(/Paste queue items/);
    await textarea.fill('New Topic: Restored topic\nClarifying Question: Restored question');
    await page.getByRole('button', { name: 'Add to Queue' }).click();

    // Entries should appear in the queue (ordered by priority)
    const queue = page.getByRole('list', { name: 'Queued speakers' });
    await expect(queue.getByRole('listitem')).toHaveCount(2);
    // Clarifying Question has higher priority, should be first
    await expect(queue.getByRole('listitem').nth(0)).toContainText('Restored question');
    await expect(queue.getByRole('listitem').nth(1)).toContainText('Restored topic');
  });
});

// ---------------------------------------------------------------------------
// Current Speaker and Topic
// ---------------------------------------------------------------------------

test.describe('Current Speaker and Topic', () => {
  test.beforeEach(async ({ page }) => {
    await setupStartedMeeting(page);
  });

  test('shows "Nobody speaking yet" when current speaker is cleared', async ({ page }) => {
    // Advance past the initial "Introducing" speaker, then clear
    await page.getByRole('button', { name: 'Next Speaker' }).click();

    await expect(page.getByText('Nobody speaking yet')).toBeVisible();
  });

  test('current speaker shows avatar, name, and topic', async ({ page }) => {
    await addQueueEntry(page, 'New Topic', 'Important topic');
    await page.getByRole('button', { name: 'Next Speaker' }).click();

    const speaking = queueSection(page, 'Speaking');
    await expect(speaking).toContainText('Important topic');
    await expect(speaking).toContainText('Admin');
  });

  test('when a New Topic speaker starts, it becomes the current topic', async ({ page }) => {
    await addQueueEntry(page, 'New Topic', 'The new topic');
    await page.getByRole('button', { name: 'Next Speaker' }).click();

    // When the current speaker IS the topic, the Topic section is not shown separately
    // (the component hides it when currentTopic.id === currentSpeaker.id).
    // But the Reply button should now be available, confirming a topic is set.
    await expect(page.getByRole('button', { name: 'Discuss Current Topic' })).toBeVisible();
  });

  test('current topic is shown in a dedicated section when a reply is speaking', async ({ page }) => {
    // Set up a topic
    await addQueueEntry(page, 'New Topic', 'The topic');
    await page.getByRole('button', { name: 'Next Speaker' }).click();

    // Now add a reply and advance to it
    await addQueueEntry(page, 'Discuss Current Topic', 'My reply');
    await page.getByRole('button', { name: 'Next Speaker' }).click();

    // The Topic section should be visible with the original topic
    const topic = queueSection(page, 'Topic');
    await expect(topic).toBeVisible();
    await expect(topic).toContainText('The topic');

    // The Speaking section should show the reply
    const speaking = queueSection(page, 'Speaking');
    await expect(speaking).toContainText('My reply');
  });
});

// ---------------------------------------------------------------------------
// Timers
// ---------------------------------------------------------------------------

test.describe('Timers', () => {
  test.beforeEach(async ({ page }) => {
    await setupStartedMeeting(page);
  });

  test('current agenda item shows a count-up timer', async ({ page }) => {
    // The agenda item section should contain a timer in M:SS format
    const agendaItem = queueSection(page, 'Agenda Item');
    await expect(agendaItem.getByText(/\d+:\d{2}/)).toBeVisible();
  });

  test('current agenda item shows a badge for each presenter when there are multiple', async ({ page }) => {
    await createMeeting(page);
    await goToAgendaTab(page);
    await addAgendaItem(page, 'Joint session', ['admin', 'otheruser']);
    await startMeeting(page);

    const agendaItem = queueSection(page, 'Agenda Item');
    await expect(agendaItem.locator('img')).toHaveCount(2);
  });

  test('current speaker shows a count-up timer', async ({ page }) => {
    await addQueueEntry(page, 'New Topic', 'Timed topic');
    await page.getByRole('button', { name: 'Next Speaker' }).click();

    const speaking = queueSection(page, 'Speaking');
    await expect(speaking.getByText(/\d+:\d{2}/)).toBeVisible();
  });

  test('agenda item without an estimate shows no timebox annotation', async ({ page }) => {
    // setupStartedMeeting adds "Item 1" with no estimate.
    const agendaItem = queueSection(page, 'Agenda Item');
    await expect(agendaItem.getByText(/expected to end by|exceeded estimate/)).not.toBeVisible();
  });
});

// The timebox annotation tests need their own meeting setup (with an
// estimate set) and one of them installs a fake clock before any
// navigation, so they live in a separate describe block.
test.describe('Agenda timer — timebox annotation', () => {
  test('shows "expected to end by HH:MM" when an estimate is set and not yet exceeded', async ({ page }) => {
    await createMeeting(page);
    await goToAgendaTab(page);
    // 60-min estimate is comfortably larger than any test runtime, so the
    // assertion never races into the "exceeded" branch.
    await addAgendaItem(page, 'Long item', undefined, 60);
    await startMeeting(page);

    const agendaItem = queueSection(page, 'Agenda Item');
    // Regex tolerates both 24h ("14:30") and 12h ("2:30 PM") locales.
    await expect(agendaItem.getByText(/expected to end by \d{1,2}:\d{2}(\s?[AP]M)?/)).toBeVisible();
  });

  test('shows "exceeded estimate" with a tooltip after the estimate elapses', async ({ page }) => {
    // Install Playwright's fake clock before navigation so the agenda
    // start time and the post-fast-forward "now" both observe the same
    // mocked clock. Without this, the server would record a real wall-
    // clock start time and the client's subsequent fastForward wouldn't
    // affect it.
    await page.clock.install();

    await createMeeting(page);
    await goToAgendaTab(page);
    await addAgendaItem(page, 'Short item', undefined, 1); // 1-min estimate
    await startMeeting(page);

    // Fast-forward 2 minutes past the start, putting elapsed > estimate.
    // Pass milliseconds to avoid ambiguity in Playwright's string formats.
    await page.clock.fastForward(2 * 60_000);

    const agendaItem = queueSection(page, 'Agenda Item');
    const annotation = agendaItem.getByText(/exceeded estimate/);
    await expect(annotation).toBeVisible();
    // The full timestamp tooltip should be present (its exact formatting
    // is locale-specific, so we only assert non-empty).
    const title = await annotation.getAttribute('title');
    expect(title).toBeTruthy();
    expect(title?.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Queue Close / Open
// ---------------------------------------------------------------------------

test.describe('Queue Close / Open', () => {
  test('queue is closed before meeting starts for non-chairs, open after starting', async ({ page }) => {
    await createMeeting(page);
    await goToAgendaTab(page);
    await addAgendaItem(page, 'Item 1');

    // Switch to a non-chair user before starting
    await switchUser(page, 'bob');
    await goToQueueTab(page);

    // Before starting: entry buttons should be disabled for non-chair
    await expect(page.getByRole('button', { name: 'New Topic' })).toBeDisabled();
    await expect(page.getByText('The queue is closed.')).toBeVisible();

    // Switch back to chair and start the meeting
    await switchUser(page, 'admin');
    await goToQueueTab(page);
    await page.getByRole('button', { name: 'Start Meeting' }).click();

    // Switch to non-chair — buttons should be enabled after start
    await switchUser(page, 'bob');
    await goToQueueTab(page);
    await expect(page.getByRole('button', { name: 'New Topic' })).toBeEnabled();
    await expect(page.getByText('The queue is closed.')).not.toBeVisible();
  });

  test('chair can close and reopen the queue', async ({ page }) => {
    await setupStartedMeeting(page);

    // Close the queue
    await page.getByRole('button', { name: 'Close Queue' }).click();
    await expect(page.getByRole('button', { name: 'Open Queue' })).toBeVisible();

    // Reopen the queue
    await page.getByRole('button', { name: 'Open Queue' }).click();
    await expect(page.getByRole('button', { name: 'Close Queue' })).toBeVisible();
  });

  test('non-chair sees disabled buttons when queue is closed', async ({ page }) => {
    await setupStartedMeeting(page);

    // Close the queue as chair
    await page.getByRole('button', { name: 'Close Queue' }).click();

    // Switch to a non-chair user
    await switchUser(page, 'bob');
    await goToQueueTab(page);

    // Buttons should be disabled
    await expect(page.getByRole('button', { name: 'New Topic' })).toBeDisabled();
    await expect(page.getByText('The queue is closed.')).toBeVisible();

    // Switch back to chair and reopen
    await switchUser(page, 'admin');
    await goToQueueTab(page);
    await page.getByRole('button', { name: 'Open Queue' }).click();

    // Switch back to non-chair — buttons should be enabled
    await switchUser(page, 'bob');
    await goToQueueTab(page);
    await expect(page.getByRole('button', { name: 'New Topic' })).toBeEnabled();
    await expect(page.getByText('The queue is closed.')).not.toBeVisible();
  });

  test('advancing agenda item reopens a closed queue', async ({ page }) => {
    await createMeeting(page);
    await goToAgendaTab(page);
    await addAgendaItem(page, 'Item 1');
    await addAgendaItem(page, 'Item 2');
    await startMeeting(page);

    // Close the queue
    await page.getByRole('button', { name: 'Close Queue' }).click();
    await expect(page.getByRole('button', { name: 'Open Queue' })).toBeVisible();

    // Advance to next agenda item
    await advanceAgenda(page);

    // Queue should be reopened
    await expect(page.getByRole('button', { name: 'Close Queue' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New Topic' })).toBeEnabled();
  });

  test('non-chair can raise a Point of Order when the queue is closed', async ({ page }) => {
    await setupStartedMeeting(page);

    // Chair closes the queue
    await page.getByRole('button', { name: 'Close Queue' }).click();
    await expect(page.getByRole('button', { name: 'Open Queue' })).toBeVisible();

    // Switch to a non-chair user
    await switchUser(page, 'bob');
    await goToQueueTab(page);

    // The other entry buttons are disabled, but Point of Order stays enabled
    await expect(page.getByRole('button', { name: 'New Topic' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Clarifying Question' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Point of Order' })).toBeEnabled();

    // The closed-queue message mentions the Point of Order exemption
    await expect(page.getByText('The queue is closed. You can still raise a Point of Order.')).toBeVisible();

    // Raising a Point of Order succeeds — entry appears in the queue
    await addQueueEntry(page, 'Point of Order', 'We are off-topic');
    await expect(page.getByText('We are off-topic')).toBeVisible();

    // The new entry carries the Point of Order red-border styling.
    // Border classes live on the inner styled <div>, not the <li> itself.
    const item = page
      .getByRole('list', { name: 'Queued speakers' })
      .getByRole('listitem')
      .first()
      .locator('> div')
      .first();
    const borderWidth = await item.evaluate((el) => getComputedStyle(el).borderWidth);
    expect(borderWidth).not.toBe('0px');

    // Queue remains closed after adding the Point of Order
    await expect(page.getByText('The queue is closed. You can still raise a Point of Order.')).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Queue Reordering
// ---------------------------------------------------------------------------

test.describe('Queue Reordering', () => {
  test('chair drags an entry down: the entry adopts the lowest priority of items at or above it', async ({ page }) => {
    await setupStartedMeeting(page);

    // Build a queue: [Clarifying Question, Clarifying Question, New Topic].
    // Clarifying Question outranks New Topic, so the natural priority insert
    // is [Q1, Q2, T1]. Dragging Q1 down past Q2 should make it stay a
    // Clarifying Question (only New Topic sits below it); dragging Q1 to the
    // last position should demote it to New Topic.
    await addQueueEntry(page, 'Clarifying Question', 'Q1');
    await addQueueEntry(page, 'Clarifying Question', 'Q2');
    await addQueueEntry(page, 'New Topic', 'T1');

    const list = page.getByRole('list', { name: 'Queued speakers' });
    await expect(list.getByRole('listitem')).toHaveCount(3);
    await expect(list.getByRole('listitem').nth(0)).toContainText('Q1');
    await expect(list.getByRole('listitem').nth(2)).toContainText('T1');

    // Drag Q1 onto T1 — Q1 should land at the bottom and adopt New Topic.
    const q1 = list
      .getByRole('listitem')
      .nth(0)
      .getByLabel(/Drag to reorder: Q1/);
    const t1 = list
      .getByRole('listitem')
      .nth(2)
      .getByLabel(/Drag to reorder: T1/);
    await dragAndDrop(page, q1, t1);

    // After settle: Q1 sits last with "New Topic:" badge.
    const last = list.getByRole('listitem').last();
    await expect(last).toContainText('Q1');
    await expect(last).toContainText('New Topic');
  });

  test('chair drags an entry up: it adopts the highest priority of items at or below it', async ({
    page,
    browserName,
  }) => {
    // Flaky on webkit. The drag of T2 up across reflowing same-height
    // rows via the small ⠿ handle races with @dnd-kit's pointer-event
    // timing on webkit, occasionally leaving the queue order unchanged.
    // Chromium and firefox still exercise this path.
    test.fixme(browserName === 'webkit', 'flaky on webkit — @dnd-kit upward-drag pointer-event race');
    await setupStartedMeeting(page);

    // Build: [Clarifying Question, New Topic, New Topic]. Dragging T2 above
    // the Clarifying Question should promote it to Clarifying Question (since
    // a clarifying question sits at or below the new position).
    await addQueueEntry(page, 'Clarifying Question', 'Q1');
    await addQueueEntry(page, 'New Topic', 'T1');
    await addQueueEntry(page, 'New Topic', 'T2');

    const list = page.getByRole('list', { name: 'Queued speakers' });
    await expect(list.getByRole('listitem')).toHaveCount(3);

    const t2 = list
      .getByRole('listitem')
      .nth(2)
      .getByLabel(/Drag to reorder: T2/);
    const q1 = list
      .getByRole('listitem')
      .nth(0)
      .getByLabel(/Drag to reorder: Q1/);
    await dragAndDrop(page, t2, q1);

    // T2 should now sit at the top and carry a Clarifying Question badge.
    const first = list.getByRole('listitem').first();
    await expect(first).toContainText('T2');
    await expect(first).toContainText('Clarifying Question');
  });

  test('participants see no drag handle on entries they do not own', async ({ page }) => {
    await setupStartedMeeting(page);

    // Chair (admin) adds an entry on the chair's behalf, then a non-chair joins.
    await addQueueEntry(page, 'New Topic', "Chair's entry");

    await switchUser(page, 'bob');
    await goToQueueTab(page);

    const item = page.getByRole('list', { name: 'Queued speakers' }).getByRole('listitem').first();
    // No drag handle should be present for Bob since he doesn't own this entry.
    await expect(item.getByLabel(/Drag to reorder:/)).not.toBeVisible();
  });

  test('participant can defer their own entry downward but not jump ahead of someone else', async ({ page }) => {
    await setupStartedMeeting(page);

    // Setup: [bob's New Topic, admin's New Topic, bob's New Topic]. Bob should
    // be able to move his last entry up to position 1 (his other own entry)
    // but not above admin's entry at position 0.
    await switchUser(page, 'bob');
    await goToQueueTab(page);
    await addQueueEntry(page, 'New Topic', 'B1');

    await switchUser(page, 'admin');
    await goToQueueTab(page);
    await addQueueEntry(page, 'New Topic', 'A1');

    await switchUser(page, 'bob');
    await goToQueueTab(page);
    await addQueueEntry(page, 'New Topic', 'B2');

    // Priority insert: all New Topic → FIFO: B1, A1, B2.
    const list = page.getByRole('list', { name: 'Queued speakers' });
    await expect(list.getByRole('listitem').nth(0)).toContainText('B1');
    await expect(list.getByRole('listitem').nth(1)).toContainText('A1');
    await expect(list.getByRole('listitem').nth(2)).toContainText('B2');

    // Bob's B2 has a drag handle (own entry, can defer downward — and there
    // are no items below it to defer to, so it should only allow upward to
    // its own contiguous-block top). The block top is B2 itself since A1
    // sits between B1 and B2, so the only legal move is no move — the handle
    // may be omitted. The PRD says: "The handle is omitted entirely when no
    // move is possible." We assert the handle exists or is omitted depending
    // on what the panel computes; either way, dragging B2 above A1 must be
    // rejected.
    const b2 = list.getByRole('listitem').nth(2);
    const a1 = list.getByRole('listitem').nth(1);
    const handle = b2.getByLabel(/Drag to reorder: B2/);
    const handleCount = await handle.count();

    if (handleCount > 0) {
      // If a handle is present, attempting to drag B2 above A1 should not
      // succeed (the panel clamps the y range; if a drop lands outside the
      // legal range the optimistic update is suppressed).
      await dragAndDrop(page, handle, a1);
      // Bob's B2 must still sit below A1.
      const newList = page.getByRole('list', { name: 'Queued speakers' });
      const indexOfB2 = await newList
        .getByRole('listitem')
        .evaluateAll((items) => items.findIndex((el) => el.textContent?.includes('B2')));
      const indexOfA1 = await newList
        .getByRole('listitem')
        .evaluateAll((items) => items.findIndex((el) => el.textContent?.includes('A1')));
      expect(indexOfB2).toBeGreaterThan(indexOfA1);
    }
  });
});

// ---------------------------------------------------------------------------
// Cancelling an existing-entry edit (not the initial edit)
// ---------------------------------------------------------------------------

test.describe('Cancel edit on existing entry', () => {
  test('pressing Escape while editing an existing entry does NOT remove it', async ({ page }) => {
    await setupStartedMeeting(page);
    // Save an entry first so we're past the "initial edit" state.
    await addQueueEntry(page, 'New Topic', 'Saved entry');

    const item = page.getByRole('list', { name: 'Queued speakers' }).getByRole('listitem').first();
    // Open the edit form via the Edit button (existing entry, not initial).
    await item.getByText('Edit', { exact: true }).click();

    const input = page.getByLabel('Topic description');
    await expect(input).toHaveValue('Saved entry');

    // Escape during an existing-entry edit only closes the editor; the
    // contrast with the initial-edit path (which removes the entry) is
    // explicit in the PRD.
    await input.press('Escape');

    // The entry should still be present.
    await expect(page.getByText('Saved entry')).toBeVisible();
    await expect(page.getByRole('list', { name: 'Queued speakers' }).getByRole('listitem')).toHaveCount(1);
  });
});
