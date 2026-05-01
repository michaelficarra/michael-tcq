import { describe, it, expect } from 'vitest';
import { formatDeadline } from './timeFormat.js';

// All timestamps below are constructed via `new Date(y, m, d, h, m)` which
// interprets its arguments in the viewer's local time zone — that's the
// same zone formatDeadline operates in, so calendar-day deltas are
// deterministic regardless of where the test runs.

describe('formatDeadline', () => {
  it('returns just HH:MM when the deadline is later the same local day', () => {
    const now = new Date(2026, 4, 1, 9, 0, 0); // 1 May 09:00 local
    const deadline = new Date(2026, 4, 1, 17, 30, 0); // 1 May 17:30 local
    const out = formatDeadline(deadline.toISOString(), now.getTime());
    expect(out).toMatch(/^\d{1,2}:\d{2}(\s?[AP]M)?$/);
    expect(out).not.toMatch(/tomorrow|\bon\b/);
  });

  it('appends "tomorrow" when the deadline is on the next local day', () => {
    const now = new Date(2026, 4, 1, 23, 30, 0); // 1 May 23:30 local
    const deadline = new Date(2026, 4, 2, 0, 30, 0); // 2 May 00:30 local
    const out = formatDeadline(deadline.toISOString(), now.getTime());
    expect(out).toMatch(/^\d{1,2}:\d{2}(\s?[AP]M)?\s+tomorrow$/);
  });

  it('appends an "on <date>" suffix when the deadline is two or more days out', () => {
    const now = new Date(2026, 4, 1, 12, 0, 0); // 1 May 12:00 local
    const deadline = new Date(2026, 4, 4, 9, 0, 0); // 4 May 09:00 local — 3 days out
    const out = formatDeadline(deadline.toISOString(), now.getTime());
    expect(out).toMatch(/^\d{1,2}:\d{2}(\s?[AP]M)?\s+on\s+.+/);
    // Don't pin to a specific weekday/month string: exact wording depends
    // on the runner's locale. Just confirm there's some text after "on ".
    expect(out).not.toMatch(/tomorrow/);
  });

  it('returns just HH:MM (no suffix) when the deadline is earlier the same day', () => {
    // Defensive: dayDiff <= 0 includes the (theoretically impossible from
    // CountUpTimer's caller) case where the deadline is in the past.
    const now = new Date(2026, 4, 1, 18, 0, 0);
    const deadline = new Date(2026, 4, 1, 9, 0, 0);
    const out = formatDeadline(deadline.toISOString(), now.getTime());
    expect(out).not.toMatch(/tomorrow|\bon\b/);
  });
});
