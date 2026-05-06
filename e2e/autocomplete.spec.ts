import { test, expect } from '@playwright/test';
import { createMeeting, goToAgendaTab } from './helpers.js';

/**
 * The autocomplete dropdown is wired to the same /api/users/autocomplete
 * endpoint in mock-auth (local dev) mode and real-OAuth mode; this spec
 * exercises the mock-auth path, which is what the e2e harness uses.
 *
 * In mock auth the directory returns matches from the static TC39 seed
 * list (packages/shared/src/devUsers.ts) without any GitHub network call.
 */

test.describe('Username autocomplete', () => {
  test('agenda-form presenters dropdown shows seed-list matches', async ({ page }) => {
    await createMeeting(page);
    await goToAgendaTab(page);

    await page.getByRole('button', { name: /New Agenda Item/i }).click();

    const presenters = page.getByLabel('Presenters');
    // Type a substring that should match at least one TC39 seed user.
    // "michael" is a stable choice (multiple michaels in the org).
    await presenters.fill('mich');

    // The combobox debounces 250ms before fetching. waitFor handles both
    // the network round-trip and the React render.
    const listbox = page.getByRole('listbox');
    await expect(listbox).toBeVisible();
    await expect(listbox.getByRole('option').first()).toBeVisible();

    // Every option's visible text should mention the query somewhere
    // (login or display name) — the directory ranks by case-insensitive
    // match score.
    const options = await listbox.getByRole('option').all();
    expect(options.length).toBeGreaterThan(0);
    for (const opt of options) {
      const text = (await opt.textContent())?.toLowerCase() ?? '';
      expect(text).toContain('mich');
    }
  });

  test('selecting a suggestion adds it as a chip and clears the input', async ({ page }) => {
    await createMeeting(page);
    await goToAgendaTab(page);

    await page.getByRole('button', { name: /New Agenda Item/i }).click();

    const presenters = page.getByLabel('Presenters');
    await presenters.fill('mich');

    const firstOption = page.getByRole('listbox').getByRole('option').first();
    await expect(firstOption).toBeVisible();
    const optionText = (await firstOption.textContent()) ?? '';
    // Click the first suggestion via mousedown (the combobox commits on
    // mousedown so blur doesn't unmount it first).
    await firstOption.click();

    // The input clears, the suggestion appears as a chip in the row.
    await expect(presenters).toHaveValue('');
    // The chip's login text is the first whitespace-trimmed token of the
    // option's rendered text (login appears before the optional name).
    const chipLogin = optionText.trim().split(/\s+/)[0];
    await expect(page.getByText(chipLogin, { exact: true })).toBeVisible();
  });

  test('free-text fallback: pressing Enter with no match still adds a token', async ({ page }) => {
    await createMeeting(page);
    await goToAgendaTab(page);

    await page.getByRole('button', { name: /New Agenda Item/i }).click();

    const presenters = page.getByLabel('Presenters');
    // A name guaranteed not to match the seed list.
    await presenters.fill('not-a-github-account-1234567');
    await presenters.press('Enter');

    await expect(page.getByText('not-a-github-account-1234567', { exact: true })).toBeVisible();
  });
});
