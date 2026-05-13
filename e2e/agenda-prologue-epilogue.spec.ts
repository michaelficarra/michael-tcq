/**
 * End-to-end coverage for the agenda prologue and epilogue sections —
 * chair-editable, sanitised-markdown blocks rendered above and below the
 * agenda list.
 */

import { test, expect } from '@playwright/test';
import { createMeeting, goToAgendaTab, switchUser } from './helpers.js';

test.describe('Agenda prologue and epilogue', () => {
  test('chair adds, edits, and clears a markdown prologue', async ({ page }) => {
    await createMeeting(page);
    await goToAgendaTab(page);

    const agendaPanel = page.getByRole('tabpanel', { name: 'Agenda' });

    // Chair sees the dashed placeholder.
    const placeholder = agendaPanel.getByRole('button', { name: /add an agenda prologue/i });
    await expect(placeholder).toBeVisible();

    // Clicking opens an auto-focused textarea with Save/Cancel.
    await placeholder.click();
    const textarea = agendaPanel.getByRole('textbox', { name: /agenda prologue/i });
    await expect(textarea).toBeFocused();
    await textarea.fill('# Welcome\n\n- bullet one\n- bullet two');

    await agendaPanel.getByRole('button', { name: 'Save' }).click();

    // The rendered content shows up via BlockMarkdown — heading + list items
    // become real DOM nodes.
    await expect(agendaPanel.getByRole('heading', { level: 1, name: 'Welcome' })).toBeVisible();
    await expect(agendaPanel.getByText('bullet one')).toBeVisible();
    await expect(agendaPanel.getByText('bullet two')).toBeVisible();

    // Edit/delete affordances are visible for chairs.
    await expect(agendaPanel.getByRole('button', { name: /edit prologue/i })).toBeVisible();
    await expect(agendaPanel.getByRole('button', { name: /delete prologue/i })).toBeVisible();

    // Delete opens a confirmation dialogue; confirming clears back to the placeholder.
    await agendaPanel.getByRole('button', { name: /delete prologue/i }).click();
    const deleteDialog = page.getByRole('dialog', { name: /delete prologue/i });
    await expect(deleteDialog).toBeVisible();
    await deleteDialog.getByRole('button', { name: 'Delete' }).click();
    await expect(agendaPanel.getByRole('button', { name: /add an agenda prologue/i })).toBeVisible();
  });

  test('cancelling the delete confirmation leaves the section populated', async ({ page }) => {
    await createMeeting(page);
    await goToAgendaTab(page);

    const agendaPanel = page.getByRole('tabpanel', { name: 'Agenda' });

    await agendaPanel.getByRole('button', { name: /add an agenda prologue/i }).click();
    await agendaPanel.getByRole('textbox', { name: /agenda prologue/i }).fill('keep me around');
    await agendaPanel.getByRole('button', { name: 'Save' }).click();
    await expect(agendaPanel.getByText('keep me around')).toBeVisible();

    await agendaPanel.getByRole('button', { name: /delete prologue/i }).click();
    const deleteDialog = page.getByRole('dialog', { name: /delete prologue/i });
    await deleteDialog.getByRole('button', { name: 'Cancel' }).click();

    await expect(agendaPanel.getByText('keep me around')).toBeVisible();
  });

  test('chair adds an epilogue and Ctrl+Enter submits', async ({ page }) => {
    await createMeeting(page);
    await goToAgendaTab(page);

    const agendaPanel = page.getByRole('tabpanel', { name: 'Agenda' });

    await agendaPanel.getByRole('button', { name: /add an agenda epilogue/i }).click();
    const textarea = agendaPanel.getByRole('textbox', { name: /agenda epilogue/i });
    await textarea.fill('thanks **everyone**');

    // Ctrl+Enter inside the textarea saves without clicking Save.
    await textarea.press('ControlOrMeta+Enter');

    await expect(agendaPanel.getByText('thanks')).toBeVisible();
    // The bold subword renders as a real <strong>.
    await expect(agendaPanel.locator('strong', { hasText: 'everyone' })).toBeVisible();
  });

  test('non-chair participants see the rendered prologue but no controls', async ({ page }) => {
    await createMeeting(page);
    await goToAgendaTab(page);

    const agendaPanel = page.getByRole('tabpanel', { name: 'Agenda' });

    // As chair, populate the prologue.
    await agendaPanel.getByRole('button', { name: /add an agenda prologue/i }).click();
    await agendaPanel.getByRole('textbox', { name: /agenda prologue/i }).fill('visible to all participants');
    await agendaPanel.getByRole('button', { name: 'Save' }).click();
    await expect(agendaPanel.getByText('visible to all participants')).toBeVisible();

    // Switch to a non-chair identity. The same agenda tab is still rendered.
    await switchUser(page, 'someone-else');
    await goToAgendaTab(page);

    // Content stays visible.
    await expect(agendaPanel.getByText('visible to all participants')).toBeVisible();
    // No editing affordances.
    await expect(agendaPanel.getByRole('button', { name: /edit prologue/i })).toHaveCount(0);
    await expect(agendaPanel.getByRole('button', { name: /delete prologue/i })).toHaveCount(0);
    await expect(agendaPanel.getByRole('button', { name: /add an agenda prologue/i })).toHaveCount(0);
  });

  test('saving the editor with an empty textarea clears the section', async ({ page }) => {
    await createMeeting(page);
    await goToAgendaTab(page);

    const agendaPanel = page.getByRole('tabpanel', { name: 'Agenda' });

    // Populate the prologue first.
    await agendaPanel.getByRole('button', { name: /add an agenda prologue/i }).click();
    await agendaPanel.getByRole('textbox', { name: /agenda prologue/i }).fill('placeholder text');
    await agendaPanel.getByRole('button', { name: 'Save' }).click();
    await expect(agendaPanel.getByText('placeholder text')).toBeVisible();

    // Edit, then empty + save — same effect as clicking delete.
    await agendaPanel.getByRole('button', { name: /edit prologue/i }).click();
    const textarea = agendaPanel.getByRole('textbox', { name: /agenda prologue/i });
    await textarea.fill('');
    await agendaPanel.getByRole('button', { name: 'Save' }).click();

    await expect(agendaPanel.getByRole('button', { name: /add an agenda prologue/i })).toBeVisible();
    await expect(agendaPanel.getByText('placeholder text')).toHaveCount(0);
  });
});
