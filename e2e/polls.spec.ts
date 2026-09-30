import { test, expect } from '@playwright/test';
import {
  createMeeting,
  goToAgendaTab,
  goToQueueTab,
  goToLogTab,
  addAgendaItem,
  startMeeting,
  openSecondContext,
  addQueueEntry,
} from './helpers.js';

import { installClipboardMock, getClipboard } from './mocks.js';

/** Set up a started meeting with one agenda item. */
async function setupStartedMeeting(page: import('@playwright/test').Page) {
  await createMeeting(page);
  await goToAgendaTab(page);
  await addAgendaItem(page, 'Item 1');
  await startMeeting(page);
}

test.describe('Poll Configuration', () => {
  test.beforeEach(async ({ page }) => {
    await setupStartedMeeting(page);
  });

  test('"Create Poll" button appears for chairs when there is a current agenda item and no active poll', async ({
    page,
  }) => {
    await expect(page.getByRole('button', { name: 'Create Poll' })).toBeVisible();
  });

  test('clicking "Create Poll" opens a setup form modal', async ({ page }) => {
    await page.getByRole('button', { name: 'Create Poll' }).click();

    const dialog = page.getByRole('dialog', { name: 'Create poll' });
    await expect(dialog).toBeVisible();

    // Optional topic input
    await expect(dialog.getByLabel('Poll topic')).toBeVisible();

    // "Allow selecting multiple options" checkbox, checked by default
    const multiSelectCheckbox = dialog.getByLabel('Allow selecting multiple options');
    await expect(multiSelectCheckbox).toBeVisible();
    await expect(multiSelectCheckbox).toBeChecked();

    // Start Poll (footer, rightmost) and the ✕ close in the header
    await expect(dialog.getByRole('button', { name: 'Start Poll' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Close' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
  });

  test('the setup form shows the 6 default options with emoji and label', async ({ page }) => {
    await page.getByRole('button', { name: 'Create Poll' }).click();

    const dialog = page.getByRole('dialog', { name: 'Create poll' });

    // Each default option should have its label visible
    const expectedLabels = ['Strong Positive', 'Positive', 'Following', 'Confused', 'Indifferent', 'Unconvinced'];

    const labelInputs = dialog.getByLabel('Option label');
    await expect(labelInputs).toHaveCount(6);

    for (let i = 0; i < expectedLabels.length; i++) {
      await expect(labelInputs.nth(i)).toHaveValue(expectedLabels[i]);
    }

    // Each option also has a "Choose emoji" button
    const emojiButtons = dialog.getByLabel('Choose emoji');
    await expect(emojiButtons).toHaveCount(6);
  });

  test('chairs can remove options but minimum 2 are required', async ({ page }) => {
    await page.getByRole('button', { name: 'Create Poll' }).click();

    const dialog = page.getByRole('dialog', { name: 'Create poll' });
    const removeButtons = dialog.getByLabel('Remove option');

    // Start with 6 options — all remove buttons should be enabled
    await expect(removeButtons).toHaveCount(6);

    // Remove options until we reach 2
    await removeButtons.first().click();
    await expect(dialog.getByLabel('Option label')).toHaveCount(5);

    await removeButtons.first().click();
    await expect(dialog.getByLabel('Option label')).toHaveCount(4);

    await removeButtons.first().click();
    await expect(dialog.getByLabel('Option label')).toHaveCount(3);

    await removeButtons.first().click();
    await expect(dialog.getByLabel('Option label')).toHaveCount(2);

    // At 2 options, remove buttons should be disabled
    for (const btn of await removeButtons.all()) {
      await expect(btn).toBeDisabled();
    }
  });

  test('the ✕ close button dismisses the setup form without starting a poll', async ({ page }) => {
    await page.getByRole('button', { name: 'Create Poll' }).click();

    const dialog = page.getByRole('dialog', { name: 'Create poll' });
    await expect(dialog).toBeVisible();

    await dialog.getByRole('button', { name: 'Close' }).click();

    await expect(dialog).not.toBeVisible();
    // No active poll modal should appear
    await expect(page.getByRole('dialog', { name: 'Active poll' })).not.toBeVisible();
  });

  test('"Start Poll" begins the poll', async ({ page }) => {
    await page.getByRole('button', { name: 'Create Poll' }).click();

    const setupDialog = page.getByRole('dialog', { name: 'Create poll' });
    await setupDialog.getByRole('button', { name: 'Start Poll' }).click();

    // The setup dialog should close
    await expect(setupDialog).not.toBeVisible();

    // The active poll dialog should appear
    await expect(page.getByRole('dialog', { name: 'Active poll' })).toBeVisible();
  });

  test('the active poll modal is non-dismissable (Esc and outside-click do nothing)', async ({ page }) => {
    await page.getByRole('button', { name: 'Create Poll' }).click();
    const setupDialog = page.getByRole('dialog', { name: 'Create poll' });
    await setupDialog.getByRole('button', { name: 'Start Poll' }).click();

    const activePoll = page.getByRole('dialog', { name: 'Active poll' });
    await expect(activePoll).toBeVisible();

    // Unlike the other modals, this one closes only when the server clears the
    // poll — close requests are refused and there is no light dismiss.
    await page.keyboard.press('Escape');
    await expect(activePoll).toBeVisible();
    await page.mouse.click(8, 300);
    await expect(activePoll).toBeVisible();
  });
});

test.describe('Reactions', () => {
  test.beforeEach(async ({ page }) => {
    await setupStartedMeeting(page);

    // Start a poll with defaults
    await page.getByRole('button', { name: 'Create Poll' }).click();
    const setupDialog = page.getByRole('dialog', { name: 'Create poll' });
    await setupDialog.getByRole('button', { name: 'Start Poll' }).click();
    await expect(page.getByRole('dialog', { name: 'Active poll' })).toBeVisible();
  });

  test('active poll modal shows reaction buttons with emoji, label, and count', async ({ page }) => {
    const dialog = page.getByRole('dialog', { name: 'Active poll' });
    const reactionsGroup = dialog.getByRole('group', {
      name: 'Poll reactions',
    });

    // All 6 default options should be present as buttons
    const expectedLabels = ['Strong Positive', 'Positive', 'Following', 'Confused', 'Indifferent', 'Unconvinced'];

    for (const label of expectedLabels) {
      // Each button has aria-label "Label: count"
      const button = reactionsGroup.getByRole('button', {
        name: new RegExp(`^${label}: \\d+$`),
      });
      await expect(button).toBeVisible();
    }
  });

  test('clicking a reaction button toggles the selection and updates the count', async ({ page }) => {
    const dialog = page.getByRole('dialog', { name: 'Active poll' });

    // Click "Strong Positive" — count should go from 0 to 1
    const button = dialog.getByRole('button', { name: /^Strong Positive:/ });
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    await expect(button).toHaveAccessibleName('Strong Positive: 0');

    await button.click();

    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await expect(button).toHaveAccessibleName('Strong Positive: 1');

    // Click again — count should go back to 0
    await button.click();

    await expect(button).toHaveAttribute('aria-pressed', 'false');
    await expect(button).toHaveAccessibleName('Strong Positive: 0');
  });

  test('user can select multiple reactions when multi-select is enabled', async ({ page }) => {
    const dialog = page.getByRole('dialog', { name: 'Active poll' });

    const positiveBtn = dialog.getByRole('button', { name: /^Positive:/ });
    const followingBtn = dialog.getByRole('button', { name: /^Following:/ });

    await positiveBtn.click();
    await followingBtn.click();

    // Both should be selected
    await expect(positiveBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(followingBtn).toHaveAttribute('aria-pressed', 'true');
  });
});

test.describe('Termination', () => {
  test.beforeEach(async ({ page }) => {
    await setupStartedMeeting(page);

    // Start a poll
    await page.getByRole('button', { name: 'Create Poll' }).click();
    const setupDialog = page.getByRole('dialog', { name: 'Create poll' });
    await setupDialog.getByRole('button', { name: 'Start Poll' }).click();
    await expect(page.getByRole('dialog', { name: 'Active poll' })).toBeVisible();
  });

  test('"Stop Poll" button is visible for chairs during an active poll', async ({ page }) => {
    const dialog = page.getByRole('dialog', { name: 'Active poll' });
    await expect(dialog.getByRole('button', { name: 'Stop Poll' })).toBeVisible();
  });

  test('"Copy Results" button is visible for chairs during an active poll', async ({ page }) => {
    const dialog = page.getByRole('dialog', { name: 'Active poll' });
    await expect(dialog.getByRole('button', { name: 'Copy Results' })).toBeVisible();
  });

  test('clicking "Stop Poll" closes the active poll modal', async ({ page }) => {
    const dialog = page.getByRole('dialog', { name: 'Active poll' });
    await dialog.getByRole('button', { name: 'Stop Poll' }).click();

    await expect(dialog).not.toBeVisible();

    // "Create Poll" button should reappear since there is no active poll
    await expect(page.getByRole('button', { name: 'Create Poll' })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Poll configuration — option editing and single-select mode
// ---------------------------------------------------------------------------

test.describe('Poll setup option editing', () => {
  test.beforeEach(async ({ page }) => {
    await setupStartedMeeting(page);
  });

  test('chairs can add a new option and edit its label', async ({ page }) => {
    await page.getByRole('button', { name: 'Create Poll' }).click();
    const dialog = page.getByRole('dialog', { name: 'Create poll' });

    await expect(dialog.getByLabel('Option label')).toHaveCount(6);

    // Add an option — a 7th input appears with an empty label.
    await dialog.getByRole('button', { name: /Add Option/i }).click();
    await expect(dialog.getByLabel('Option label')).toHaveCount(7);

    // Fill the new option's label.
    const newOption = dialog.getByLabel('Option label').nth(6);
    await newOption.fill('Custom label');
    await expect(newOption).toHaveValue('Custom label');

    // Edit an existing label.
    const first = dialog.getByLabel('Option label').first();
    await first.fill('Edited label');
    await expect(first).toHaveValue('Edited label');
  });

  test('single-select mode replaces previous selection on a new click', async ({ page }) => {
    await page.getByRole('button', { name: 'Create Poll' }).click();
    const setup = page.getByRole('dialog', { name: 'Create poll' });

    // Uncheck "Allow selecting multiple options" → single-select mode.
    const multi = setup.getByLabel('Allow selecting multiple options');
    await expect(multi).toBeChecked();
    await multi.uncheck();

    await setup.getByRole('button', { name: 'Start Poll' }).click();
    const active = page.getByRole('dialog', { name: 'Active poll' });
    await expect(active).toBeVisible();

    const positive = active.getByRole('button', { name: /^Positive:/ });
    const following = active.getByRole('button', { name: /^Following:/ });

    await positive.click();
    await expect(positive).toHaveAttribute('aria-pressed', 'true');

    // Selecting Following should auto-deselect Positive in single-select mode.
    await following.click();
    await expect(following).toHaveAttribute('aria-pressed', 'true');
    await expect(positive).toHaveAttribute('aria-pressed', 'false');
  });
});

// ---------------------------------------------------------------------------
// Reactions — hover tooltip exposes reactor names
// ---------------------------------------------------------------------------

test.describe('Reaction tooltips', () => {
  test('reaction button title carries the reactor name once selected', async ({ page }) => {
    await setupStartedMeeting(page);

    await page.getByRole('button', { name: 'Create Poll' }).click();
    await page.getByRole('dialog', { name: 'Create poll' }).getByRole('button', { name: 'Start Poll' }).click();
    const active = page.getByRole('dialog', { name: 'Active poll' });
    await expect(active).toBeVisible();

    const button = active.getByRole('button', { name: /^Strong Positive:/ });
    // Before any reactions the title falls back to the label.
    await expect(button).toHaveAttribute('title', /Strong Positive/i);

    await button.click();
    // After reacting, the title should now mention the reactor (the default
    // mock user is "admin" / display name "Admin"). The exact format is up
    // to the component — we only assert the reactor's identity surfaces.
    await expect(button).toHaveAttribute('title', /admin/i);
  });
});

// ---------------------------------------------------------------------------
// Copy Results — clipboard contents sorted by count descending
// ---------------------------------------------------------------------------

test.describe('Copy Results', () => {
  test('Copy Results writes a summary to the clipboard sorted by count descending', async ({ page }) => {
    await installClipboardMock(page);
    await setupStartedMeeting(page);

    await page.getByRole('button', { name: 'Create Poll' }).click();
    await page.getByRole('dialog', { name: 'Create poll' }).getByRole('button', { name: 'Start Poll' }).click();
    const active = page.getByRole('dialog', { name: 'Active poll' });
    await expect(active).toBeVisible();

    // React to two distinct options so the sort has work to do. With one
    // viewer we can only produce counts of 0 or 1, but the sort criterion
    // ("sort by count descending") still distinguishes reacted vs unreacted.
    const positive = active.getByRole('button', { name: /^Positive:/ });
    await positive.click();
    // Wait for the server round-trip to apply before copying — Copy Results
    // builds its summary synchronously from the client's current
    // poll.reactions, so without this wait the clipboard can land an
    // all-zero snapshot. The title gaining the reactor's name is the same
    // settle signal used by the "Reaction tooltips" test above.
    await expect(positive).toHaveAttribute('title', /admin/i);

    await active.getByRole('button', { name: 'Copy Results' }).click();

    // The copy is confirmed with a brief, self-dismissing "Copied" tooltip.
    await expect(page.getByText('Copied')).toBeVisible();

    const writes = await getClipboard(page);
    expect(writes.length).toBeGreaterThan(0);
    const summary = writes.at(-1)!;
    // The first non-zero line should be the reacted option.
    const firstLine = summary.split('\n').find((l) => /\b1\b/.test(l));
    expect(firstLine).toMatch(/Positive/);

    // …and the confirmation clears itself without any dismissal action.
    await expect(page.getByText('Copied')).toBeHidden();
  });
});

// ---------------------------------------------------------------------------
// Log — "Ran a poll" entry surfaces after Stop Poll
// ---------------------------------------------------------------------------

test.describe('Poll log entry', () => {
  test('stopping a poll records a "Ran a poll" entry in the meeting log', async ({ page }) => {
    await setupStartedMeeting(page);

    await page.getByRole('button', { name: 'Create Poll' }).click();
    const setup = page.getByRole('dialog', { name: 'Create poll' });
    await setup.getByLabel('Poll topic').fill('Approve this proposal?');
    await setup.getByRole('button', { name: 'Start Poll' }).click();

    const active = page.getByRole('dialog', { name: 'Active poll' });
    await expect(active).toBeVisible();

    // Cast one reaction so the log records a non-zero voter count.
    await active.getByRole('button', { name: /^Strong Positive:/ }).click();

    await active.getByRole('button', { name: 'Stop Poll' }).click();
    await expect(active).not.toBeVisible();

    await goToLogTab(page);
    const logPanel = page.getByRole('tabpanel', { name: 'Log' });

    // The log includes a poll-ran entry with the topic, voter count, and
    // results summary.
    await expect(logPanel.getByText(/Ran a poll: Approve this proposal\?/)).toBeVisible();
    await expect(logPanel.getByText(/1 voter/)).toBeVisible();
    await expect(logPanel.getByText(/Strong Positive:\s*1/)).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Poll requests — participants propose, chairs approve or dismiss
// ---------------------------------------------------------------------------

test.describe('Poll requests', () => {
  /** Meeting id of the page's current meeting. */
  function meetingIdOf(page: import('@playwright/test').Page): string {
    return decodeURIComponent(new URL(page.url()).pathname.split('/meeting/')[1]);
  }

  /**
   * Wait out the Queue tab's interaction lock. A request arriving (or
   * changing) locks the whole tab for a brief cooldown, and clicks during
   * it are swallowed by design.
   */
  async function waitForUnlock(page: import('@playwright/test').Page) {
    await expect(page.getByRole('tabpanel', { name: 'Queue' })).not.toHaveAttribute('data-interaction-locked', {
      timeout: 5000,
    });
  }

  /** As a participant, open the request form, set a topic, and submit. */
  async function requestPollAs(page: import('@playwright/test').Page, topic: string) {
    await page.getByRole('button', { name: 'Request Poll' }).click();
    const dialog = page.getByRole('dialog', { name: 'Request poll' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Poll topic').fill(topic);
    await dialog.getByRole('button', { name: 'Request Poll' }).click();
    await expect(dialog).not.toBeVisible();
  }

  test('participants see "Request Poll" instead of "Create Poll"; chairs see the reverse', async ({
    browser,
    page,
  }) => {
    await setupStartedMeeting(page);
    await expect(page.getByRole('button', { name: 'Create Poll' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Request Poll' })).toHaveCount(0);

    const second = await openSecondContext(browser, meetingIdOf(page), { asUser: 'bob' });
    try {
      await goToQueueTab(second.page);
      await expect(second.page.getByRole('button', { name: 'Request Poll' })).toBeVisible();
      await expect(second.page.getByRole('button', { name: 'Create Poll' })).toHaveCount(0);
    } finally {
      await second.context.close();
    }
  });

  test('a participant requests a poll, the chair approves it, and the poll opens for both', async ({
    browser,
    page,
  }) => {
    await setupStartedMeeting(page);
    const second = await openSecondContext(browser, meetingIdOf(page), { asUser: 'bob' });
    try {
      await goToQueueTab(second.page);
      await requestPollAs(second.page, 'Temp check: ship it?');

      // Requester sees their own pending request with a Withdraw button…
      const participantList = second.page.getByRole('region', { name: 'Poll Requests' });
      await expect(participantList).toBeVisible();
      await expect(participantList.getByText('Temp check: ship it?')).toBeVisible();
      // The compact row is a clickable summary (title says it can be edited) …
      await expect(participantList.getByRole('button', { name: /Temp check: ship it\?/ })).toHaveAttribute(
        'title',
        /edit/i,
      );
      await expect(participantList.getByRole('button', { name: 'Withdraw' })).toBeVisible();
      // …and no poll has started yet.
      await expect(second.page.getByRole('dialog', { name: 'Active poll' })).not.toBeVisible();

      // Chair sees the request summary with the requester's name. Clicking
      // it opens the review dialog: the full proposal in the editable
      // setup form, with Approve.
      const chairList = page.getByRole('region', { name: 'Poll Requests' });
      await expect(chairList).toBeVisible();
      await expect(chairList.getByText('Temp check: ship it?')).toBeVisible();
      await expect(chairList.getByText(/bob/i).first()).toBeVisible();
      // No blind inline approve — approval happens after reviewing.
      await expect(chairList.getByRole('button', { name: 'Approve' })).toHaveCount(0);
      await waitForUnlock(page);
      await chairList.getByRole('button', { name: /Temp check: ship it\?/ }).click();

      const review = page.getByRole('dialog', { name: 'Review poll request' });
      await expect(review).toBeVisible();
      await expect(review.getByLabel('Poll topic')).toHaveValue('Temp check: ship it?');
      await expect(review.getByLabel('Option label')).toHaveCount(6);
      await expect(review.getByText(/bob/i).first()).toBeVisible();
      // Footer order: destructive on the left, the primary "continue" action
      // furthest right; Cancel is the ✕ in the header, not a footer button.
      const footerButtons = review.locator('form > div:last-of-type button');
      await expect(footerButtons.first()).toHaveText('Dismiss request');
      await expect(footerButtons.last()).toHaveText('Approve & Start Poll');
      await expect(review.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
      await expect(review.getByRole('button', { name: 'Close' })).toBeVisible();
      // The chair may edit before approving.
      await review.getByLabel('Poll topic').fill('Temp check: ship it? (chair-edited)');
      await review.getByRole('button', { name: 'Approve & Start Poll' }).click();
      await expect(review).not.toBeVisible();

      // The poll opens for everyone with the requested topic, and the
      // request disappears from both views.
      const chairPoll = page.getByRole('dialog', { name: 'Active poll' });
      await expect(chairPoll).toBeVisible();
      await expect(chairPoll.getByText('Temp check: ship it? (chair-edited)')).toBeVisible();
      await expect(second.page.getByRole('dialog', { name: 'Active poll' })).toBeVisible();
      await expect(page.getByRole('region', { name: 'Poll Requests' })).toHaveCount(0);
      await expect(second.page.getByRole('region', { name: 'Poll Requests' })).toHaveCount(0);

      // Stopping it logs the poll with the requester attribution.
      await chairPoll.getByRole('button', { name: 'Stop Poll' }).click();
      await expect(chairPoll).not.toBeVisible();
      await goToLogTab(page);
      const logPanel = page.getByRole('tabpanel', { name: 'Log' });
      await expect(logPanel.getByText(/Ran a poll: Temp check: ship it\? \(chair-edited\)/)).toBeVisible();
      await expect(logPanel.getByText('requested by')).toBeVisible();
    } finally {
      await second.context.close();
    }
  });

  test('the chair can dismiss a request without starting a poll', async ({ browser, page }) => {
    await setupStartedMeeting(page);
    const second = await openSecondContext(browser, meetingIdOf(page), { asUser: 'bob' });
    try {
      await goToQueueTab(second.page);
      await requestPollAs(second.page, 'Please dismiss me');

      const chairList = page.getByRole('region', { name: 'Poll Requests' });
      await expect(chairList.getByText('Please dismiss me')).toBeVisible();
      await waitForUnlock(page);
      await chairList.getByRole('button', { name: 'Dismiss', exact: true }).click();

      await expect(page.getByRole('region', { name: 'Poll Requests' })).toHaveCount(0);
      await expect(second.page.getByRole('region', { name: 'Poll Requests' })).toHaveCount(0);
      await expect(page.getByRole('dialog', { name: 'Active poll' })).not.toBeVisible();
    } finally {
      await second.context.close();
    }
  });

  test('a participant can withdraw their own request', async ({ browser, page }) => {
    await setupStartedMeeting(page);
    const second = await openSecondContext(browser, meetingIdOf(page), { asUser: 'bob' });
    try {
      await goToQueueTab(second.page);
      await requestPollAs(second.page, 'Never mind');
      await expect(page.getByRole('region', { name: 'Poll Requests' }).getByText('Never mind')).toBeVisible();

      await second.page
        .getByRole('region', { name: 'Poll Requests' })
        .getByRole('button', { name: 'Withdraw' })
        .click();

      await expect(second.page.getByRole('region', { name: 'Poll Requests' })).toHaveCount(0);
      await expect(page.getByRole('region', { name: 'Poll Requests' })).toHaveCount(0);
    } finally {
      await second.context.close();
    }
  });

  test('a revision made while the chair is reviewing is offered via "Load revision", not swapped in', async ({
    browser,
    page,
  }) => {
    await setupStartedMeeting(page);
    const second = await openSecondContext(browser, meetingIdOf(page), { asUser: 'bob' });
    try {
      await goToQueueTab(second.page);
      await requestPollAs(second.page, 'First draft');

      // Chair opens the review dialog on the first draft.
      await waitForUnlock(page);
      await page
        .getByRole('region', { name: 'Poll Requests' })
        .getByRole('button', { name: /First draft/ })
        .click();
      const review = page.getByRole('dialog', { name: 'Review poll request' });
      await expect(review.getByLabel('Poll topic')).toHaveValue('First draft');

      // Bob revises it from his own edit dialog.
      await second.page
        .getByRole('region', { name: 'Poll Requests' })
        .getByRole('button', { name: /First draft/ })
        .click();
      const edit = second.page.getByRole('dialog', { name: 'Edit poll request' });
      await edit.getByLabel('Poll topic').fill('Second draft');
      await edit.getByRole('button', { name: 'Update Request' }).click();
      await expect(edit).not.toBeVisible();

      // Chair still sees the first draft, with a notice offering the revision.
      await expect(review).toBeVisible();
      await expect(review.getByLabel('Poll topic')).toHaveValue('First draft');
      await expect(review.getByRole('status')).toContainText(/revised/i);

      // Loading the revision swaps the contents in.
      await review.getByRole('button', { name: 'Load revision' }).click();
      await expect(review.getByLabel('Poll topic')).toHaveValue('Second draft');
      await expect(review.getByRole('button', { name: 'Approve & Start Poll' })).toBeEnabled({ timeout: 5000 });
      await review.getByRole('button', { name: 'Approve & Start Poll' }).click();
      await expect(page.getByRole('dialog', { name: 'Active poll' }).getByText('Second draft')).toBeVisible();
    } finally {
      await second.context.close();
    }
  });

  test("other participants never receive someone else's request", async ({ browser, page }) => {
    await setupStartedMeeting(page);
    const bob = await openSecondContext(browser, meetingIdOf(page), { asUser: 'bob' });
    const carol = await openSecondContext(browser, meetingIdOf(page), { asUser: 'carol' });
    try {
      await goToQueueTab(bob.page);
      await goToQueueTab(carol.page);
      await requestPollAs(bob.page, 'Secret-ish topic text');

      // The chair sees it…
      await expect(
        page.getByRole('region', { name: 'Poll Requests' }).getByText('Secret-ish topic text'),
      ).toBeVisible();
      // …Carol's page never has the text anywhere in its DOM (not even
      // hidden), because the server redacts it before sending.
      await expect(carol.page.getByRole('region', { name: 'Poll Requests' })).toHaveCount(0);
      await expect(carol.page.locator('body')).not.toContainText('Secret-ish topic text');
    } finally {
      await bob.context.close();
      await carol.context.close();
    }
  });

  test('a new request briefly locks the whole Queue tab for the chair', async ({ browser, page }) => {
    await setupStartedMeeting(page);
    await addQueueEntry(page, 'New Topic', 'Topic the chair might delete');
    const panel = page.getByRole('tabpanel', { name: 'Queue' });
    const del = page.getByRole('button', { name: 'Delete entry: Topic the chair might delete' });

    const second = await openSecondContext(browser, meetingIdOf(page), { asUser: 'bob' });
    try {
      await goToQueueTab(second.page);
      await requestPollAs(second.page, 'Arrives mid-click');

      await expect(page.getByRole('region', { name: 'Poll Requests' })).toBeVisible();
      await expect(panel).toHaveAttribute('data-interaction-locked', 'true');
      // A click during the cooldown is swallowed: the entry survives.
      await del.click({ force: true });
      await expect(del).toBeVisible();

      // …and interaction resumes after the brief cooldown.
      await expect(panel).not.toHaveAttribute('data-interaction-locked', { timeout: 5000 });
      await del.click();
      await expect(del).toHaveCount(0);
    } finally {
      await second.context.close();
    }
  });

  test('the chair can approve exactly what is on screen without loading a revision', async ({ browser, page }) => {
    await setupStartedMeeting(page);
    const second = await openSecondContext(browser, meetingIdOf(page), { asUser: 'bob' });
    try {
      await goToQueueTab(second.page);
      await requestPollAs(second.page, 'First draft');

      await waitForUnlock(page);
      await page
        .getByRole('region', { name: 'Poll Requests' })
        .getByRole('button', { name: /First draft/ })
        .click();
      const review = page.getByRole('dialog', { name: 'Review poll request' });
      await review.getByLabel('Poll topic').fill('Chair wording');

      await second.page
        .getByRole('region', { name: 'Poll Requests' })
        .getByRole('button', { name: /First draft/ })
        .click();
      const edit = second.page.getByRole('dialog', { name: 'Edit poll request' });
      await edit.getByLabel('Poll topic').fill('Second draft');
      await edit.getByRole('button', { name: 'Update Request' }).click();

      await expect(review.getByRole('status')).toContainText(/revised/i);
      await expect(review.getByLabel('Poll topic')).toHaveValue('Chair wording');
      const approve = review.getByRole('button', { name: 'Approve & Start Poll' });
      await expect(approve).toBeEnabled({ timeout: 5000 });
      await approve.click();

      await expect(page.getByRole('dialog', { name: 'Active poll' }).getByText('Chair wording')).toBeVisible();
      await expect(page.getByRole('region', { name: 'Poll Requests' })).toHaveCount(0);
    } finally {
      await second.context.close();
    }
  });

  test('a pending request survives a chair-run poll and can be approved afterwards', async ({ browser, page }) => {
    await setupStartedMeeting(page);
    const second = await openSecondContext(browser, meetingIdOf(page), { asUser: 'bob' });
    try {
      await goToQueueTab(second.page);
      await requestPollAs(second.page, 'Queued behind a running poll');

      // Chair starts their own poll directly. The (non-dismissable) poll
      // modal sits on top, so the request can't be reviewed meanwhile.
      await waitForUnlock(page);
      await page.getByRole('button', { name: 'Create Poll' }).click();
      await page.getByRole('dialog', { name: 'Create poll' }).getByRole('button', { name: 'Start Poll' }).click();
      const active = page.getByRole('dialog', { name: 'Active poll' });
      await expect(active).toBeVisible();
      await active.getByRole('button', { name: 'Stop Poll' }).click();
      await expect(active).not.toBeVisible();

      // Still listed; review and approve now works.
      const summary = page
        .getByRole('region', { name: 'Poll Requests' })
        .getByRole('button', { name: /Queued behind a running poll/ });
      await expect(summary).toBeVisible();
      await waitForUnlock(page);
      await summary.click();
      const review = page.getByRole('dialog', { name: 'Review poll request' });
      await review.getByRole('button', { name: 'Approve & Start Poll' }).click();
      await expect(page.getByRole('dialog', { name: 'Active poll' })).toBeVisible();
      await expect(second.page.getByRole('dialog', { name: 'Active poll' })).toBeVisible();
    } finally {
      await second.context.close();
    }
  });
});
