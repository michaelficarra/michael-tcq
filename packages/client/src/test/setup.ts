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

// jsdom doesn't implement Element.scrollIntoView; the AgendaPanel's
// "scroll-active-item-into-view-on-tab-show" effect calls it on mount.
// Provide a default no-op so unrelated tests don't crash; tests that want
// to assert on the call can replace it with a spy.
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = vi.fn();
}

// jsdom doesn't implement the Notification API. Provide a minimal stub so the
// PreferencesContext / useMeetingNotifications code paths execute. Individual
// tests can override via `vi.stubGlobal('Notification', ...)` when they need
// to assert on constructor calls or drive specific permission states.
if (typeof globalThis.Notification === 'undefined') {
  class NotificationStub {
    static permission: NotificationPermission = 'default';
    static requestPermission = vi.fn(async () => NotificationStub.permission);
  }
  globalThis.Notification = NotificationStub as unknown as typeof Notification;
}

// Automatically unmount and clean up DOM after each test
afterEach(() => {
  cleanup();
});
