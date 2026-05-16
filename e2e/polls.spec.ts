import { test, expect } from '@playwright/test';
import { createMeeting, goToAgendaTab, goToQueueTab, goToLogTab, addAgendaItem, startMeeting } from './helpers.js';
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

    // Start Poll and Cancel buttons
    await expect(dialog.getByRole('button', { name: 'Start Poll' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeVisible();
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

  test('"Cancel" closes the setup form without starting a poll', async ({ page }) => {
    await page.getByRole('button', { name: 'Create Poll' }).click();

    const dialog = page.getByRole('dialog', { name: 'Create poll' });
    await expect(dialog).toBeVisible();

    await dialog.getByRole('button', { name: 'Cancel' }).click();

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

    const writes = await getClipboard(page);
    expect(writes.length).toBeGreaterThan(0);
    const summary = writes.at(-1)!;
    // The first non-zero line should be the reacted option.
    const firstLine = summary.split('\n').find((l) => /\b1\b/.test(l));
    expect(firstLine).toMatch(/Positive/);
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
