import { describe, it, expect } from 'vitest';
import { formatDuration, type DurationParts, type DurationStyle } from '@tcq/shared';

// For non-zero durations the helper just delegates to Intl.DurationFormat, so we
// assert against a freshly-computed reference rather than pinning locale-specific
// strings (the runner's locale could differ). The zero/omission behaviour and the
// hand-written fallback labels are the helper's own logic, so those we pin exactly.
const native = (parts: DurationParts, style: DurationStyle) =>
  new Intl.DurationFormat(undefined, { style }).format(parts);

describe('formatDuration', () => {
  it('matches Intl.DurationFormat for single-unit durations', () => {
    expect(formatDuration({ minutes: 45 }, 'narrow')).toBe(native({ minutes: 45 }, 'narrow'));
    expect(formatDuration({ hours: 2 }, 'narrow')).toBe(native({ hours: 2 }, 'narrow'));
    expect(formatDuration({ seconds: 45 }, 'short')).toBe(native({ seconds: 45 }, 'short'));
  });

  it('matches Intl.DurationFormat for multi-unit durations', () => {
    expect(formatDuration({ hours: 1, minutes: 30 }, 'narrow')).toBe(native({ hours: 1, minutes: 30 }, 'narrow'));
    expect(formatDuration({ days: 2, hours: 3, minutes: 15 }, 'narrow')).toBe(
      native({ days: 2, hours: 3, minutes: 15 }, 'narrow'),
    );
    expect(formatDuration({ hours: 1, minutes: 5 }, 'short')).toBe(native({ hours: 1, minutes: 5 }, 'short'));
  });

  it('omits zero-valued units (like the native formatter)', () => {
    expect(formatDuration({ days: 2, hours: 0, minutes: 15 }, 'narrow')).toBe(
      native({ days: 2, hours: 0, minutes: 15 }, 'narrow'),
    );
  });

  it('renders an all-zero duration as "0" plus the smallest requested unit', () => {
    // Intl.DurationFormat returns "" for an all-zero duration, so the helper
    // falls back to an explicit zero label keyed off the smallest unit present.
    expect(formatDuration({ minutes: 0 }, 'narrow')).toBe('0m');
    expect(formatDuration({ hours: 0, minutes: 0 }, 'narrow')).toBe('0m');
    expect(formatDuration({ seconds: 0 }, 'short')).toBe('0 sec');
    expect(formatDuration({ seconds: 0 }, 'narrow')).toBe('0s');
  });
});
