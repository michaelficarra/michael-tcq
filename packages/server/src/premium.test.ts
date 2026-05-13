import { describe, it, expect, afterEach, vi } from 'vitest';
import type { User } from '@tcq/shared';
import { isPremium } from './premium.js';

function user(ghUsername: string): User {
  return { ghid: 1, ghUsername, name: ghUsername, organisation: '' };
}

describe('isPremium', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns true when the username matches an entry in PREMIUM_USERNAMES', () => {
    vi.stubEnv('PREMIUM_USERNAMES', 'alice,bob,carol');
    expect(isPremium(user('alice'))).toBe(true);
    expect(isPremium(user('bob'))).toBe(true);
    expect(isPremium(user('carol'))).toBe(true);
  });

  it('is case-insensitive on both sides', () => {
    vi.stubEnv('PREMIUM_USERNAMES', 'Alice,BOB');
    expect(isPremium(user('ALICE'))).toBe(true);
    expect(isPremium(user('bob'))).toBe(true);
  });

  it('tolerates whitespace around entries', () => {
    vi.stubEnv('PREMIUM_USERNAMES', '  alice ,  bob  ');
    expect(isPremium(user('alice'))).toBe(true);
    expect(isPremium(user('bob'))).toBe(true);
  });

  it('returns false when the username is not in the list', () => {
    vi.stubEnv('PREMIUM_USERNAMES', 'alice,bob');
    expect(isPremium(user('carol'))).toBe(false);
  });

  it('returns false when PREMIUM_USERNAMES is unset', () => {
    vi.stubEnv('PREMIUM_USERNAMES', '');
    expect(isPremium(user('alice'))).toBe(false);
  });
});
