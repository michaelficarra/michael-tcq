/**
 * Page-init mocks for browser APIs that Playwright cannot drive directly.
 *
 * Each installer attaches a controllable stand-in via `page.addInitScript`
 * so it runs before any application code on every navigation in the page.
 * The recorded state lives on `window` under namespaced keys and is read
 * back via `page.evaluate(...)`.
 *
 * Helpers in this file are intentionally minimal — they only cover the
 * surface area exercised by the e2e suite. The aim is to make the affected
 * features deterministic across Chromium, Firefox, and WebKit (where, for
 * example, Notification permission flow, real fullscreen, and OS dark-mode
 * cannot be reliably synthesised by the test runner).
 */

import type { BrowserContext, Page } from '@playwright/test';

// -- Fullscreen API --
// The presentation-mode feature calls `document.documentElement.requestFullscreen`
// and listens for `fullscreenchange`. Firefox/WebKit headless modes do not allow
// programmatic fullscreen, so we stub the entire surface and synthesise the
// `fullscreenchange` event ourselves.
export async function installFullscreenMock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let currentFsElement: Element | null = null;

    function dispatchChange() {
      document.dispatchEvent(new Event('fullscreenchange'));
    }

    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => currentFsElement,
    });

    Element.prototype.requestFullscreen = function (this: Element) {
      currentFsElement = this;
      // Defer so callers see the assignment in a microtask, mirroring the real
      // browser's async fullscreen entry. The `fullscreenchange` listener
      // attaches via useEffect; queueMicrotask ensures the listener is present
      // before we fire.
      queueMicrotask(dispatchChange);
      return Promise.resolve();
    };

    document.exitFullscreen = function () {
      currentFsElement = null;
      queueMicrotask(dispatchChange);
      return Promise.resolve();
    };

    // Test-only escape hatch: simulate the user pressing Esc in fullscreen.
    // Real browsers exit fullscreen without firing the app's `f` shortcut, so
    // tests need a way to trigger the change-event path independent of the
    // toggle.
    (window as unknown as { __triggerFullscreenExit: () => void }).__triggerFullscreenExit = () => {
      currentFsElement = null;
      dispatchChange();
    };
  });
}

// -- Notification API --
// Replaces `window.Notification` with a recorder constructor and a
// programmable permission. Notifications fire as plain JS objects pushed onto
// `window.__notifications` so tests can assert on titles/options.
export interface NotificationRecord {
  title: string;
  options?: NotificationOptions;
}

export async function installNotificationMock(
  target: Page | BrowserContext,
  initialPermission: NotificationPermission = 'default',
): Promise<void> {
  await target.addInitScript((permission) => {
    const fired: NotificationRecord[] = [];
    let currentPermission: NotificationPermission = permission as NotificationPermission;
    const permissionListeners = new Set<() => void>();

    class MockNotification {
      static get permission(): NotificationPermission {
        return currentPermission;
      }
      static async requestPermission(): Promise<NotificationPermission> {
        // Tests flip the desired outcome via `__setNotificationPermission`
        // before clicking the toggle. The default ('default' → 'denied') is
        // the safe fallback for tests that forget to set it.
        if (currentPermission === 'default') currentPermission = 'denied';
        return currentPermission;
      }
      constructor(title: string, options?: NotificationOptions) {
        fired.push({ title, options });
      }
    }

    // Both `window.Notification` and `globalThis.Notification` are used by
    // various callers; assign both so the stub is reachable regardless.
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      writable: true,
      value: MockNotification,
    });

    const w = window as unknown as {
      __notifications: NotificationRecord[];
      __setNotificationPermission: (p: NotificationPermission) => void;
      __clearNotifications: () => void;
    };
    w.__notifications = fired;
    w.__clearNotifications = () => {
      fired.length = 0;
    };
    w.__setNotificationPermission = (p: NotificationPermission) => {
      currentPermission = p;
      for (const cb of permissionListeners) cb();
    };
  }, initialPermission);
}

// -- matchMedia for prefers-color-scheme --
// The PreferencesContext consults `prefers-color-scheme` via matchMedia and
// also subscribes to its `change` event when theme === 'system'. We replace
// the matcher with one that reads from a mutable flag and fires `change`
// listeners when the flag flips.
export async function installMatchMediaMock(page: Page, initialDark = false): Promise<void> {
  await page.addInitScript((dark) => {
    let systemDark = dark as boolean;
    const listeners: Array<(e: { matches: boolean }) => void> = [];

    const realMatchMedia = window.matchMedia.bind(window);

    window.matchMedia = (query: string): MediaQueryList => {
      // Only intercept the prefers-color-scheme query; pass everything else
      // through so unrelated CSS feature queries still work.
      if (query !== '(prefers-color-scheme: dark)') return realMatchMedia(query);

      const mql = {
        matches: systemDark,
        media: query,
        onchange: null,
        addEventListener: (_: string, cb: (e: { matches: boolean }) => void) => {
          listeners.push(cb);
        },
        removeEventListener: (_: string, cb: (e: { matches: boolean }) => void) => {
          const i = listeners.indexOf(cb);
          if (i >= 0) listeners.splice(i, 1);
        },
        addListener: (cb: (e: { matches: boolean }) => void) => {
          listeners.push(cb);
        },
        removeListener: (cb: (e: { matches: boolean }) => void) => {
          const i = listeners.indexOf(cb);
          if (i >= 0) listeners.splice(i, 1);
        },
        dispatchEvent: () => true,
      };
      return mql as unknown as MediaQueryList;
    };

    (window as unknown as { __setSystemDark: (v: boolean) => void }).__setSystemDark = (v: boolean) => {
      systemDark = v;
      for (const cb of listeners) cb({ matches: systemDark });
    };
  }, initialDark);
}

// -- Clipboard --
// Captures every `navigator.clipboard.writeText` call into `window.__clipboard`
// so tests can assert on copied text without depending on real clipboard
// permissions (which differ across browser engines and are flaky in CI).
export async function installClipboardMock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const writes: string[] = [];
    const w = window as unknown as { __clipboard: string[] };
    w.__clipboard = writes;

    // Override the writeText path. `readText` is left untouched — no caller
    // we test uses it.
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string) => {
          writes.push(text);
          return Promise.resolve();
        },
      },
    });
  });
}

// -- Reading captured state --

export async function getNotifications(page: Page): Promise<NotificationRecord[]> {
  return page.evaluate(() => (window as unknown as { __notifications: NotificationRecord[] }).__notifications ?? []);
}

export async function clearNotifications(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as { __clearNotifications?: () => void }).__clearNotifications?.());
}

export async function setNotificationPermission(page: Page, permission: NotificationPermission): Promise<void> {
  await page.evaluate(
    (p) =>
      (
        window as unknown as { __setNotificationPermission: (p: NotificationPermission) => void }
      ).__setNotificationPermission(p),
    permission,
  );
}

export async function setSystemDark(page: Page, dark: boolean): Promise<void> {
  await page.evaluate((d) => (window as unknown as { __setSystemDark: (v: boolean) => void }).__setSystemDark(d), dark);
}

export async function getClipboard(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __clipboard: string[] }).__clipboard ?? []);
}

export async function triggerFullscreenExit(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as { __triggerFullscreenExit: () => void }).__triggerFullscreenExit());
}
