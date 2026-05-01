import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CountUpTimer, formatElapsed } from './CountUpTimer.js';
import { formatFullTimestamp } from '../lib/timeFormat.js';

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

  it('uses default styling when under the estimate', () => {
    const since = new Date(Date.now() - 60_000).toISOString(); // 1 min ago
    render(<CountUpTimer since={since} overAfterMinutes={5} />);
    const el = screen.getByText('1:00');
    expect(el.className).not.toContain('font-bold');
    expect(el.className).not.toContain('text-red');
  });

  it('switches to bold red when over the estimate', () => {
    const since = new Date(Date.now() - 6 * 60_000).toISOString(); // 6 min ago
    render(<CountUpTimer since={since} overAfterMinutes={5} />);
    const el = screen.getByText('6:00');
    expect(el.className).toContain('font-bold');
    expect(el.className).toContain('text-red-600');
  });

  it('does not apply over styling when no estimate is set', () => {
    const since = new Date(Date.now() - 60 * 60_000).toISOString(); // 1 hour ago
    render(<CountUpTimer since={since} />);
    const el = screen.getByText('1:00:00');
    expect(el.className).not.toContain('font-bold');
  });
});

// -- Timebox-end annotation --
// Tests below use vi.setSystemTime to pin "now" so that the relationship
// between `since`, `overAfterMinutes`, and the local calendar day is
// deterministic. Date constructors with multiple args use local time, so
// day-diff assertions hold regardless of the runner's TZ.

describe('CountUpTimer timebox annotation', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders no annotation when no estimate is set', () => {
    vi.setSystemTime(new Date(2026, 4, 1, 9, 0, 0));
    const since = new Date(2026, 4, 1, 8, 30, 0).toISOString();
    render(<CountUpTimer since={since} />);
    expect(screen.queryByText(/expected to end by|exceeded estimate/)).toBeNull();
  });

  it('renders no annotation when the estimate is zero', () => {
    vi.setSystemTime(new Date(2026, 4, 1, 9, 0, 0));
    const since = new Date(2026, 4, 1, 8, 30, 0).toISOString();
    render(<CountUpTimer since={since} overAfterMinutes={0} />);
    expect(screen.queryByText(/expected to end by|exceeded estimate/)).toBeNull();
  });

  it('shows "expected to end by HH:MM" when under the estimate, same day', () => {
    vi.setSystemTime(new Date(2026, 4, 1, 9, 0, 0));
    const since = new Date(2026, 4, 1, 8, 50, 0).toISOString(); // 10 min ago
    render(<CountUpTimer since={since} overAfterMinutes={60} />);
    // 10 min elapsed of a 60-min estimate, deadline 09:50 local → same day.
    expect(screen.getByText(/expected to end by \d{1,2}:\d{2}/)).toBeInTheDocument();
    expect(screen.queryByText(/tomorrow|\bon\b/)).toBeNull();
  });

  it('shows "expected to end by HH:MM tomorrow" when the deadline crosses midnight', () => {
    vi.setSystemTime(new Date(2026, 4, 1, 23, 30, 0));
    const since = new Date(2026, 4, 1, 23, 30, 0).toISOString(); // started just now
    render(<CountUpTimer since={since} overAfterMinutes={60} />);
    // Deadline = 00:30 next day local.
    expect(screen.getByText(/expected to end by \d{1,2}:\d{2}.*tomorrow/)).toBeInTheDocument();
  });

  it('shows "expected to end by HH:MM on <date>" when the deadline is multiple days out', () => {
    vi.setSystemTime(new Date(2026, 4, 1, 12, 0, 0));
    const since = new Date(2026, 4, 1, 12, 0, 0).toISOString();
    render(<CountUpTimer since={since} overAfterMinutes={60 * 24 * 3} />); // 3 days
    expect(screen.getByText(/expected to end by \d{1,2}:\d{2}.* on .+/)).toBeInTheDocument();
    expect(screen.queryByText(/tomorrow/)).toBeNull();
  });

  it('shows "exceeded estimate <relative> ago" with a full-timestamp tooltip when over', () => {
    vi.setSystemTime(new Date(2026, 4, 1, 10, 0, 0));
    // Started 1h ago; estimate was 30 min → exceeded 30 min ago.
    const since = new Date(2026, 4, 1, 9, 0, 0).toISOString();
    const deadlineIso = new Date(2026, 4, 1, 9, 30, 0).toISOString();
    render(<CountUpTimer since={since} overAfterMinutes={30} />);
    const annotation = screen.getByText(/exceeded estimate .+ ago/);
    expect(annotation).toBeInTheDocument();
    // Tooltip is the full deadline timestamp, not the start time.
    expect(annotation).toHaveAttribute('title', formatFullTimestamp(deadlineIso));
  });

  it('shows "exceeded estimate Nd ago" for multi-day overruns (relativeTime fallback)', () => {
    vi.setSystemTime(new Date(2026, 4, 5, 12, 0, 0));
    // Started 4 days ago, estimate was 60 min → exceeded ~4 days ago.
    const since = new Date(2026, 4, 1, 11, 0, 0).toISOString();
    render(<CountUpTimer since={since} overAfterMinutes={60} />);
    expect(screen.getByText(/exceeded estimate \d+d ago/)).toBeInTheDocument();
  });

  it('annotation is not bolded red even when the elapsed timer is over', () => {
    vi.setSystemTime(new Date(2026, 4, 1, 10, 0, 0));
    const since = new Date(2026, 4, 1, 9, 0, 0).toISOString();
    render(<CountUpTimer since={since} overAfterMinutes={30} />);
    const annotation = screen.getByText(/exceeded estimate/);
    expect(annotation.className).not.toContain('font-bold');
    expect(annotation.className).not.toContain('text-red');
  });
});
