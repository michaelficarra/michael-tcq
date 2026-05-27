import { describe, it, expect, vi } from 'vitest';
import { syncAriaInvalid } from './useAriaInvalidSync.js';

/**
 * jsdom doesn't implement the `:user-invalid` pseudo-class, so we stub each
 * element's `.matches` to drive the two branches directly. We use real DOM
 * elements (not plain objects) so the `instanceof` type guard passes.
 */
function inputMatching(userInvalid: boolean): HTMLInputElement {
  const el = document.createElement('input');
  el.matches = vi.fn((selector: string) => (selector === ':user-invalid' ? userInvalid : false));
  return el;
}

describe('syncAriaInvalid', () => {
  it('sets aria-invalid="true" when the control is :user-invalid', () => {
    const el = inputMatching(true);
    syncAriaInvalid(el);
    expect(el.getAttribute('aria-invalid')).toBe('true');
  });

  it('removes aria-invalid when the control is no longer :user-invalid', () => {
    const el = inputMatching(false);
    el.setAttribute('aria-invalid', 'true'); // previously flagged
    syncAriaInvalid(el);
    expect(el.hasAttribute('aria-invalid')).toBe(false);
  });

  it('leaves a valid, never-flagged field untouched (no aria-invalid="false")', () => {
    const el = inputMatching(false);
    syncAriaInvalid(el);
    expect(el.hasAttribute('aria-invalid')).toBe(false);
  });

  it('also handles textarea and select elements', () => {
    const textarea = document.createElement('textarea');
    textarea.matches = vi.fn(() => true);
    syncAriaInvalid(textarea);
    expect(textarea.getAttribute('aria-invalid')).toBe('true');

    const select = document.createElement('select');
    select.matches = vi.fn(() => true);
    syncAriaInvalid(select);
    expect(select.getAttribute('aria-invalid')).toBe('true');
  });

  it('ignores non-form-control targets', () => {
    const div = document.createElement('div');
    expect(() => syncAriaInvalid(div)).not.toThrow();
    expect(div.hasAttribute('aria-invalid')).toBe(false);
    expect(() => syncAriaInvalid(null)).not.toThrow();
  });
});
