import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// jsdom doesn't implement matchMedia; the PreferencesContext uses it to detect
// `prefers-color-scheme`. Stub it out so tests render without throwing.
if (!window.matchMedia) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(), // deprecated, for older libs
    removeListener: vi.fn(), // deprecated
    dispatchEvent: vi.fn(),
  }));
}

// Automatically unmount and clean up DOM after each test
afterEach(() => {
  cleanup();
});
