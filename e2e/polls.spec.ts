import { test, expect } from '@playwright/test';
import { createMeeting, goToAgendaTab, goToQueueTab, addAgendaItem, startMeeting } from './helpers.js';

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
