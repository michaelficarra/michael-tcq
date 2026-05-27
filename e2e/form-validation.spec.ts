/**
 * E2E coverage for interaction-deferred form validation.
 *
 * Native form controls style their `:user-invalid` / `:user-valid` state and
 * mirror it to `aria-invalid` (via the app-wide `useAriaInvalidSync` bridge).
 * The key behaviours that need a real browser (jsdom implements neither the
 * pseudo-classes nor the constraint-validation timing) are:
 *   - no error state on a fresh, untouched required field;
 *   - the error appears only after the user leaves the field empty;
 *   - it clears the instant a valid value is entered.
 *
 * Exercised on the New Agenda Item form's required "Agenda Item Name" field.
 */

import { test, expect } from '@playwright/test';
import { createMeeting } from './helpers.js';

test('required field defers its invalid state until interaction, then clears on fix', async ({ page }) => {
  await createMeeting(page); // lands on the Agenda tab as chair

  await page.getByRole('button', { name: /New Agenda Item/i }).click();
  const name = page.getByLabel('Agenda Item Name');
  await expect(name).toBeVisible();

  // Fresh field: no premature error, neither visually nor in the a11y tree.
  await expect(name).not.toHaveAttribute('aria-invalid', 'true');
  expect(await name.evaluate((el) => el.matches(':user-invalid'))).toBe(false);

  // Interact then leave it empty (type a char, delete it, blur). The browser
  // now considers the required field user-invalid.
  await name.fill('x');
  await name.fill('');
  await name.blur();

  expect(await name.evaluate((el) => el.matches(':user-invalid'))).toBe(true);
  // The bridge mirrors the visual state to assistive tech.
  await expect(name).toHaveAttribute('aria-invalid', 'true');

  // Entering a valid value clears both the visual and the ARIA error.
  await name.fill('Discuss TC39 process');
  expect(await name.evaluate((el) => el.matches(':user-valid'))).toBe(true);
  await expect(name).not.toHaveAttribute('aria-invalid', 'true');
});
