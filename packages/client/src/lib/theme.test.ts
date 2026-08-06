import { describe, it, expect, beforeEach } from 'vitest';
import { THEMES, applyTheme, getTheme, persistTheme, resolveDark, tracksSystem, type Theme } from './theme.js';

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove('dark');
});

describe('resolveDark', () => {
  // The full preference × OS-setting truth table, with the coin flip pinned to
  // each value in turn so the random pair is covered deterministically.
  const cases: [Theme, boolean, boolean, boolean][] = [
    // theme, systemDark, randomDark, expected
    ['light', false, false, false],
    ['light', true, true, false],
    ['dark', false, false, true],
    ['dark', true, true, true],
    ['system', false, false, false],
    ['system', true, false, true],
    ['inverse-system', false, false, true],
    ['inverse-system', true, false, false],
    ['random', false, false, false],
    ['random', true, true, true],
    ['inverse-random', false, false, true],
    ['inverse-random', true, true, false],
  ];

  for (const [theme, systemDark, randomDark, expected] of cases) {
    const given = `a ${systemDark ? 'dark' : 'light'} OS setting and a ${randomDark ? 'dark' : 'light'} coin flip`;
    it(`${theme} with ${given} resolves to ${expected ? 'dark' : 'light'}`, () => {
      expect(resolveDark(theme, { systemDark, randomDark })).toBe(expected);
    });
  }

  // The defining property of each inverse scheme: whatever its counterpart
  // resolves to, it resolves to the opposite, for every possible input.
  const inversePairs: [Theme, Theme][] = [
    ['system', 'inverse-system'],
    ['random', 'inverse-random'],
  ];

  for (const [theme, inverse] of inversePairs) {
    it(`${inverse} is always the opposite of ${theme}`, () => {
      for (const systemDark of [false, true]) {
        for (const randomDark of [false, true]) {
          const inputs = { systemDark, randomDark };
          expect(resolveDark(inverse, inputs)).toBe(!resolveDark(theme, inputs));
        }
      }
    });
  }
});

describe('tracksSystem', () => {
  it('is true only for the themes derived from the OS setting', () => {
    expect(THEMES.filter(tracksSystem)).toEqual(['system', 'inverse-system']);
  });
});

// The coin flip is module-level and unpredictable by design, so these assert
// the properties that hold whichever way it landed.
describe('applyTheme with the random schemes', () => {
  it('applies opposite palettes for random and inverse-random', () => {
    applyTheme('random');
    const drawnDark = document.documentElement.classList.contains('dark');

    applyTheme('inverse-random');
    expect(document.documentElement.classList.contains('dark')).toBe(!drawnDark);
  });

  it('keeps the same palette when random is re-applied within a page load', () => {
    applyTheme('random');
    const drawnDark = document.documentElement.classList.contains('dark');

    // A per-call Math.random() would fail this within a few iterations.
    for (let i = 0; i < 20; i++) {
      applyTheme('random');
      expect(document.documentElement.classList.contains('dark')).toBe(drawnDark);
    }
  });
});

describe('getTheme', () => {
  it('defaults to system when nothing is stored', () => {
    expect(getTheme()).toBe('system');
  });

  it('round-trips every selectable theme through localStorage', () => {
    for (const theme of THEMES) {
      persistTheme(theme);
      expect(getTheme()).toBe(theme);
    }
  });

  it('falls back to system for an unrecognised stored value', () => {
    // e.g. a preference written by a newer build, then rolled back.
    localStorage.setItem('tcq-theme-preference', 'solarized');
    expect(getTheme()).toBe('system');
  });
});
