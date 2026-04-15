/**
 * Hook that registers global keyboard shortcuts for the meeting page.
 *
 * Shortcuts are ignored when the user is typing in an input, textarea,
 * or contenteditable element, or when shortcuts are disabled.
 */

import { useEffect } from 'react';

export interface Shortcut {
  /** The key to listen for (e.g. 'n', '?', 'a'). */
  key: string;
  /** Human-readable description shown in the help dialog. */
  description: string;
  /** Callback when the shortcut is triggered. */
  action: () => void;
  /** If true, this shortcut fires even when shortcuts are globally disabled.
   *  Used for '?' (to re-open the dialog) and Escape. */
  alwaysActive?: boolean;
  /** Category label for grouping in the help dialog. */
  category?: string;
  /** If true, this shortcut is only shown to chairs. */
  chairOnly?: boolean;
}

/**
 * Register global keyboard shortcuts. Shortcuts are suppressed when
 * focus is inside a text input, textarea, or contenteditable element.
 *
 * @param shortcuts - The list of shortcuts to register.
 * @param enabled - When false, only shortcuts with `alwaysActive` fire.
 */
export function useKeyboardShortcuts(shortcuts: Shortcut[], enabled: boolean) {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Don't trigger shortcuts when typing in form fields
      const target = e.target as HTMLElement;
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable
      ) {
        return;
      }

      // Don't trigger on modifier keys (Ctrl, Alt, Meta)
      if (e.ctrlKey || e.altKey || e.metaKey) return;

      const shortcut = shortcuts.find((s) => s.key === e.key);
      if (!shortcut) return;

      // When disabled, only fire shortcuts marked as alwaysActive
      if (!enabled && !shortcut.alwaysActive) return;

      e.preventDefault();
      shortcut.action();
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [shortcuts, enabled]);
}

/** localStorage key for the shortcuts enabled preference. */
const STORAGE_KEY = 'tcq-keyboard-shortcuts-enabled';

/** Read the shortcuts enabled preference from localStorage. Defaults to true. */
export function getShortcutsEnabled(): boolean {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === null ? true : stored === 'true';
  } catch {
    return true;
  }
}

/** Persist the shortcuts enabled preference to localStorage. */
export function setShortcutsEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(enabled));
  } catch {
    // Silently fail if localStorage is unavailable
  }
}
