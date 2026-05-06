import { describe, it, expect } from 'vitest';
import { DEV_USERS } from '@tcq/shared';
import { mockUserFromLogin } from './mockUser.js';

describe('mockUserFromLogin', () => {
  it('falls back to login as name and empty organisation when not in the seed', () => {
    // Pick a login that's vanishingly unlikely to be in the TC39 seed.
    const login = '__not_a_real_tc39_member_for_tests__';
    const user = mockUserFromLogin(login);
    expect(user.ghUsername).toBe(login);
    expect(user.name).toBe(login);
    expect(user.organisation).toBe('');
    // Deterministic ghid — running again returns the same id.
    expect(mockUserFromLogin(login).ghid).toBe(user.ghid);
  });

  it('produces a stable, non-zero ghid that differs between distinct logins', () => {
    const a = mockUserFromLogin('alpha-test-login');
    const b = mockUserFromLogin('beta-test-login');
    expect(a.ghid).toBeGreaterThan(0);
    expect(b.ghid).toBeGreaterThan(0);
    expect(a.ghid).not.toBe(b.ghid);
  });

  it('uses real name and organisation from the seed when the login matches', () => {
    // The seed list is generated from the live tc39 GitHub org. Pick the
    // first entry that has BOTH a non-fallback name and a non-empty
    // organisation so the test exercises both fields. If neither field
    // is populated yet (e.g. the seed was generated before the GraphQL
    // refresh ran), the assertion is skipped — the helper still works,
    // we just don't have data to exercise the lookup branch.
    const enriched = DEV_USERS.find((u) => u.name !== u.login && (u.organisation ?? '') !== '');
    if (!enriched) return;
    const user = mockUserFromLogin(enriched.login);
    expect(user.ghUsername).toBe(enriched.login);
    expect(user.name).toBe(enriched.name);
    expect(user.organisation).toBe(enriched.organisation);
  });

  it('matches seed entries case-insensitively on the login', () => {
    const sample = DEV_USERS[0];
    if (!sample) return;
    const upper = mockUserFromLogin(sample.login.toUpperCase());
    // The display name comes from the seed even though the input case
    // didn't match exactly. The ghUsername preserves the caller's case.
    expect(upper.name).toBe(sample.name);
    expect(upper.ghUsername).toBe(sample.login.toUpperCase());
  });
});
