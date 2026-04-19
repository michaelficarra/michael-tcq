/**
 * Preferences modal — currently exposes the keyboard-shortcuts toggle and
 * a light/dark/system theme selector. Reached from the hamburger menu or
 * via the `,` keyboard shortcut.
 *
 * Persists changes to localStorage immediately (no Save button). Modal
 * positioning matches KeyboardShortcutsDialog so the nav bar stays visible.
 */

import { useEffect } from 'react';
import { usePreferences, type Theme } from '../contexts/PreferencesContext.js';

const THEME_OPTIONS: { value: Theme; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
];

export function PreferencesModal() {
  const { showPreferences, closePreferences, shortcutsEnabled, setShortcutsEnabled, theme, setTheme } =
    usePreferences();

  // Dismiss on Escape while open.
  useEffect(() => {
    if (!showPreferences) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') closePreferences();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [showPreferences, closePreferences]);

  if (!showPreferences) return null;

  return (
    // Backdrop — `top-[3rem]` keeps the nav bar uncovered.
    <div
      className="fixed inset-0 top-[3rem] bg-black/30 flex items-center justify-center z-40"
      onClick={closePreferences}
      role="dialog"
      aria-label="Preferences"
      aria-modal="true"
    >
      <div
        className="bg-white dark:bg-stone-900 rounded-lg shadow-lg dark:shadow-stone-950/50 border border-stone-200 dark:border-stone-700 p-6 max-w-md w-full mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-stone-800 dark:text-stone-200">Preferences</h2>
          <button
            onClick={closePreferences}
            className="text-stone-400 dark:text-stone-500 hover:text-stone-600 dark:hover:text-stone-300 cursor-pointer text-lg"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <section className="mb-4">
          <label className="inline-flex items-center gap-2 text-sm font-medium text-stone-700 dark:text-stone-300 cursor-pointer">
            Keyboard shortcuts
            <input
              type="checkbox"
              checked={shortcutsEnabled}
              onChange={(e) => setShortcutsEnabled(e.target.checked)}
              className="cursor-pointer"
            />
          </label>
        </section>

        <section>
          <label className="flex items-center gap-3 text-sm text-stone-700 dark:text-stone-300">
            <span className="font-medium">Colour scheme</span>
            <select
              value={theme}
              onChange={(e) => setTheme(e.target.value as Theme)}
              className="border border-stone-300 dark:border-stone-600 rounded px-2 py-1 text-sm
                         bg-white dark:bg-stone-800 text-stone-700 dark:text-stone-200 cursor-pointer
                         focus:outline-none focus:ring-1 focus:ring-teal-500"
            >
              {THEME_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </section>
      </div>
    </div>
  );
}
