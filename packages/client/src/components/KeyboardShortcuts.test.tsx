import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { KeyboardShortcuts } from './KeyboardShortcuts.js';
import { PreferencesModal } from './PreferencesModal.js';
import { PreferencesProvider } from '../contexts/PreferencesContext.js';
import type { Shortcut } from '../hooks/useKeyboardShortcuts.js';

/** Simulate a keydown on the window, where the shortcut listener lives.
 *  Wrapped in act() so the resulting state update flushes before assertions. */
function pressKey(key: string) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

/** Renders the component alongside the real PreferencesModal, mirroring the
 *  app tree — the modal is what the `,` shortcut ultimately opens. */
function renderShortcuts(props: { pageShortcuts?: Shortcut[]; isChair?: boolean } = {}) {
  return render(
    <PreferencesProvider>
      <KeyboardShortcuts {...props} />
      <PreferencesModal />
    </PreferencesProvider>,
  );
}

const shortcutsDialog = () => screen.queryByRole('dialog', { name: 'Keyboard shortcuts' });
const preferencesDialog = () => screen.queryByRole('dialog', { name: 'Preferences' });

beforeEach(() => {
  localStorage.clear();
});

describe('KeyboardShortcuts', () => {
  describe('the General group, available on every authenticated surface', () => {
    it('opens the shortcuts dialogue on "?"', () => {
      renderShortcuts();
      expect(shortcutsDialog()).not.toBeInTheDocument();

      pressKey('?');

      expect(shortcutsDialog()).toBeInTheDocument();
    });

    it('opens the preferences modal on ","', () => {
      renderShortcuts();
      expect(preferencesDialog()).not.toBeInTheDocument();

      pressKey(',');

      expect(preferencesDialog()).toBeInTheDocument();
    });

    it('lists only the General shortcuts when the page contributes none', () => {
      renderShortcuts();
      pressKey('?');

      const dialog = shortcutsDialog()!;
      expect(dialog).toHaveTextContent('General');
      // One row per key: '?' and ',' and nothing else.
      const keys = [...dialog.querySelectorAll('kbd')].map((el) => el.textContent);
      expect(keys).toEqual(['?', ',']);
    });
  });

  describe('page-specific shortcuts', () => {
    // Module-scope constant rather than an inline literal: the component
    // memoises on this identity, so a fresh array per render would resubscribe.
    const pageShortcuts: Shortcut[] = [
      { key: 'n', description: 'New Topic', action: vi.fn(), category: 'Queue' },
      { key: 's', description: 'Next speaker (chair only)', action: vi.fn(), category: 'Queue', chairOnly: true },
    ];

    it('fires the page action for its key', () => {
      const action = vi.fn();
      renderShortcuts({ pageShortcuts: [{ key: 'n', description: 'New Topic', action, category: 'Queue' }] });

      pressKey('n');

      expect(action).toHaveBeenCalledTimes(1);
    });

    it('lists page shortcuts above the General group', () => {
      renderShortcuts({ pageShortcuts, isChair: true });
      pressKey('?');

      const keys = [...shortcutsDialog()!.querySelectorAll('kbd')].map((el) => el.textContent);
      expect(keys).toEqual(['n', 's', '?', ',']);
    });

    it('hides chair-only shortcuts from non-chairs', () => {
      renderShortcuts({ pageShortcuts, isChair: false });
      pressKey('?');

      const dialog = shortcutsDialog()!;
      expect(dialog).toHaveTextContent('New Topic');
      expect(dialog).not.toHaveTextContent('Next speaker');
    });
  });

  describe('when shortcuts are disabled', () => {
    beforeEach(() => {
      localStorage.setItem('tcq-keyboard-shortcuts-enabled', 'false');
    });

    it('does not act on "?" or ","', () => {
      renderShortcuts();

      pressKey('?');
      pressKey(',');

      expect(shortcutsDialog()).not.toBeInTheDocument();
      expect(preferencesDialog()).not.toBeInTheDocument();
    });
  });
});
