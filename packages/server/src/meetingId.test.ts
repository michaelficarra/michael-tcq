import { describe, it, expect } from 'vitest';
import { generateMeetingId } from './meetingId.js';

describe('generateMeetingId', () => {
  it('produces a three-word lowercase hyphenated ID', () => {
    const id = generateMeetingId(() => false);
    const parts = id.split('-');
    expect(parts.length).toBe(3);
    for (const part of parts) {
      expect(part).toMatch(/^[a-z]+$/);
    }
  });

  it('produces different IDs on subsequent calls', () => {
    // With 15M+ combinations, getting duplicates in 20 tries is near-impossible
    const ids = new Set<string>();
    for (let i = 0; i < 20; i++) {
      ids.add(generateMeetingId(() => false));
    }
    expect(ids.size).toBeGreaterThan(1);
  });

  it('avoids collisions by retrying', () => {
    const existing = new Set<string>();

    // Record the first ID as "existing"
    const first = generateMeetingId(() => false);
    existing.add(first);

    // Second call rejects any ID that matches the first one
    const second = generateMeetingId((candidate) => existing.has(candidate));
    expect(second).not.toBe(first);
  });

  it('only contains lowercase letters and hyphens', () => {
    for (let i = 0; i < 50; i++) {
      const id = generateMeetingId(() => false);
      expect(id).toMatch(/^[a-z]+(-[a-z]+)+$/);
    }
  });
});
