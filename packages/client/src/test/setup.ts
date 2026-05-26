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

// jsdom (29.x) doesn't implement the modal-dialog methods at all — no
// `showModal`, `show`, or `close` on HTMLDialogElement, and no `closedBy`.
// PreferencesModal now drives a native <dialog> via these methods, so stub
// minimal versions that just toggle the `open` attribute and fire the
// `close`/`cancel` events. This is enough for component tests to exercise the
// open/close wiring; real focus-trap, light-dismiss, and Esc behaviour are
// covered by the Playwright e2e suite in a real browser. `closedBy` is left
// undefined so the component registers its outside-click fallback (the path
// jsdom can actually drive).
if (typeof HTMLDialogElement.prototype.showModal !== 'function') {
  HTMLDialogElement.prototype.show = function show(this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement, returnValue?: string) {
    if (!this.open) return;
    this.open = false;
    if (returnValue !== undefined) this.returnValue = returnValue;
    this.dispatchEvent(new Event('close'));
  };
}

// jsdom (29.x) ships only a *partial* Popover API: showPopover() exists but
// never flips the UA `[popover]:not(:popover-open) { display: none }` off, so
// popover contents stay invisible to getByRole/getComputedStyle and tests
// can't see them. UserMenu, SpeakerControls (via usePopover) and the
// UserCombobox suggestion list now drive native `popover` elements, so replace
// the broken methods outright with stubs that toggle inline display (which
// beats the UA rule) and fire the `toggle` event (with the `newState` field
// usePopover reads). Components gate rendering on their own React `open` state,
// so this is enough for unit tests to exercise the wiring; real light-dismiss
// / Esc / top-layer behaviour is covered by the Playwright e2e suite.
{
  const fireToggle = (el: HTMLElement, newState: 'open' | 'closed') => {
    const ev = new Event('toggle') as Event & { newState: string; oldState: string };
    ev.newState = newState;
    ev.oldState = newState === 'open' ? 'closed' : 'open';
    el.dispatchEvent(ev);
  };
  HTMLElement.prototype.showPopover = function showPopover(this: HTMLElement) {
    this.style.display = 'block';
    fireToggle(this, 'open');
  };
  HTMLElement.prototype.hidePopover = function hidePopover(this: HTMLElement) {
    this.style.display = 'none';
    fireToggle(this, 'closed');
  };
  HTMLElement.prototype.togglePopover = function togglePopover(this: HTMLElement, force?: boolean) {
    const next = typeof force === 'boolean' ? force : this.style.display === 'none';
    if (next) this.showPopover();
    else this.hidePopover();
    return next;
  };
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
