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
import { requestNotificationPermission } from '../lib/notifications.js';

export type Theme = 'light' | 'dark' | 'system';

export interface NotificationPrefs {
  /** Fire when a queue entry authored by the current user reaches the head of the queue. */
  onMyTurnToSpeak: boolean;
  /** Fire when the agenda item after the current one is owned by the current user. */
  onMyAgendaItemNext: boolean;
  /** Fire once when the meeting starts (the first agenda item becomes active). */
  onMeetingStarted: boolean;
  /** Fire when the current agenda item changes after the initial start. */
  onAgendaAdvance: boolean;
  /** Fire when a chair starts a poll. */
  onPollStarted: boolean;
  /** Fire when someone raises a clarifying question while you are the current topic author. */
  onClarifyingQuestionOnMyTopic: boolean;
  /** Fire when a new point-of-order entry is added (by someone other than you). */
  onPointOfOrder: boolean;
  /** Fire when the current agenda item crosses its timebox deadline. Off by default. */
  onAgendaItemOverrun: boolean;
}

const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  onMyTurnToSpeak: true,
  onMyAgendaItemNext: true,
  onMeetingStarted: true,
  onAgendaAdvance: true,
  onPollStarted: true,
  onClarifyingQuestionOnMyTopic: true,
  onPointOfOrder: false,
  onAgendaItemOverrun: false,
};

const THEME_STORAGE_KEY = 'tcq-theme-preference';
const NOTIFICATIONS_ENABLED_STORAGE_KEY = 'tcq-notifications-enabled';
const NOTIFICATION_PREFS_STORAGE_KEY = 'tcq-notification-prefs';

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

function getNotificationsEnabled(): boolean {
  try {
    const stored = localStorage.getItem(NOTIFICATIONS_ENABLED_STORAGE_KEY) === 'true';
    if (!stored) return false;
    // Reconcile with actual browser permission on load — if it was revoked in
    // browser settings since the last session, flip the preference back to off
    // so the UI doesn't claim notifications are on when they can't fire.
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
      localStorage.setItem(NOTIFICATIONS_ENABLED_STORAGE_KEY, 'false');
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function persistNotificationsEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(NOTIFICATIONS_ENABLED_STORAGE_KEY, String(enabled));
  } catch {
    // Silently fail if localStorage is unavailable
  }
}

function getNotificationPrefs(): NotificationPrefs {
  try {
    const stored = localStorage.getItem(NOTIFICATION_PREFS_STORAGE_KEY);
    if (!stored) return DEFAULT_NOTIFICATION_PREFS;
    const parsed = JSON.parse(stored) as Partial<NotificationPrefs>;
    return { ...DEFAULT_NOTIFICATION_PREFS, ...parsed };
  } catch {
    return DEFAULT_NOTIFICATION_PREFS;
  }
}

function persistNotificationPrefs(prefs: NotificationPrefs): void {
  try {
    localStorage.setItem(NOTIFICATION_PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Silently fail if localStorage is unavailable
  }
}

interface PreferencesContextValue {
  shortcutsEnabled: boolean;
  setShortcutsEnabled: (enabled: boolean) => void;
  theme: Theme;
  setTheme: (theme: Theme) => void;
  notificationsEnabled: boolean;
  /** Enable/disable notifications at the top level. When enabling, this prompts
   *  for browser permission; if the user denies, `notificationsEnabled` stays `false`. */
  setNotificationsEnabled: (enabled: boolean) => Promise<void>;
  notificationPrefs: NotificationPrefs;
  setNotificationPrefs: (prefs: NotificationPrefs) => void;
  showPreferences: boolean;
  openPreferences: () => void;
  closePreferences: () => void;
  togglePreferences: () => void;
}

const PreferencesContext = createContext<PreferencesContextValue | null>(null);

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [shortcutsEnabled, setShortcutsEnabledState] = useState(getShortcutsEnabled);
  const [theme, setThemeState] = useState<Theme>(getTheme);
  const [notificationsEnabled, setNotificationsEnabledState] = useState(getNotificationsEnabled);
  const [notificationPrefs, setNotificationPrefsState] = useState<NotificationPrefs>(getNotificationPrefs);
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

  // Enabling prompts for browser permission; if the user doesn't grant it, we
  // leave the preference off so UI never claims notifications are on without
  // actually being allowed to fire them.
  const setNotificationsEnabled = useCallback(async (enabled: boolean) => {
    if (!enabled) {
      setNotificationsEnabledState(false);
      persistNotificationsEnabled(false);
      return;
    }
    const permission = await requestNotificationPermission();
    if (permission === 'granted') {
      setNotificationsEnabledState(true);
      persistNotificationsEnabled(true);
    } else {
      setNotificationsEnabledState(false);
      persistNotificationsEnabled(false);
    }
  }, []);

  const setNotificationPrefs = useCallback((prefs: NotificationPrefs) => {
    setNotificationPrefsState(prefs);
    persistNotificationPrefs(prefs);
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
    notificationsEnabled,
    setNotificationsEnabled,
    notificationPrefs,
    setNotificationPrefs,
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
