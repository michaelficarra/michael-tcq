import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CountUpTimer, formatElapsed } from './CountUpTimer.js';

describe('formatElapsed', () => {
  it('formats zero as 0:00', () => {
    expect(formatElapsed(0)).toBe('0:00');
  });

  it('formats seconds only', () => {
    expect(formatElapsed(45_000)).toBe('0:45');
  });

  it('formats minutes and seconds', () => {
    expect(formatElapsed(5 * 60_000 + 3_000)).toBe('5:03');
  });

  it('formats exactly one hour', () => {
    expect(formatElapsed(3600_000)).toBe('1:00:00');
  });

  it('formats hours, minutes, and seconds', () => {
    expect(formatElapsed(90 * 60_000 + 5_000)).toBe('1:30:05');
  });

  it('pads minutes with leading zero when hours present', () => {
    expect(formatElapsed(3600_000 + 5 * 60_000)).toBe('1:05:00');
  });

  it('treats negative values as 0:00', () => {
    expect(formatElapsed(-5000)).toBe('0:00');
  });
});

describe('CountUpTimer', () => {
  it('renders elapsed time from a recent timestamp', () => {
    const since = new Date(Date.now() - 65_000).toISOString(); // 1 min 5 sec ago
    render(<CountUpTimer since={since} />);
    expect(screen.getByText('1:05')).toBeInTheDocument();
  });

  it('renders elapsed time over an hour', () => {
    const since = new Date(Date.now() - (90 * 60_000 + 30_000)).toISOString();
    render(<CountUpTimer since={since} />);
    expect(screen.getByText('1:30:30')).toBeInTheDocument();
  });

  it('includes a title with the start time', () => {
    const since = new Date().toISOString();
    render(<CountUpTimer since={since} />);
    const el = screen.getByTitle(/^Since /);
    expect(el).toBeInTheDocument();
  });

  it('uses default styling when under the timebox', () => {
    const since = new Date(Date.now() - 60_000).toISOString(); // 1 min ago
    render(<CountUpTimer since={since} overAfterMinutes={5} />);
    const el = screen.getByText('1:00');
    expect(el.className).not.toContain('font-bold');
    expect(el.className).not.toContain('text-red');
  });

  it('switches to bold red when over the timebox', () => {
    const since = new Date(Date.now() - 6 * 60_000).toISOString(); // 6 min ago
    render(<CountUpTimer since={since} overAfterMinutes={5} />);
    const el = screen.getByText('6:00');
    expect(el.className).toContain('font-bold');
    expect(el.className).toContain('text-red-600');
  });

  it('does not apply over styling when no timebox is set', () => {
    const since = new Date(Date.now() - 60 * 60_000).toISOString(); // 1 hour ago
    render(<CountUpTimer since={since} />);
    const el = screen.getByText('1:00:00');
    expect(el.className).not.toContain('font-bold');
  });
});
