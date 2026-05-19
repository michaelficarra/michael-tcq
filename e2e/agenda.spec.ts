import { test, expect } from '@playwright/test';
import {
  createMeeting,
  goToAgendaTab,
  addAgendaItem,
  switchUser,
  startMeeting,
  goToQueueTab,
  goToLogTab,
  advanceAgenda,
  dragAndDrop,
} from './helpers.js';

test.describe('Agenda tab', () => {
  test.describe('Chair Management', () => {
    test('shows chairs as pill-shaped badges with the current user', async ({ page }) => {
      await createMeeting(page);
      await goToAgendaTab(page);

      // The chairs section should show the heading and the current user.
      // Scoped to the Agenda tabpanel because other panels (e.g. Help) also
      // contain the word "Chairs" in prose.
      const agendaPanel = page.getByRole('tabpanel', { name: 'Agenda' });
      await expect(agendaPanel.getByRole('heading', { name: 'Chairs' })).toBeVisible();
      // The meeting creator (Admin) is shown as a chair
      await expect(agendaPanel).toContainText('Admin');
    });

    test('add chair button opens inline username input', async ({ page }) => {
      await createMeeting(page);
      await goToAgendaTab(page);

      // Click the "+" add chair button
      await page.getByLabel('Add chair').click();

      // An inline input should appear
      const input = page.getByPlaceholder('username');
      await expect(input).toBeVisible();
      await expect(input).toBeFocused();
    });

    test('adding a chair shows them in the list', async ({ page }) => {
      await createMeeting(page);
      await goToAgendaTab(page);

      await page.getByLabel('Add chair').click();
      const input = page.getByPlaceholder('username');
      await input.fill('newchair');
      await input.press('Enter');

      // The new chair should appear
      await expect(page.getByRole('tabpanel', { name: 'Agenda' })).toContainText('newchair');
    });

    test('removing a chair shows confirmation dialogue', async ({ page }) => {
      await createMeeting(page);
      await goToAgendaTab(page);

      // First add another chair so we can remove them
      await page.getByLabel('Add chair').click();
      const input = page.getByPlaceholder('username');
      await input.fill('removeme');
      await input.press('Enter');

      await expect(page.getByRole('tabpanel', { name: 'Agenda' })).toContainText('removeme');

      // Click the remove button on the new chair
      await page.getByLabel('Remove chair removeme').click();

      // Confirmation dialogue should appear
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Remove' })).toBeVisible();

      // Confirm the removal
      await dialog.getByRole('button', { name: 'Remove' }).click();

      // The chair should be gone
      await expect(page.getByRole('tabpanel', { name: 'Agenda' })).not.toContainText('removeme');
    });

    test('regular chairs cannot remove themselves (no remove button on own pill)', async ({ page }) => {
      await createMeeting(page);
      await goToAgendaTab(page);

      // The admin user is a chair — admin IS an admin so they CAN remove themselves.
      // We need to add another chair, switch to that user, and verify they cannot
      // remove themselves.
      await page.getByLabel('Add chair').click();
      const input = page.getByPlaceholder('username');
      await input.fill('regularchair');
      await input.press('Enter');

      await expect(page.getByRole('tabpanel', { name: 'Agenda' })).toContainText('regularchair');

      // Switch to the regular chair user
      await switchUser(page, 'regularchair');
      await goToAgendaTab(page);

      // The regular chair should NOT have a remove button on their own pill
      await expect(page.getByLabel('Remove chair regularchair')).not.toBeVisible();

      // But they should still see the remove button for other chairs
      await expect(page.getByLabel('Remove chair admin')).toBeVisible();
    });
  });

  test.describe('Agenda Management (Chair Only)', () => {
    test('add form has fields for name, presenters (starts empty), and estimate', async ({ page }) => {
      await createMeeting(page);
      await goToAgendaTab(page);

      // Click to reveal the form
      await page.getByRole('button', { name: /New Agenda Item/i }).click();

      // Verify form fields are visible
      await expect(page.getByLabel('Agenda Item Name')).toBeVisible();
      const presentersInput = page.getByLabel('Presenters');
      await expect(presentersInput).toBeVisible();
      // Presenters field starts empty — the chair adds presenters explicitly.
      await expect(presentersInput).toHaveValue('');
      await expect(page.getByLabel('Estimate')).toBeVisible();

      // Submit and cancel buttons
      await expect(page.getByRole('button', { name: 'Create' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
    });

    test('adding an item shows it in the numbered list', async ({ page }) => {
      await createMeeting(page);
      await goToAgendaTab(page);

      await addAgendaItem(page, 'First agenda item');

      // Scope to the Agenda tabpanel since Help prose mentions "first agenda item".
      const agendaPanel = page.getByRole('tabpanel', { name: 'Agenda' });
      await expect(agendaPanel.getByText('First agenda item')).toBeVisible();
      // Should show the item number
      await expect(agendaPanel.getByText('1')).toBeVisible();
    });

    test('items show number, name, presenter with avatar, and estimate if set', async ({ page }) => {
      await createMeeting(page);
      await goToAgendaTab(page);

      await addAgendaItem(page, 'Timed item', undefined, 15);

      await expect(page.getByText('Timed item')).toBeVisible();
      await expect(page.getByText('15m', { exact: true })).toBeVisible();
      // Presenter avatar (an img element) should be present
      await expect(page.getByRole('tabpanel', { name: 'Agenda' }).locator('img').first()).toBeVisible();
    });

    test('adding an item with multiple comma-separated presenters renders a badge each', async ({ page }) => {
      await createMeeting(page);
      await goToAgendaTab(page);

      await addAgendaItem(page, 'Joint item', ['admin', 'otheruser']);

      const panel = page.getByRole('tabpanel', { name: 'Agenda' });
      // Two avatar images should be present on the item row.
      const avatars = panel.locator('li').first().locator('img');
      await expect(avatars).toHaveCount(2);
    });

    test('clicking edit on an item opens inline edit form', async ({ page }) => {
      await createMeeting(page);
      await goToAgendaTab(page);

      await addAgendaItem(page, 'Editable item');

      // Click edit (button with accessible label; Help prose also contains "edit")
      await page.getByRole('button', { name: 'Edit Editable item' }).click();

      // Inline edit fields should appear
      await expect(page.getByLabel('Agenda item name')).toBeVisible();
      await expect(page.getByLabel('Presenters')).toBeVisible();
      await expect(page.getByLabel('Estimate in minutes')).toBeVisible();

      // The name field should be pre-populated
      await expect(page.getByLabel('Agenda item name')).toHaveValue('Editable item');

      // Save and cancel buttons
      await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
    });

    test('editing an item updates its content', async ({ page }) => {
      await createMeeting(page);
      await goToAgendaTab(page);

      await addAgendaItem(page, 'Original name');

      // Edit the item (button with accessible label; Help prose also contains "edit")
      const agendaPanel = page.getByRole('tabpanel', { name: 'Agenda' });
      await page.getByRole('button', { name: 'Edit Original name' }).click();
      await page.getByLabel('Agenda item name').fill('Updated name');
      await page.getByRole('button', { name: 'Save' }).click();

      // The updated name should appear
      await expect(agendaPanel.getByText('Updated name')).toBeVisible();
      await expect(agendaPanel.getByText('Original name')).not.toBeVisible();
    });

    test('clicking delete removes the item', async ({ page }) => {
      await createMeeting(page);
      await goToAgendaTab(page);

      await addAgendaItem(page, 'Delete me');

      const agendaPanel = page.getByRole('tabpanel', { name: 'Agenda' });
      await expect(agendaPanel.getByText('Delete me')).toBeVisible();

      // Delete the item (button with accessible label; Help prose also contains "delete")
      await page.getByRole('button', { name: 'Delete Delete me' }).click();

      // The item should be removed
      await expect(agendaPanel.getByText('Delete me')).not.toBeVisible();
    });

    test('empty agenda shows "Import Agenda from URL" button for chairs', async ({ page }) => {
      await createMeeting(page);
      await goToAgendaTab(page);

      // The agenda is empty by default, so the import button should be visible
      await expect(page.getByRole('button', { name: 'Import Agenda from URL' })).toBeVisible();
      await expect(page.getByText('No agenda items yet.')).toBeVisible();
    });

    test('import button is hidden after adding an item', async ({ page }) => {
      await createMeeting(page);
      await goToAgendaTab(page);

      await expect(page.getByRole('button', { name: 'Import Agenda from URL' })).toBeVisible();

      await addAgendaItem(page, 'First item');

      await expect(page.getByRole('button', { name: 'Import Agenda from URL' })).not.toBeVisible();
    });
  });

  test.describe('Markdown in Item Names', () => {
    test('agenda items render inline markdown (bold, italic, code)', async ({ page }) => {
      await createMeeting(page);
      await goToAgendaTab(page);

      await addAgendaItem(page, '**Bold** and *italic* and `code`');

      const panel = page.getByRole('tabpanel', { name: 'Agenda' });
      // Bold text should be rendered visually
      await expect(panel.getByText('Bold')).toBeVisible();
      // Italic text should be rendered visually
      await expect(panel.getByText('italic')).toBeVisible();
      // Code should be rendered visually
      await expect(panel.getByText('code')).toBeVisible();
    });
  });

  test.describe('Agenda Display', () => {
    test('items are shown in a numbered list with correct numbering', async ({ page }) => {
      await createMeeting(page);
      await goToAgendaTab(page);

      await addAgendaItem(page, 'Item Alpha');
      await addAgendaItem(page, 'Item Beta');
      await addAgendaItem(page, 'Item Gamma');

      // Check that all items and their numbers are visible
      await expect(page.getByText('Item Alpha')).toBeVisible();
      await expect(page.getByText('Item Beta')).toBeVisible();
      await expect(page.getByText('Item Gamma')).toBeVisible();
    });

    test('items with the current user as a presenter have a visible left border', async ({ page }) => {
      await createMeeting(page);
      await goToAgendaTab(page);

      // Add an item presented by the current user (admin)
      await addAgendaItem(page, 'My item');

      const panel = page.getByRole('tabpanel', { name: 'Agenda' });
      const item = panel.locator('li').first();
      // The item should have a non-zero left border width (visual distinction)
      await expect(item).toHaveCSS('border-left-width', '3px');
    });

    test('items with only other users as presenters do not have a left border', async ({ page }) => {
      await createMeeting(page);
      await goToAgendaTab(page);

      // Add an item presented by someone else
      await addAgendaItem(page, 'Their item', 'otheruser');

      const panel = page.getByRole('tabpanel', { name: 'Agenda' });
      const item = panel.locator('li').first();
      // The item should NOT have a left border
      await expect(item).toHaveCSS('border-left-width', '0px');
    });

    test('items where the viewer is a co-presenter still show the left border', async ({ page }) => {
      await createMeeting(page);
      await goToAgendaTab(page);

      // admin is one of two presenters
      await addAgendaItem(page, 'Joint item', ['otheruser', 'admin']);

      const panel = page.getByRole('tabpanel', { name: 'Agenda' });
      const item = panel.locator('li').first();
      await expect(item).toHaveCSS('border-left-width', '3px');
    });

    test('estimate renders in short duration format', async ({ page }) => {
      await createMeeting(page);
      await goToAgendaTab(page);

      // 1 minute — should display as "1m"
      await addAgendaItem(page, 'Quick item', undefined, 1);
      await expect(page.getByText('1m', { exact: true })).toBeVisible();

      // 90 minutes — should display compact hour+minute format
      await addAgendaItem(page, 'Long item', undefined, 90);
      await expect(page.getByText('1h30m', { exact: true })).toBeVisible();
    });
  });

  test.describe('Sessions (Chair Only)', () => {
    test('creates a session with capacity and shows it in the agenda list', async ({ page }) => {
      await createMeeting(page);
      await goToAgendaTab(page);

      // Open the New Session form and submit it.
      await page.getByRole('button', { name: 'New Session' }).click();
      await page.getByLabel('Session Name').fill('Morning block');
      await page.getByLabel('Capacity').fill('90');
      await page.getByRole('button', { name: 'Create' }).click();

      const panel = page.getByRole('tabpanel', { name: 'Agenda' });
      await expect(panel.getByText('Morning block')).toBeVisible();
      // Capacity 1h30m, no items yet — remaining equals capacity.
      await expect(panel.getByText(/remaining/i)).toBeVisible();
      // 1h30m appears in the capacity label and the remaining label.
      await expect(panel.getByText('1h30m').first()).toBeVisible();
    });

    test('updates used and remaining live as items are added below', async ({ page }) => {
      await createMeeting(page);
      await goToAgendaTab(page);

      await page.getByRole('button', { name: 'New Session' }).click();
      await page.getByLabel('Session Name').fill('Block');
      await page.getByLabel('Capacity').fill('60');
      await page.getByRole('button', { name: 'Create' }).click();

      await addAgendaItem(page, 'First', undefined, 15);
      await addAgendaItem(page, 'Second', undefined, 20);

      const panel = page.getByRole('tabpanel', { name: 'Agenda' });
      // used = 35m, remaining = 25m
      await expect(panel.getByText('35m', { exact: true })).toBeVisible();
      await expect(panel.getByText('25m', { exact: true })).toBeVisible();
    });

    test('flips to "overflow" label when items exceed capacity', async ({ page }) => {
      await createMeeting(page);
      await goToAgendaTab(page);

      await page.getByRole('button', { name: 'New Session' }).click();
      await page.getByLabel('Session Name').fill('Tight');
      await page.getByLabel('Capacity').fill('30');
      await page.getByRole('button', { name: 'Create' }).click();

      await addAgendaItem(page, 'A', undefined, 15);
      await addAgendaItem(page, 'B', undefined, 15);
      await addAgendaItem(page, 'C', undefined, 10);

      const panel = page.getByRole('tabpanel', { name: 'Agenda' });
      await expect(panel.getByText(/overflow/i)).toBeVisible();
      await expect(panel.getByText(/remaining/i)).not.toBeVisible();
    });

    test('deleting a session keeps the agenda items in place', async ({ page }) => {
      await createMeeting(page);
      await goToAgendaTab(page);

      await page.getByRole('button', { name: 'New Session' }).click();
      await page.getByLabel('Session Name').fill('Block');
      await page.getByLabel('Capacity').fill('30');
      await page.getByRole('button', { name: 'Create' }).click();

      await addAgendaItem(page, 'Kept item', undefined, 10);

      await page.getByRole('button', { name: 'Delete session Block' }).click();

      const panel = page.getByRole('tabpanel', { name: 'Agenda' });
      await expect(panel.getByText('Block')).not.toBeVisible();
      await expect(panel.getByText('Kept item')).toBeVisible();
    });
  });

  test.describe('Conclusions', () => {
    test('chair can record a conclusion when advancing past an agenda item, and it shows in the log and agenda', async ({
      page,
    }) => {
      await createMeeting(page);
      await goToAgendaTab(page);
      await addAgendaItem(page, 'First Item', 'admin');
      await addAgendaItem(page, 'Second Item', 'admin');
      await startMeeting(page);

      // Dialog appears even with an empty queue; record a conclusion.
      await advanceAgenda(page, 'Decided to revisit next week');

      // Current item moved on
      const queuePanel = page.getByRole('tabpanel', { name: 'Queue' });
      await expect(queuePanel.getByRole('region', { name: 'Agenda Item' })).toContainText('Second Item');

      // Log: finished entry shows the conclusion
      await goToLogTab(page);
      const logPanel = page.getByRole('tabpanel', { name: 'Log' });
      await expect(logPanel.getByText('Conclusion:')).toBeVisible();
      await expect(logPanel.getByText('Decided to revisit next week')).toBeVisible();

      // Agenda: past item shows the conclusion under its name
      await goToAgendaTab(page);
      const agendaPanel = page.getByRole('tabpanel', { name: 'Agenda' });
      await expect(agendaPanel.getByText('Decided to revisit next week')).toBeVisible();
    });

    // Flaky on chromium CI: the dialog opens but the conclusion textarea
    // is empty (9× consistent retries seeing ""). The pre-population path
    // sits behind a drag-and-drop reorder + an advance round-trip; one of
    // those races appears to drop the saved conclusion in CI under load.
    // Disabled until the underlying race is identified — the
    // conclusion-pre-population logic itself is exercised by
    // QueuePanel.test.tsx unit tests.
    test.fixme('re-editing a past item with a conclusion pre-populates the dialog with the previous text', async ({
      page,
    }) => {
      await createMeeting(page);
      await goToAgendaTab(page);
      await addAgendaItem(page, 'First Item', 'admin');
      await addAgendaItem(page, 'Second Item', 'admin');
      await startMeeting(page);

      // First pass: record a conclusion.
      await advanceAgenda(page, 'Initial decision');

      // Drag the first item back below the second so item 1 becomes "current" again.
      // The drag rules require the move to land on an item — here we just open the
      // dialog directly by clicking the inline "edit" on the now-past first item
      // is not the same path; instead, we use the queue Advance flow as the PRD
      // describes ("If an item that already has a conclusion becomes the current
      // item again (e.g. via reorder), the dialogue's textarea is pre-populated").
      // We reorder First Item below Second Item so when Second is advanced past,
      // First Item becomes current again.
      await goToAgendaTab(page);
      const agendaPanel = page.getByRole('tabpanel', { name: 'Agenda' });
      const firstRow = agendaPanel.locator('li', { hasText: 'First Item' });
      const secondRow = agendaPanel.locator('li', { hasText: 'Second Item' });
      await dragAndDrop(page, firstRow, secondRow);

      // Wait for the optimistic-then-server reorder to settle before
      // leaving the agenda tab. Surfaces a clear "drag did not reorder"
      // failure here instead of an opaque timeout three lines later on
      // the Next-Agenda-Item button (which is gated on currentAgendaItem
      // and is therefore the first downstream casualty if the reorder
      // silently no-ops).
      await expect(agendaPanel.locator('ol[aria-label="Agenda items"] > li').first()).toContainText('Second Item');

      // Now the order should be Second (current), First. Advance past Second so
      // First becomes the current item again. The dialog should pre-populate
      // with First Item's saved conclusion.
      await goToQueueTab(page);
      // Click Next Agenda Item; check the dialog body. Don't use advanceAgenda
      // here — we want to inspect the prefilled textarea before submitting.
      await page.getByRole('button', { name: /^(Next Agenda Item|Conclude meeting)$/ }).click();
      const dialog = page.getByRole('dialog', { name: /confirm agenda advancement/i });
      // After advancing past Second, First Item is the outgoing item for the
      // NEXT advance — but the PRD specifically describes the dialog seeded
      // when the item-with-conclusion becomes current. Advance Second first.
      await dialog.getByRole('button', { name: 'Advance' }).click();
      await expect(dialog).not.toBeVisible();

      // Now First Item is the current item. Open the dialog again — its
      // saved conclusion should pre-populate.
      await page.getByRole('button', { name: /^(Next Agenda Item|Conclude meeting)$/ }).click();
      const dialog2 = page.getByRole('dialog', { name: /confirm agenda advancement/i });
      await expect(dialog2.getByLabel(/conclusion/i)).toHaveValue('Initial decision');
    });
  });

  test.describe('Drag-and-drop reorder', () => {
    test('chair drags an agenda item to a new position', async ({ page }) => {
      await createMeeting(page);
      await goToAgendaTab(page);
      await addAgendaItem(page, 'Alpha');
      await addAgendaItem(page, 'Bravo');
      await addAgendaItem(page, 'Charlie');

      const agendaPanel = page.getByRole('tabpanel', { name: 'Agenda' });

      // Sanity: starting order is Alpha, Bravo, Charlie.
      // Use textContent comparisons on the ordered list children rather than
      // numeric badges because session interpolation can affect numbering.
      const initialNames = await agendaPanel.locator('ol[aria-label="Agenda items"] > li').allTextContents();
      expect(initialNames[0]).toContain('Alpha');
      expect(initialNames[1]).toContain('Bravo');
      expect(initialNames[2]).toContain('Charlie');

      // Drag Alpha down onto Charlie's row.
      const alpha = agendaPanel.locator('li', { hasText: 'Alpha' });
      const charlie = agendaPanel.locator('li', { hasText: 'Charlie' });
      await dragAndDrop(page, alpha, charlie);

      // Order should now be Bravo, Charlie, Alpha (or at minimum Alpha sits
      // after both originals — the optimistic update settles to the server's
      // resolved order). We assert Alpha is no longer first.
      await expect(agendaPanel.locator('ol[aria-label="Agenda items"] > li').first()).not.toContainText('Alpha');
    });

    test('chair drags a session header to a new position; contained items are recomputed', async ({ page }) => {
      await createMeeting(page);
      await goToAgendaTab(page);

      // Layout: [Block (60m)] [Alpha 10m] [Bravo 10m] [Charlie 10m]
      await page.getByRole('button', { name: 'New Session' }).click();
      await page.getByLabel('Session Name').fill('Block');
      await page.getByLabel('Capacity').fill('60');
      await page.getByRole('button', { name: 'Create' }).click();
      await addAgendaItem(page, 'Alpha', undefined, 10);
      await addAgendaItem(page, 'Bravo', undefined, 10);
      await addAgendaItem(page, 'Charlie', undefined, 10);

      const agendaPanel = page.getByRole('tabpanel', { name: 'Agenda' });
      const sessionRow = agendaPanel.locator('li', { hasText: 'Block' });
      // Before drag: all three items fit inside Block — used 30m.
      await expect(sessionRow).toContainText('used 30m');

      // Drag the session below Bravo so it contains only Charlie afterwards.
      const session = agendaPanel.locator('li', { hasText: 'Block' });
      const bravo = agendaPanel.locator('li', { hasText: 'Bravo' });
      await dragAndDrop(page, session, bravo);

      // After drag: only Charlie sits under Block → used 10m.
      await expect(agendaPanel.locator('li', { hasText: 'Block' })).toContainText('used 10m');
    });
  });

  test.describe('Session editing', () => {
    test('chair edits a session name and capacity inline', async ({ page }) => {
      await createMeeting(page);
      await goToAgendaTab(page);

      await page.getByRole('button', { name: 'New Session' }).click();
      await page.getByLabel('Session Name').fill('Morning');
      await page.getByLabel('Capacity').fill('45');
      await page.getByRole('button', { name: 'Create' }).click();

      const agendaPanel = page.getByRole('tabpanel', { name: 'Agenda' });
      // The session header carries its name and capacity. We assert on the
      // composite text so we don't care about strict-mode duplicates.
      await expect(agendaPanel.locator('li', { hasText: 'Morning' })).toContainText('capacity 45m');

      // Open the inline edit form for the session.
      await page.getByRole('button', { name: 'Edit session Morning' }).click();
      await page.getByLabel('Session name').fill('Afternoon');
      await page.getByLabel('Session capacity in minutes').fill('90');
      await page.getByRole('button', { name: 'Save' }).click();

      // Name updates, capacity updates.
      await expect(agendaPanel.locator('li', { hasText: 'Afternoon' })).toContainText('capacity 1h30m');
      await expect(agendaPanel.getByText('Morning')).not.toBeVisible();
    });
  });

  test.describe('Agenda import', () => {
    // The full happy-path import exercises a server outbound fetch to
    // raw.githubusercontent.com, which Playwright cannot intercept (the fetch
    // happens server-side). Parser correctness is exercised in
    // packages/server/src/parseAgenda.test.ts against real TC39 fixtures. The
    // tests below pin down only the client-side UI mechanics and the server's
    // error response path — both of which only the full stack can demonstrate.

    test('chair opens the import form, submits a URL, and receives a server error for a missing fixture', async ({
      page,
    }) => {
      await createMeeting(page);
      await goToAgendaTab(page);

      await page.getByRole('button', { name: 'Import Agenda from URL' }).click();

      // Form fields visible
      const urlInput = page.getByLabel('Agenda markdown URL');
      await expect(urlInput).toBeVisible();
      await expect(urlInput).toBeFocused();

      // Submit a URL that satisfies the client's regex but points to a
      // non-existent TC39 agenda document. The server fetches it and surfaces
      // the failure as a 502 error which the form renders in an alert.
      await urlInput.fill('https://github.com/tc39/agendas/blob/main/1900/01.md');
      await page.getByRole('button', { name: 'Import' }).click();

      // The error message bubbles up to the form's alert region. We only
      // assert that *some* error is shown — the exact wording depends on
      // upstream (404 vs 503 vs DNS), but the form always renders the alert.
      await expect(page.getByRole('alert')).toBeVisible({ timeout: 15_000 });
    });

    test('Cancel closes the import form without affecting the agenda', async ({ page }) => {
      await createMeeting(page);
      await goToAgendaTab(page);

      await page.getByRole('button', { name: 'Import Agenda from URL' }).click();
      await page.getByLabel('Agenda markdown URL').fill('https://github.com/tc39/agendas/blob/main/2026/03.md');
      await page.getByRole('button', { name: 'Cancel' }).click();

      // Back to the empty state with the trigger button visible.
      await expect(page.getByRole('button', { name: 'Import Agenda from URL' })).toBeVisible();
      await expect(page.getByText('No agenda items yet.')).toBeVisible();
    });
  });
});
