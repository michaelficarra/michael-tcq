/**
 * Owns the keyboard shortcuts available on every authenticated surface —
 * `?` (this dialogue) and `,` (preferences) — registers them alongside
 * whatever page-specific shortcuts the caller passes, and renders the help
 * dialogue listing the combined set.
 *
 * Rendered by HomePage (the General group alone) and MeetingPage (General
 * plus its queue / navigation / display shortcuts). Deliberately not rendered
 * on the login page: neither the preferences modal nor this dialogue has an
 * opener there, so the keys would have nothing useful to act on.
 *
 * Exactly one route component is mounted at a time, so there is never more
 * than one instance competing for the same keys.
 */

import { useMemo, useState } from 'react';
import { usePreferences } from '../contexts/PreferencesContext.js';
import { useKeyboardShortcuts, type Shortcut } from '../hooks/useKeyboardShortcuts.js';
import { KeyboardShortcutsDialog } from './KeyboardShortcutsDialog.js';

// Stable identity for the default: a fresh [] on each render would change the
// useMemo dependency every time and re-subscribe the window keydown listener.
const NO_PAGE_SHORTCUTS: Shortcut[] = [];

interface KeyboardShortcutsProps {
  /**
   * Page-specific shortcuts, listed above the General group in the dialogue.
   * Memoise at the call site — the identity feeds the listener subscription.
   */
  pageShortcuts?: Shortcut[];
  /** Whether `chairOnly` shortcuts are listed in the dialogue. */
  isChair?: boolean;
}

export function KeyboardShortcuts({ pageShortcuts = NO_PAGE_SHORTCUTS, isChair = false }: KeyboardShortcutsProps) {
  const { shortcutsEnabled, setShortcutsEnabled, togglePreferences } = usePreferences();
  const [showShortcuts, setShowShortcuts] = useState(false);

  const shortcuts = useMemo<Shortcut[]>(
    () => [
      ...pageShortcuts,
      {
        key: '?',
        description: 'Toggle shortcuts dialogue',
        action: () => setShowShortcuts((v) => !v),
        category: 'General',
      },
      { key: ',', description: 'Toggle preferences dialogue', action: () => togglePreferences(), category: 'General' },
      // Esc is handled natively by each modal <dialog> (and the
      // useKeyboardShortcuts `dialog[open]` guard lets the platform own the
      // key), so no explicit Escape shortcut is needed to close dialogs.
    ],
    [pageShortcuts, togglePreferences],
  );

  useKeyboardShortcuts(shortcuts, shortcutsEnabled);

  return (
    /* Always mounted; `open` drives the native <dialog> via showModal()/close(). */
    <KeyboardShortcutsDialog
      open={showShortcuts}
      shortcuts={shortcuts.filter((s) => isChair || !s.chairOnly)}
      enabled={shortcutsEnabled}
      onToggleEnabled={() => setShortcutsEnabled(!shortcutsEnabled)}
      onClose={() => setShowShortcuts(false)}
    />
  );
}
