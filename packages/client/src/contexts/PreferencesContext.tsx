/**
 * User preferences — keyboard-shortcut enablement, colour scheme, and the
 * open/close state of the Preferences modal. All values persist to
 * localStorage and are applied immediately.
 *
 * Lives at the App level because the hamburger (in UserMenu) renders on
 * multiple pages and needs to open the same modal regardless of route.
 */

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { getShortcutsEnabled, setShortcutsEnabled as persistShortcutsEnabled } from '../hooks/useKeyboardShortcuts.js';

export type Theme = 'light' | 'dark' | 'system';

const THEME_STORAGE_KEY = 'tcq-theme-preference';

function getTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch {
    // fall through to default
  }
  return 'system';
}

function persistTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Silently fail if localStorage is unavailable
  }
}

/** Apply the effective theme by toggling the `dark` class on <html>. */
function applyTheme(theme: Theme): void {
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const dark = theme === 'dark' || (theme === 'system' && systemDark);
  document.documentElement.classList.toggle('dark', dark);
}

interface PreferencesContextValue {
  shortcutsEnabled: boolean;
  setShortcutsEnabled: (enabled: boolean) => void;
  theme: Theme;
  setTheme: (theme: Theme) => void;
  showPreferences: boolean;
  openPreferences: () => void;
  closePreferences: () => void;
  togglePreferences: () => void;
}

const PreferencesContext = createContext<PreferencesContextValue | null>(null);

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [shortcutsEnabled, setShortcutsEnabledState] = useState(getShortcutsEnabled);
  const [theme, setThemeState] = useState<Theme>(getTheme);
  const [showPreferences, setShowPreferences] = useState(false);

  const setShortcutsEnabled = useCallback((enabled: boolean) => {
    setShortcutsEnabledState(enabled);
    persistShortcutsEnabled(enabled);
  }, []);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    persistTheme(next);
    applyTheme(next);
  }, []);

  // When theme is 'system', react to OS colour-scheme changes live.
  useEffect(() => {
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    function onChange() {
      applyTheme('system');
    }
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme]);

  const openPreferences = useCallback(() => setShowPreferences(true), []);
  const closePreferences = useCallback(() => setShowPreferences(false), []);
  const togglePreferences = useCallback(() => setShowPreferences((v) => !v), []);

  const value: PreferencesContextValue = {
    shortcutsEnabled,
    setShortcutsEnabled,
    theme,
    setTheme,
    showPreferences,
    openPreferences,
    closePreferences,
    togglePreferences,
  };

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function usePreferences(): PreferencesContextValue {
  const ctx = useContext(PreferencesContext);
  if (!ctx) throw new Error('usePreferences must be used within a PreferencesProvider');
  return ctx;
}
