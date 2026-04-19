import { test, expect } from '@playwright/test';
import {
  createMeeting,
  goToAgendaTab,
  goToQueueTab,
  goToLogTab,
  addAgendaItem,
  startMeeting,
  addQueueEntry,
  queueSection,
} from './helpers.js';

test.describe('Log Tab', () => {
  test('shows empty state before meeting starts', async ({ page }) => {
    await createMeeting(page);
    await goToLogTab(page);
    const logPanel = page.getByRole('tabpanel', { name: 'Log' });
    await expect(logPanel).toBeVisible();
    await expect(logPanel.getByText('No events yet')).toBeVisible();
  });

  test('"Meeting started" entry appears when meeting starts', async ({ page }) => {
    await createMeeting(page);
    await goToAgendaTab(page);
    await addAgendaItem(page, 'First Item', 'admin');
    await startMeeting(page);

    await goToLogTab(page);
    const logPanel = page.getByRole('tabpanel', { name: 'Log' });
    await expect(logPanel).toBeVisible();
    await expect(logPanel.getByText('Meeting started')).toBeVisible();
  });

  test('"Started: Item Name" appears when an agenda item begins', async ({ page }) => {
    await createMeeting(page);
    await goToAgendaTab(page);
    await addAgendaItem(page, 'My Agenda Item', 'admin');
    await startMeeting(page);

    await goToLogTab(page);
    const logPanel = page.getByRole('tabpanel', { name: 'Log' });
    await expect(logPanel).toBeVisible();
    await expect(logPanel.getByText('Started:')).toBeVisible();
    await expect(logPanel.getByText('My Agenda Item').first()).toBeVisible();
  });

  test('entries are in reverse chronological order', async ({ page }) => {
    await createMeeting(page);
    await goToAgendaTab(page);
    await addAgendaItem(page, 'Alpha Item', 'admin');
    await addAgendaItem(page, 'Beta Item', 'admin');
    await startMeeting(page);

    // Advance to the second agenda item; wait for the scoped agenda region
    // (not just any occurrence of the text) to confirm state has propagated
    await page.getByRole('button', { name: 'Next Agenda Item' }).click();
    await expect(queueSection(page, 'Agenda Item')).toContainText('Beta Item');

    await goToLogTab(page);

    const logPanel = page.getByRole('tabpanel', { name: 'Log' });
    await expect(logPanel).toBeVisible();

    // Both "Started:" entries should be visible
    await expect(logPanel.getByText('Started:').first()).toBeVisible();

    // Verify order by checking the full text — most recent (Beta) should appear first
    const fullText = await logPanel.textContent();
    const betaIndex = fullText!.indexOf('Beta Item');
    const alphaIndex = fullText!.lastIndexOf('Alpha Item');
    expect(betaIndex).toBeLessThan(alphaIndex);
  });

  test('each entry shows a relative time with a full timestamp on hover', async ({ page }) => {
    await createMeeting(page);
    await goToAgendaTab(page);
    await addAgendaItem(page, 'Timed Item', 'admin');
    await startMeeting(page);

    await goToLogTab(page);

    // Find time elements — they show relative text and have a title with the full timestamp
    const logPanel = page.getByRole('tabpanel', { name: 'Log' });
    await expect(logPanel).toBeVisible();
    const timeElements = logPanel.locator('time');
    await expect(timeElements.first()).toBeVisible();

    // The relative time should be something like "just now" or "Xs ago"
    const relativeText = await timeElements.first().textContent();
    expect(relativeText).toBeTruthy();

    // The title attribute (shown on hover) should contain a full date string with a year
    const titleAttr = await timeElements.first().getAttribute('title');
    expect(titleAttr).toBeTruthy();
    expect(titleAttr).toMatch(/\d{4}/);
  });

  test('entries are grouped by agenda item with separators', async ({ page }) => {
    await createMeeting(page);
    await goToAgendaTab(page);
    await addAgendaItem(page, 'Group One', 'admin');
    await addAgendaItem(page, 'Group Two', 'admin');
    await startMeeting(page);

    // Advance to second item; scope the wait to the queue's agenda region
    await page.getByRole('button', { name: 'Next Agenda Item' }).click();
    await expect(queueSection(page, 'Agenda Item')).toContainText('Group Two');

    await goToLogTab(page);

    const logPanel = page.getByRole('tabpanel', { name: 'Log' });
    await expect(logPanel).toBeVisible();

    // Both agenda items should appear in the log panel
    await expect(logPanel.getByText('Group One', { exact: true }).first()).toBeVisible();
    await expect(logPanel.getByText('Group Two', { exact: true }).first()).toBeVisible();
  });

  test('"topic discussed" entries appear when advancing past a speaker with a new topic', async ({ page }) => {
    await createMeeting(page);
    await goToAgendaTab(page);
    await addAgendaItem(page, 'Discussion Item', 'admin');
    await startMeeting(page);

    // Add a new topic entry and advance past it
    await addQueueEntry(page, 'New Topic', 'My important topic');
    // Wait for the entry to appear in the queue
    await expect(page.getByText('My important topic')).toBeVisible();

    // Advance to make this speaker the current speaker
    await page.getByRole('button', { name: 'Next Speaker' }).click();
    await expect(queueSection(page, 'Speaking')).toContainText('My important topic');

    // Advance past this speaker to finalise the topic
    await page.getByRole('button', { name: 'Next Speaker' }).click();
    await expect(page.getByText('Nobody speaking yet')).toBeVisible();

    await goToLogTab(page);

    // The topic should appear in the log
    const logPanel = page.getByRole('tabpanel', { name: 'Log' });
    await expect(logPanel).toBeVisible();
    await expect(logPanel.getByText('My important topic')).toBeVisible();
  });

  test('Export button is hidden when log is empty', async ({ page }) => {
    await createMeeting(page);
    await goToLogTab(page);
    await expect(page.getByRole('button', { name: 'Export' })).not.toBeVisible();
  });

  test('Export button triggers a download with meeting content', async ({ page }) => {
    await createMeeting(page);
    await goToAgendaTab(page);
    await addAgendaItem(page, 'Export Test Item', 'admin');
    await startMeeting(page);

    // Add a topic and advance past it to get a topic-discussed entry
    await addQueueEntry(page, 'New Topic', 'Exported topic');
    await expect(page.getByText('Exported topic')).toBeVisible();
    await page.getByRole('button', { name: 'Next Speaker' }).click();
    await expect(queueSection(page, 'Speaking')).toContainText('Exported topic');
    await page.getByRole('button', { name: 'Next Speaker' }).click();
    await expect(page.getByText('Nobody speaking yet')).toBeVisible();

    await goToLogTab(page);
    await expect(page.getByRole('button', { name: 'Export' })).toBeVisible();

    // Listen for the download
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export' }).click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toMatch(/-\d+\.md$/);

    // Read the downloaded file and verify content
    const content = await (await download.createReadStream())
      .toArray()
      .then((chunks) => Buffer.concat(chunks).toString('utf-8'));
    expect(content).toContain('Meeting Log');
    expect(content).toContain('Export Test Item');
    expect(content).toContain('Exported topic');
    expect(content).toContain('Participants');
    expect(content).toContain('@admin');
  });

  test('log updates in real time as events occur', async ({ page }) => {
    await createMeeting(page);
    await goToAgendaTab(page);
    await addAgendaItem(page, 'Real-Time Item', 'admin');
    await addAgendaItem(page, 'Second RT Item', 'admin');

    // Start the meeting and switch to the log tab immediately
    await startMeeting(page);
    await goToLogTab(page);

    // Scope to the Log tabpanel; the Agenda and Queue panels are always
    // rendered (with `hidden`) and also contain the agenda item names.
    const logPanel = page.getByRole('tabpanel', { name: 'Log' });
    await expect(logPanel).toBeVisible();

    // Should already see the meeting started and first agenda item
    await expect(logPanel.getByText('Meeting started')).toBeVisible();
    await expect(logPanel.getByText('Real-Time Item', { exact: true })).toBeVisible();

    // Now advance to next item while staying on the log tab
    // Need to go to queue tab to click the button, then back to log
    await goToQueueTab(page);
    await page.getByRole('button', { name: 'Next Agenda Item' }).click();
    // Wait for the state broadcast to be applied — current agenda item updates to the new one
    await expect(queueSection(page, 'Agenda Item')).toContainText('Second RT Item');

    await goToLogTab(page);
    await expect(logPanel).toBeVisible();
    await expect(logPanel.getByText('Second RT Item', { exact: true })).toBeVisible();
  });
});
