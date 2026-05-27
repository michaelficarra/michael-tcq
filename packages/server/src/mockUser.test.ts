import { describe, it, expect } from 'vitest';
import { DEV_USERS } from '@tcq/shared';
import { mockUserFromLogin } from './mockUser.js';

describe('mockUserFromLogin', () => {
  it('falls back to login as name and empty organisation when not in the seed', () => {
    // Pick a login that's vanishingly unlikely to be in the TC39 seed.
    const login = '__not_a_real_tc39_member_for_tests__';
    const user = mockUserFromLogin(login);
    expect(user.provider).toBe('github');
    // accountId is the lowercased login; handle preserves the caller's case.
    expect(user.accountId).toBe(login.toLowerCase());
    expect(user.handle).toBe(login);
    expect(user.name).toBe(login);
    expect(user.organisation).toBe('');
  });

  it('produces a stable provider-neutral shape that differs between distinct logins', () => {
    const a = mockUserFromLogin('alpha-test-login');
    const b = mockUserFromLogin('beta-test-login');
    // Distinct logins yield distinct accountIds (and thus distinct keys).
    expect(a.accountId).toBe('alpha-test-login');
    expect(b.accountId).toBe('beta-test-login');
    expect(a.accountId).not.toBe(b.accountId);
    // Avatar is synthesised from the login, never empty for a resolved user.
    expect(a.avatarUrl).toBe('https://github.com/alpha-test-login.png?size=80');
    expect(a.avatarUrl).not.toBe('');
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
    expect(user.handle).toBe(enriched.login);
    expect(user.accountId).toBe(enriched.login.toLowerCase());
    expect(user.name).toBe(enriched.name);
    expect(user.organisation).toBe(enriched.organisation);
  });

  it('matches seed entries case-insensitively on the login', () => {
    const sample = DEV_USERS[0];
    if (!sample) return;
    const upper = mockUserFromLogin(sample.login.toUpperCase());
    // The display name comes from the seed even though the input case
    // didn't match exactly. The handle preserves the caller's case, while
    // accountId is the canonical lowercased login.
    expect(upper.name).toBe(sample.name);
    expect(upper.handle).toBe(sample.login.toUpperCase());
    expect(upper.accountId).toBe(sample.login.toLowerCase());
  });
});
