import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  useKeyboardShortcuts,
  getShortcutsEnabled,
  setShortcutsEnabled,
  type Shortcut,
} from './useKeyboardShortcuts.js';

/** Simulate a keydown event on the window. */
function pressKey(key: string, opts?: Partial<KeyboardEventInit>) {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...opts }));
}

describe('useKeyboardShortcuts', () => {
  it('calls the action when a matching key is pressed', () => {
    const action = vi.fn();
    const shortcuts: Shortcut[] = [{ key: 'n', description: 'Test', action }];

    renderHook(() => useKeyboardShortcuts(shortcuts, true));

    pressKey('n');
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('does not call actions for non-matching keys', () => {
    const action = vi.fn();
    const shortcuts: Shortcut[] = [{ key: 'n', description: 'Test', action }];

    renderHook(() => useKeyboardShortcuts(shortcuts, true));

    pressKey('x');
    expect(action).not.toHaveBeenCalled();
  });

  it('ignores shortcuts when Ctrl is held', () => {
    const action = vi.fn();
    const shortcuts: Shortcut[] = [{ key: 'n', description: 'Test', action }];

    renderHook(() => useKeyboardShortcuts(shortcuts, true));

    pressKey('n', { ctrlKey: true });
    expect(action).not.toHaveBeenCalled();
  });

  it('ignores shortcuts when Alt is held', () => {
    const action = vi.fn();
    const shortcuts: Shortcut[] = [{ key: 'n', description: 'Test', action }];

    renderHook(() => useKeyboardShortcuts(shortcuts, true));

    pressKey('n', { altKey: true });
    expect(action).not.toHaveBeenCalled();
  });

  it('ignores shortcuts when Meta is held', () => {
    const action = vi.fn();
    const shortcuts: Shortcut[] = [{ key: 'n', description: 'Test', action }];

    renderHook(() => useKeyboardShortcuts(shortcuts, true));

    pressKey('n', { metaKey: true });
    expect(action).not.toHaveBeenCalled();
  });

  it('ignores shortcuts when typing in an input', () => {
    const action = vi.fn();
    const shortcuts: Shortcut[] = [{ key: 'n', description: 'Test', action }];

    renderHook(() => useKeyboardShortcuts(shortcuts, true));

    // Create an input and dispatch the event from it
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }));
    document.body.removeChild(input);

    expect(action).not.toHaveBeenCalled();
  });

  it('ignores shortcuts when typing in a textarea', () => {
    const action = vi.fn();
    const shortcuts: Shortcut[] = [{ key: 'n', description: 'Test', action }];

    renderHook(() => useKeyboardShortcuts(shortcuts, true));

    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }));
    document.body.removeChild(textarea);

    expect(action).not.toHaveBeenCalled();
  });

  it('does not fire non-alwaysActive shortcuts when disabled', () => {
    const action = vi.fn();
    const shortcuts: Shortcut[] = [{ key: 'n', description: 'Test', action }];

    renderHook(() => useKeyboardShortcuts(shortcuts, false));

    pressKey('n');
    expect(action).not.toHaveBeenCalled();
  });

  it('fires alwaysActive shortcuts even when disabled', () => {
    const action = vi.fn();
    const shortcuts: Shortcut[] = [{ key: '?', description: 'Help', action, alwaysActive: true }];

    renderHook(() => useKeyboardShortcuts(shortcuts, false));

    pressKey('?');
    expect(action).toHaveBeenCalledTimes(1);
  });
});

describe('getShortcutsEnabled / setShortcutsEnabled', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to true when nothing is stored', () => {
    expect(getShortcutsEnabled()).toBe(true);
  });

  it('returns true after being set to true', () => {
    setShortcutsEnabled(true);
    expect(getShortcutsEnabled()).toBe(true);
  });

  it('returns false after being set to false', () => {
    setShortcutsEnabled(false);
    expect(getShortcutsEnabled()).toBe(false);
  });

  it('persists across calls', () => {
    setShortcutsEnabled(false);
    // Simulate a fresh read
    expect(getShortcutsEnabled()).toBe(false);
    setShortcutsEnabled(true);
    expect(getShortcutsEnabled()).toBe(true);
  });
});
