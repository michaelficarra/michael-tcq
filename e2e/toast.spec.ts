/**
 * End-to-end coverage for the unified toast region (`popover="manual"`).
 *
 * The unit tests (`src/components/ToastRegion.test.tsx`) cover the toast
 * mechanics — auto-dismiss timers, stacking offsets, error vs warning
 * variants, onDismiss — against the jsdom popover stub. This spec pins down
 * the things only a real browser exercises: that a toast actually promotes to
 * the top layer, that a persistent toast does NOT auto-dismiss, and that the
 * declarative `popovertargetaction="hide"` close button truly hides it.
 *
 * The deterministic real trigger is the agenda prologue edit-conflict: while
 * one chair has the prologue editor open, another chair saving a change raises
 * a persistent warning toast on the first chair's screen. Both contexts run as
 * the default mock admin (a chair), so no extra co-chair setup is needed.
 */

import { test, expect } from '@playwright/test';
import { createMeeting, goToAgendaTab, openSecondContext } from './helpers.js';

test.describe('Toast notifications', () => {
  test('a concurrent prologue edit raises a sticky warning toast that the close button dismisses', async ({
    browser,
    page,
  }) => {
    const meetingId = await createMeeting(page);
    await goToAgendaTab(page);

    const agendaPanel = page.getByRole('tabpanel', { name: 'Agenda' });

    // Seed a prologue, then open the editor on this (first) chair's screen.
    await agendaPanel.getByRole('button', { name: /add an agenda prologue/i }).click();
    await agendaPanel.getByRole('textbox', { name: /agenda prologue/i }).fill('original');
    await agendaPanel.getByRole('button', { name: 'Save', exact: true }).click();
    await agendaPanel.getByRole('button', { name: /edit prologue/i }).click();
    await expect(agendaPanel.getByRole('textbox', { name: /agenda prologue/i })).toBeFocused();

    // A second chair changes the prologue while the first chair is mid-edit.
    const second = await openSecondContext(browser, meetingId);
    try {
      await goToAgendaTab(second.page);
      const secondPanel = second.page.getByRole('tabpanel', { name: 'Agenda' });
      await secondPanel.getByRole('button', { name: /edit prologue/i }).click();
      await secondPanel.getByRole('textbox', { name: /agenda prologue/i }).fill('changed elsewhere');
      await secondPanel.getByRole('button', { name: 'Save', exact: true }).click();

      // The first chair sees a warning toast. It's a polite-status toast, and —
      // being a popover — lives in the top layer, so query it at page scope.
      const toast = page.getByRole('status').filter({ hasText: /another chair has updated the prologue/i });
      await expect(toast).toBeVisible();

      // The editor stays open with the draft intact — the toast is a warning,
      // not a takeover.
      await expect(agendaPanel.getByRole('textbox', { name: /agenda prologue/i })).toBeVisible();

      // Sticky: a warning toast has no auto-dismiss timer, so it's still up
      // well past the ~6s transient-error duration.
      await page.waitForTimeout(7000);
      await expect(toast).toBeVisible();

      // The native close button (popovertargetaction="hide") dismisses it.
      await toast.getByRole('button', { name: /dismiss notification/i }).click();
      await expect(toast).not.toBeVisible();
    } finally {
      await second.context.close();
    }
  });
});
