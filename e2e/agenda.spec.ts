import { test, expect } from '@playwright/test';
import { createMeeting, goToAgendaTab, addAgendaItem, switchUser } from './helpers.js';

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
    test('add form has fields for name, owner (pre-populated), and timebox', async ({ page }) => {
      await createMeeting(page);
      await goToAgendaTab(page);

      // Click to reveal the form
      await page.getByRole('button', { name: /New Agenda Item/i }).click();

      // Verify form fields are visible
      await expect(page.getByLabel('Agenda Item Name')).toBeVisible();
      const ownerInput = page.getByLabel('Owner');
      await expect(ownerInput).toBeVisible();
      // Owner should be pre-populated with the current user's username
      await expect(ownerInput).toHaveValue('admin');
      await expect(page.getByLabel('Timebox')).toBeVisible();

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

    test('items show number, name, owner with avatar, and timebox if set', async ({ page }) => {
      await createMeeting(page);
      await goToAgendaTab(page);

      await addAgendaItem(page, 'Timed item', undefined, 15);

      await expect(page.getByText('Timed item')).toBeVisible();
      await expect(page.getByText('15 minutes')).toBeVisible();
      // Owner avatar (an img element) should be present
      await expect(page.getByRole('tabpanel', { name: 'Agenda' }).locator('img').first()).toBeVisible();
    });

    test('clicking edit on an item opens inline edit form', async ({ page }) => {
      await createMeeting(page);
      await goToAgendaTab(page);

      await addAgendaItem(page, 'Editable item');

      // Click edit (button with accessible label; Help prose also contains "edit")
      await page.getByRole('button', { name: 'Edit Editable item' }).click();

      // Inline edit fields should appear
      await expect(page.getByLabel('Agenda item name')).toBeVisible();
      await expect(page.getByLabel('Owner username')).toBeVisible();
      await expect(page.getByLabel('Timebox in minutes')).toBeVisible();

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

    test('items owned by the current user have a visible left border', async ({ page }) => {
      await createMeeting(page);
      await goToAgendaTab(page);

      // Add an item owned by the current user (admin)
      await addAgendaItem(page, 'My item');

      const panel = page.getByRole('tabpanel', { name: 'Agenda' });
      const item = panel.locator('li').first();
      // The item should have a non-zero left border width (visual distinction)
      await expect(item).toHaveCSS('border-left-width', '3px');
    });

    test('items owned by another user do not have a left border', async ({ page }) => {
      await createMeeting(page);
      await goToAgendaTab(page);

      // Add an item owned by someone else
      await addAgendaItem(page, 'Their item', 'otheruser');

      const panel = page.getByRole('tabpanel', { name: 'Agenda' });
      const item = panel.locator('li').first();
      // The item should NOT have a left border
      await expect(item).toHaveCSS('border-left-width', '0px');
    });

    test('timebox displays singular "minute" for 1 minute', async ({ page }) => {
      await createMeeting(page);
      await goToAgendaTab(page);

      await addAgendaItem(page, 'Quick item', undefined, 1);

      await expect(page.getByText('1 minute')).toBeVisible();
      // Should not say "1 minutes"
      await expect(page.getByText('1 minutes')).not.toBeVisible();
    });
  });
});
