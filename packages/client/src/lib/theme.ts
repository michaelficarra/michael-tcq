/**
 * Colour-scheme preference: the stored value, its persistence, and how it maps
 * onto the `dark` class that Tailwind's `dark:` variant keys off.
 *
 * Lives outside PreferencesContext so `main.tsx` can apply the stored
 * preference eagerly — before React renders, to avoid a flash of light content
 * — without duplicating the computation.
 */

/** Every selectable theme, in the order the Preferences modal lists them. */
export const THEMES = ['light', 'dark', 'system', 'inverse-system', 'random', 'inverse-random'] as const;

export type Theme = (typeof THEMES)[number];

export const THEME_STORAGE_KEY = 'tcq-theme-preference';

// Kept as a single constant because the e2e matchMedia mock intercepts this
// exact string; a divergence here would silently bypass the mock.
const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)';

/**
 * One coin flip per page load, shared by `random` and `inverse-random` so the
 * two always resolve to exact opposites of each other. Drawn at module init
 * rather than per call, so re-applying the same preference (switching between
 * the two in the modal, an OS change) reads a stable value instead of
 * re-rolling; a reload draws afresh.
 */
const randomDark = Math.random() < 0.5;

/** The inputs a preference can be resolved against, threaded in so the resolution stays pure. */
interface SchemeInputs {
  /** Whether the OS reports `prefers-color-scheme: dark`. */
  systemDark: boolean;
  /** This page load's coin flip. */
  randomDark: boolean;
}

function isTheme(value: string | null): value is Theme {
  return (THEMES as readonly (string | null)[]).includes(value);
}

/** The stored preference, or `'system'` if absent, unrecognised, or unreadable. */
export function getTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (isTheme(stored)) return stored;
  } catch {
    // fall through to default
  }
  return 'system';
}

export function persistTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Silently fail if localStorage is unavailable
  }
}

/**
 * Whether the effective scheme is derived from the OS setting, and so has to be
 * recomputed whenever that setting changes.
 */
export function tracksSystem(theme: Theme): boolean {
  return theme === 'system' || theme === 'inverse-system';
}

/** Resolve a preference to a concrete scheme. */
export function resolveDark(theme: Theme, inputs: SchemeInputs): boolean {
  switch (theme) {
    case 'light':
      return false;
    case 'dark':
      return true;
    case 'system':
      return inputs.systemDark;
    case 'inverse-system':
      return !inputs.systemDark;
    case 'random':
      return inputs.randomDark;
    case 'inverse-random':
      return !inputs.randomDark;
  }
}

/** Apply the effective theme by toggling the `dark` class on <html>. */
export function applyTheme(theme: Theme): void {
  const systemDark = window.matchMedia(SYSTEM_DARK_QUERY).matches;
  document.documentElement.classList.toggle('dark', resolveDark(theme, { systemDark, randomDark }));
}

/** Subscribe to OS colour-scheme changes. Returns an unsubscribe function. */
export function watchSystemDark(onChange: () => void): () => void {
  const mq = window.matchMedia(SYSTEM_DARK_QUERY);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}
