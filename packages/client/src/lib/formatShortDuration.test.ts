import { describe, it, expect } from 'vitest';
import { formatShortDuration } from '@tcq/shared';

describe('formatShortDuration', () => {
  it('renders 0 as "0m"', () => {
    expect(formatShortDuration(0)).toBe('0m');
  });

  it('renders sub-hour durations in minutes only', () => {
    expect(formatShortDuration(1)).toBe('1m');
    expect(formatShortDuration(45)).toBe('45m');
    expect(formatShortDuration(59)).toBe('59m');
  });

  it('renders exact-hour durations without the minutes part', () => {
    expect(formatShortDuration(60)).toBe('1h');
    expect(formatShortDuration(120)).toBe('2h');
    expect(formatShortDuration(1440)).toBe('24h');
  });

  it('renders hour-plus-minute durations compactly', () => {
    expect(formatShortDuration(61)).toBe('1h1m');
    expect(formatShortDuration(90)).toBe('1h30m');
    expect(formatShortDuration(315)).toBe('5h15m');
  });

  it('renders negative durations with a leading minus', () => {
    expect(formatShortDuration(-15)).toBe('-15m');
    expect(formatShortDuration(-60)).toBe('-1h');
    expect(formatShortDuration(-90)).toBe('-1h30m');
  });
});
