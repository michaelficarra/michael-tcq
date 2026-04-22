import { test, expect } from '@playwright/test';
import {
  createMeeting,
  goToAgendaTab,
  goToQueueTab,
  addAgendaItem,
  startMeeting,
  addQueueEntry,
  queueSection,
  switchUser,
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

    const item = page.getByRole('list', { name: 'Queued speakers' }).getByRole('listitem').first();
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

    const item = page.getByRole('list', { name: 'Queued speakers' }).getByRole('listitem').first();
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
    await page.getByRole('button', { name: 'Next Agenda Item' }).click();

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

    // The new entry carries the Point of Order red-border styling
    const item = page.getByRole('list', { name: 'Queued speakers' }).getByRole('listitem').first();
    const borderWidth = await item.evaluate((el) => getComputedStyle(el).borderWidth);
    expect(borderWidth).not.toBe('0px');

    // Queue remains closed after adding the Point of Order
    await expect(page.getByText('The queue is closed. You can still raise a Point of Order.')).toBeVisible();
  });
});

test.describe("I'm Done Speaking", () => {
  test('non-chair active speaker sees the "I\'m done speaking" button', async ({ page }) => {
    await setupStartedMeeting(page);

    // Switch to bob (non-chair), add a queue entry
    await switchUser(page, 'bob');
    await addQueueEntry(page, 'New Topic');

    // Switch back to admin (chair) and advance bob to speaker
    await switchUser(page, 'admin');
    await page.getByRole('button', { name: 'Next Speaker' }).click();

    // Switch to bob — should see "I'm done speaking"
    await switchUser(page, 'bob');
    await expect(page.getByRole('button', { name: /done speaking/i })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Next Speaker' })).not.toBeVisible();
  });

  test('clicking "I\'m done speaking" advances the queue', async ({ page }) => {
    await setupStartedMeeting(page);

    // Bob adds entry, admin advances bob to speaker
    await switchUser(page, 'bob');
    await addQueueEntry(page, 'New Topic', "Bob's topic");
    await switchUser(page, 'admin');
    await page.getByRole('button', { name: 'Next Speaker' }).click();
    await expect(queueSection(page, 'Speaking').getByText("Bob's topic")).toBeVisible();

    // Admin adds another entry while bob is speaking
    await addQueueEntry(page, 'New Topic', "Admin's topic");

    // Switch to bob, click "I'm done speaking"
    await switchUser(page, 'bob');
    await page.getByRole('button', { name: /done speaking/i }).click();

    // Admin's topic should now be the current speaker
    await expect(queueSection(page, 'Speaking').getByText("Admin's topic")).toBeVisible();
  });

  test('non-chair non-speaker does not see the button', async ({ page }) => {
    await setupStartedMeeting(page);

    // Admin adds a queue entry and advances to become the speaker
    await addQueueEntry(page, 'New Topic');
    await page.getByRole('button', { name: 'Next Speaker' }).click();

    // Switch to bob — should NOT see "I'm done speaking"
    await switchUser(page, 'bob');
    await expect(page.getByRole('button', { name: /done speaking/i })).not.toBeVisible();
  });

  test('chair does not see "I\'m done speaking" (sees "Next Speaker" instead)', async ({ page }) => {
    await setupStartedMeeting(page);

    // Admin adds a queue entry and advances to become the speaker
    await addQueueEntry(page, 'New Topic');
    await page.getByRole('button', { name: 'Next Speaker' }).click();

    // Admin (chair) should see "Next Speaker", not "I'm done speaking"
    await expect(page.getByRole('button', { name: 'Next Speaker' })).toBeVisible();
    await expect(page.getByRole('button', { name: /done speaking/i })).not.toBeVisible();
  });
});
