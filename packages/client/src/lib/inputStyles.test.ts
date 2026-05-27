import { describe, it, expect } from 'vitest';
import { inputValidation } from './inputStyles.js';

describe('inputValidation', () => {
  it('styles the :user-invalid state (border + tint, light and dark)', () => {
    expect(inputValidation).toContain('user-invalid:border-red-500');
    expect(inputValidation).toContain('user-invalid:bg-red-50');
    expect(inputValidation).toContain('dark:user-invalid:border-red-400');
    expect(inputValidation).toContain('dark:user-invalid:bg-red-900/20');
  });

  it('confirms :user-valid only on required fields', () => {
    expect(inputValidation).toContain('required:user-valid:border-green-600');
    expect(inputValidation).toContain('dark:required:user-valid:border-green-500');
    // Optional fields must never light up green.
    expect(inputValidation).not.toMatch(/(^|\s)user-valid:/);
  });
});
