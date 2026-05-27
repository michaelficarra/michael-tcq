/**
 * End-to-end tests for the saved-topics feature.
 *
 * Covers:
 * - The recycle dropdown beside the entry-type buttons.
 * - Clicking a saved topic adds a finished topic to the queue immediately,
 *   skipping the pending/initial-edit state.
 * - The editor in Preferences supports add / edit / delete.
 * - Each saved topic has a configurable priority; a saved topic whose
 *   priority isn't currently addable (e.g. a Reply with no active topic) is
 *   disabled in the dropdown, and becomes usable once it is addable.
 * - Per-user isolation: switching to a different mock user shows a fresh
 *   default list, not the previous user's customisations.
 */

import { test, expect } from '@playwright/test';
import { createMeeting, goToAgendaTab, goToQueueTab, addAgendaItem, startMeeting, switchUser } from './helpers.js';

async function setupStartedMeeting(page: import('@playwright/test').Page) {
  await createMeeting(page);
  await goToAgendaTab(page);
  await addAgendaItem(page, 'Item 1');
  await startMeeting(page);
}

test.describe('Saved topics', () => {
  test('clicking a saved topic adds a finished topic to the queue (no edit step)', async ({ page }) => {
    await setupStartedMeeting(page);
    await goToQueueTab(page);

    // The dropdown trigger sits in the entry-type button group.
    const controls = page.getByRole('group', { name: 'Queue entry types' });
    const trigger = controls.getByRole('button', { name: 'Saved topics' });
    await expect(trigger).toBeVisible();

    await trigger.click();

    const menu = page.getByRole('menu', { name: 'Saved topics' });
    await expect(menu).toBeVisible();
    // The seeded default is the only entry on first use.
    const support = menu.getByRole('menuitem', { name: '👍 I support this. (EOM)' });
    await expect(support).toBeVisible();

    await support.click();

    // The entry shows up in the queue verbatim, with NO editor open. The
    // input that would normally appear in the pending state must not be
    // present — that's the whole point of skipping the pending state.
    await expect(page.getByText('👍 I support this. (EOM)')).toBeVisible();
    await expect(page.getByLabel('Topic description')).toHaveCount(0);
  });

  test('editor supports add, edit, and delete; dropdown reflects the changes', async ({ page }) => {
    await setupStartedMeeting(page);
    await goToQueueTab(page);

    // Open the dropdown, then click "Edit saved topics…" to deep-link
    // into the Preferences modal.
    await page.getByRole('button', { name: 'Saved topics' }).click();
    await page.getByRole('menuitem', { name: /Edit saved topics/ }).click();

    const dialog = page.getByRole('dialog', { name: 'Preferences' });
    await expect(dialog).toBeVisible();

    // Rows are listitems inside the "Saved topics" list. Index 0 is
    // the seeded default; subsequent rows are inserted at the end.
    const rows = dialog.getByRole('list', { name: 'Saved topics' }).getByRole('listitem');

    // Edit the default (row 0): clear and type a new value.
    const firstInput = rows.nth(0).getByRole('textbox');
    await firstInput.fill('👍 LGTM. (EOM)');
    await firstInput.press('Enter');

    // Add a new saved topic. The new row's input is auto-focused so
    // we can type into the focused element directly.
    await dialog.getByRole('button', { name: 'Add saved topic' }).click();
    await page.keyboard.type('Strongly agree.');
    await page.keyboard.press('Enter');

    // Close the modal (Escape) and verify the dropdown picks up both changes.
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();

    await page.getByRole('button', { name: 'Saved topics' }).click();
    const menu = page.getByRole('menu', { name: 'Saved topics' });
    await expect(menu.getByRole('menuitem', { name: '👍 LGTM. (EOM)' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Strongly agree.' })).toBeVisible();

    // Close dropdown, reopen the editor, and delete the first row (LGTM).
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Saved topics' }).click();
    await page.getByRole('menuitem', { name: /Edit saved topics/ }).click();
    const dialog2 = page.getByRole('dialog', { name: 'Preferences' });
    const rows2 = dialog2.getByRole('list', { name: 'Saved topics' }).getByRole('listitem');
    await rows2.nth(0).getByRole('button', { name: 'Delete saved topic' }).click();
    await page.keyboard.press('Escape');

    // Reopen dropdown — only the added entry should remain.
    await page.getByRole('button', { name: 'Saved topics' }).click();
    const menu2 = page.getByRole('menu', { name: 'Saved topics' });
    await expect(menu2.getByRole('menuitem', { name: 'Strongly agree.' })).toBeVisible();
    await expect(menu2.getByRole('menuitem', { name: '👍 LGTM. (EOM)' })).toHaveCount(0);
  });

  test('a Reply-priority saved topic is disabled until a topic is active, then enqueues', async ({ page }) => {
    await setupStartedMeeting(page);
    await goToQueueTab(page);

    // Give the seeded default the Reply priority via the editor.
    await page.getByRole('button', { name: 'Saved topics' }).click();
    await page.getByRole('menuitem', { name: /Edit saved topics/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Preferences' });
    const firstRow = dialog.getByRole('list', { name: 'Saved topics' }).getByRole('listitem').nth(0);
    // The priority <select> exposes types by value ('topic', 'reply', …).
    await firstRow.getByLabel('Saved topic priority').selectOption('reply');
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();

    // With no active topic, the reply-priority entry is disabled.
    await page.getByRole('button', { name: 'Saved topics' }).click();
    const menu = page.getByRole('menu', { name: 'Saved topics' });
    const item = menu.getByRole('menuitem', { name: '👍 I support this. (EOM)' });
    await expect(item).toBeDisabled();
    await expect(item).toHaveAttribute('title', 'No active topic to reply to');
    await page.keyboard.press('Escape');

    // Make a topic active: add a New Topic and advance to it. (Inlined rather
    // than using the addQueueEntry helper, whose substring "Save" match also
    // matches the "Saved topics" button.)
    await page
      .getByRole('group', { name: 'Queue entry types' })
      .getByRole('button', { name: 'New Topic', exact: true })
      .click();
    await page.getByLabel('Topic description').fill('Discuss the agenda');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('button', { name: 'Next Speaker' }).click();
    await expect(page.getByRole('button', { name: 'Discuss Current Topic' })).toBeVisible();

    // Now the reply-priority entry is usable and enqueues immediately.
    await page.getByRole('button', { name: 'Saved topics' }).click();
    const item2 = page
      .getByRole('menu', { name: 'Saved topics' })
      .getByRole('menuitem', { name: '👍 I support this. (EOM)' });
    await expect(item2).toBeEnabled();
    await item2.click();

    // It lands as a finished entry (no editor) and shows in the queue.
    await expect(page.getByText('👍 I support this. (EOM)')).toBeVisible();
    await expect(page.getByLabel('Topic description')).toHaveCount(0);
  });

  test('per-user lists are isolated', async ({ page }) => {
    await setupStartedMeeting(page);
    await goToQueueTab(page);

    // As the initial user, replace the default with a personal entry.
    await page.getByRole('button', { name: 'Saved topics' }).click();
    await page.getByRole('menuitem', { name: /Edit saved topics/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Preferences' });

    await dialog.getByRole('button', { name: 'Add saved topic' }).click();
    await page.keyboard.type('Alice-only response');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');

    // Switch to a different mock user (still in the same browser context →
    // shared localStorage, but the saved-topics key is keyed by the user's
    // account, so the new user sees their own fresh default).
    await switchUser(page, 'bob');
    // After the user switch, the page reconnects; navigate to the meeting
    // again so we land on the queue with the right identity.
    await goToQueueTab(page);

    await page.getByRole('button', { name: 'Saved topics' }).click();
    const menu = page.getByRole('menu', { name: 'Saved topics' });
    await expect(menu.getByRole('menuitem', { name: '👍 I support this. (EOM)' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Alice-only response' })).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// Native popover dismissal
//
// The dropdown is a `popover="auto"` element, so outside-click and Esc
// dismissal come from the platform (not driveable in jsdom). The re-click case
// guards against the auto-popover race where the trigger's light dismiss closes
// the menu and the same click would reopen it.
// ---------------------------------------------------------------------------

test.describe('Saved topics — popover dismissal', () => {
  test('re-clicking the trigger closes the dropdown (does not reopen it)', async ({ page }) => {
    await setupStartedMeeting(page);
    await goToQueueTab(page);
    const trigger = page.getByRole('button', { name: 'Saved topics' });
    const menu = page.getByRole('menu', { name: 'Saved topics' });

    await trigger.click();
    await expect(menu).toBeVisible();

    await trigger.click();
    await expect(menu).toHaveCount(0);
  });

  test('Escape dismisses the dropdown', async ({ page }) => {
    await setupStartedMeeting(page);
    await goToQueueTab(page);
    await page.getByRole('button', { name: 'Saved topics' }).click();
    const menu = page.getByRole('menu', { name: 'Saved topics' });
    await expect(menu).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
  });

  test('clicking outside dismisses the dropdown', async ({ page }) => {
    await setupStartedMeeting(page);
    await goToQueueTab(page);
    await page.getByRole('button', { name: 'Saved topics' }).click();
    const menu = page.getByRole('menu', { name: 'Saved topics' });
    await expect(menu).toBeVisible();

    await page.mouse.click(8, 400);
    await expect(menu).toHaveCount(0);
  });
});
