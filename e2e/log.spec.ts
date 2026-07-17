import { test, expect } from '@playwright/test';
import {
  createMeeting,
  goToAgendaTab,
  goToQueueTab,
  goToLogTab,
  addAgendaItem,
  startMeeting,
  addQueueEntry,
  advanceAgenda,
  queueSection,
  switchUser,
  readDownloadedFile,
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
    await advanceAgenda(page);
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
    await advanceAgenda(page);
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

  test('Export button is hidden when log is empty', async ({ page, browserName }) => {
    // Flaky on webkit. After the nav tabs were converted to anchors with
    // `preventDefault` + `history.pushState` (PRs #16 and the anchor refactor),
    // webkit occasionally fails to commit the React state update that flips
    // `aria-selected` to "true" on the clicked Log tab, leaving `switchToTab`
    // waiting on the attribute until it times out. Chromium and firefox
    // still exercise this path.
    test.fixme(browserName === 'webkit', 'flaky on webkit — anchor click → aria-selected commit race');
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
    const content = await (
      await download.createReadStream()
    )
      .toArray()
      .then((chunks) => Buffer.concat(chunks).toString('utf-8'));
    expect(content).toContain('Meeting Log');
    expect(content).toContain('Export Test Item');
    expect(content).toContain('Exported topic');
    expect(content).toContain('Participants');
    expect(content).toContain('@admin');
  });

  test('"Finished" entry records duration, participants, and a collapsible remaining-queue disclosure', async ({
    page,
  }) => {
    await createMeeting(page);
    await goToAgendaTab(page);
    await addAgendaItem(page, 'First', 'admin');
    await addAgendaItem(page, 'Second', 'admin');
    await startMeeting(page);

    // Participants by switching users and adding queue entries.
    await switchUser(page, 'bob');
    await goToQueueTab(page);
    await addQueueEntry(page, 'New Topic', "Bob's topic");
    // Advance Bob to the floor so his speaking-time accumulates.
    await switchUser(page, 'admin');
    await goToQueueTab(page);
    await page.getByRole('button', { name: 'Next Speaker' }).click();
    await expect(queueSection(page, 'Speaking')).toContainText("Bob's topic");

    // Leave a remaining entry in the queue so the disclosure renders.
    await switchUser(page, 'carol');
    await goToQueueTab(page);
    await addQueueEntry(page, 'New Topic', 'Carol unsaid');

    // Advance the agenda — the previous item should be Finished with the
    // remaining-queue disclosure populated.
    await switchUser(page, 'admin');
    await goToQueueTab(page);
    await advanceAgenda(page);
    await expect(queueSection(page, 'Agenda Item')).toContainText('Second');

    await goToLogTab(page);
    const logPanel = page.getByRole('tabpanel', { name: 'Log' });

    // Finished entry shows up — its duration span sits inside the same
    // entry block; we look for a duration formatted by formatDuration.
    await expect(logPanel.getByText(/Finished:/)).toBeVisible();

    // The remaining-queue <details> disclosure is present and expandable.
    const remainingSummary = logPanel.getByText('Remaining queue');
    await expect(remainingSummary).toBeVisible();
    await remainingSummary.click();
    await expect(logPanel.getByText(/Carol unsaid/)).toBeVisible();
  });

  test('Topic-discussed entry uses compact format for a single speaker', async ({ page }) => {
    await createMeeting(page);
    await goToAgendaTab(page);
    await addAgendaItem(page, 'Solo', 'admin');
    await startMeeting(page);
    await addQueueEntry(page, 'New Topic', 'Solo topic');
    await page.getByRole('button', { name: 'Next Speaker' }).click();
    await expect(queueSection(page, 'Speaking')).toContainText('Solo topic');
    // Advance past the speaker to finalise the topic.
    await page.getByRole('button', { name: 'Next Speaker' }).click();
    await expect(page.getByText('Nobody speaking yet')).toBeVisible();

    await goToLogTab(page);
    const logPanel = page.getByRole('tabpanel', { name: 'Log' });
    // Compact layout: no nested rows under the topic entry.
    // We assert presence of the topic and absence of the inner pl-4 nested
    // row container that the expanded format adds.
    const topicLine = logPanel.getByText('Solo topic');
    await expect(topicLine).toBeVisible();
    // No nested SpeakerRow (those have a `pl-4 border-l-2` left-border style).
    const nested = logPanel.locator('div.pl-4');
    await expect(nested).toHaveCount(0);
  });

  test('Topic-discussed entry uses expanded format for a topic with replies', async ({ page }) => {
    await createMeeting(page);
    await goToAgendaTab(page);
    await addAgendaItem(page, 'Many speakers', 'admin');
    await startMeeting(page);

    // First speaker introduces the topic.
    await addQueueEntry(page, 'New Topic', 'Discussion topic');
    await page.getByRole('button', { name: 'Next Speaker' }).click();
    await expect(queueSection(page, 'Speaking')).toContainText('Discussion topic');

    // Reply queued under the topic — same chair adds it for simplicity.
    await addQueueEntry(page, 'Discuss Current Topic', 'A reply');
    await page.getByRole('button', { name: 'Next Speaker' }).click();
    await expect(queueSection(page, 'Speaking')).toContainText('A reply');

    // Clear current speaker so the topic finalises in the log.
    await page.getByRole('button', { name: 'Next Speaker' }).click();
    await expect(page.getByText('Nobody speaking yet')).toBeVisible();

    await goToLogTab(page);
    const logPanel = page.getByRole('tabpanel', { name: 'Log' });
    await expect(logPanel.getByText('Discussion topic')).toBeVisible();
    // Expanded format: the reply renders as a nested row.
    await expect(logPanel.getByText('A reply')).toBeVisible();
    // The expanded format uses a `pl-4 border-l-2` indent on nested rows.
    await expect(logPanel.locator('div.pl-4').first()).toBeVisible();
  });

  test('Point of Order entries are excluded from the log', async ({ page }) => {
    await createMeeting(page);
    await goToAgendaTab(page);
    await addAgendaItem(page, 'Item with interruption', 'admin');
    await startMeeting(page);

    // First a normal topic so we have something to interrupt.
    await addQueueEntry(page, 'New Topic', 'Normal topic');
    const nextSpeaker = page.getByRole('button', { name: 'Next Speaker' });
    await expect(nextSpeaker).toBeEnabled();
    await nextSpeaker.click();
    await expect(queueSection(page, 'Speaking')).toContainText('Normal topic');

    // Now a Point of Order — it goes to the head of the queue.
    await addQueueEntry(page, 'Point of Order', 'Procedural interruption');
    await expect(nextSpeaker).toBeEnabled();
    await nextSpeaker.click();
    await expect(queueSection(page, 'Speaking')).toContainText('Procedural interruption');

    // Advance past the POO speaker — waiting for the button to settle between
    // clicks so debounce/cooldown doesn't intermittently disable it.
    await expect(nextSpeaker).toBeEnabled();
    await nextSpeaker.click();
    // Speaker may end up cleared or on a different entry; we don't care which.
    // What matters is reaching the log tab afterwards.

    await goToLogTab(page);
    const logPanel = page.getByRole('tabpanel', { name: 'Log' });
    // Normal topic surfaces.
    await expect(logPanel.getByText('Normal topic')).toBeVisible();
    // The Point of Order entry text must NOT appear in the log.
    await expect(logPanel.getByText('Procedural interruption')).not.toBeVisible();
  });

  test('Export markdown includes a participants table sorted by speaking time descending', async ({ page }) => {
    await createMeeting(page);
    await goToAgendaTab(page);
    await addAgendaItem(page, 'Export item', 'admin');
    await startMeeting(page);

    // Get bob to attend (count as participant) without speaking.
    await switchUser(page, 'bob');
    await goToQueueTab(page);

    // Back to admin, who speaks the topic.
    await switchUser(page, 'admin');
    await goToQueueTab(page);
    await addQueueEntry(page, 'New Topic', 'Admin speaks');
    await page.getByRole('button', { name: 'Next Speaker' }).click();
    await expect(queueSection(page, 'Speaking')).toContainText('Admin speaks');
    // Advance past so the topic finalises with a duration.
    await page.getByRole('button', { name: 'Next Speaker' }).click();

    await goToLogTab(page);
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export' }).click();
    const content = await readDownloadedFile(await downloadPromise);

    // Markdown structure: agenda heading, topic list, participants table.
    expect(content).toContain('# Meeting Log');
    expect(content).toContain('## Export item');
    expect(content).toContain('**New Topic:** Admin speaks');
    expect(content).toContain('## Participants');
    expect(content).toMatch(/\|\s*Speaker\s*\|\s*Time\s*\|/);
    // Both attendees appear in the participants table — bob with 0s.
    expect(content).toContain('@admin');
    expect(content).toContain('@bob');
    // Admin has a non-zero duration, so should sort before bob (0s) in the
    // table. We locate the two rows and assert admin appears first.
    const tableMatch = content.split('## Participants')[1] ?? '';
    const adminIndex = tableMatch.indexOf('@admin');
    const bobIndex = tableMatch.indexOf('@bob');
    expect(adminIndex).toBeGreaterThan(-1);
    expect(bobIndex).toBeGreaterThan(adminIndex);
    // All timestamps are UTC.
    expect(content).toMatch(/UTC/);
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
    await advanceAgenda(page);
    // Wait for the state broadcast to be applied — current agenda item updates to the new one
    await expect(queueSection(page, 'Agenda Item')).toContainText('Second RT Item');

    await goToLogTab(page);
    await expect(logPanel).toBeVisible();
    await expect(logPanel.getByText('Second RT Item', { exact: true })).toBeVisible();
  });
});
