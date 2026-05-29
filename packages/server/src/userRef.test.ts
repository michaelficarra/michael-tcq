/**
 * Unit tests for admin/premium user-reference matching: the shared
 * `canonicalUserRef` / `buildUserRefIndex` / `userMatchesIndex` helpers, and
 * their use by `isAdmin` (ADMIN_USERNAMES) and `AppSettingsManager.isPremium`.
 * Covers both accepted forms: a bare GitHub handle and a provider-qualified
 * `provider:id` (so non-GitHub accounts can be admin/premium too).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { User } from '@tcq/shared';
import { canonicalUserRef, buildUserRefIndex, userMatchesIndex } from '@tcq/shared';
import { isAdmin } from './admin.js';
import { githubUser } from './auth/githubUser.js';
import { AppSettingsManager } from './appSettingsManager.js';
import { InMemoryAppSettingsStore } from './test/inMemoryAppSettingsStore.js';

// A GitHub user: handle `alice`, numeric account id `12345`.
const githubAlice: User = githubUser({ id: 12345, login: 'Alice', name: 'Alice A' });
// A non-GitHub (Google) user: no handle, opaque account id.
const googleUser: User = {
  provider: 'google',
  accountId: '10657',
  name: 'Grace',
  organisation: '',
  avatarUrl: 'https://example.com/g.png',
};

describe('canonicalUserRef', () => {
  it('lowercases and @-strips a bare GitHub handle', () => {
    expect(canonicalUserRef('  @Alice ')).toBe('alice');
  });
  it('lowercases a github: ref (handle or id) but preserves other providers case', () => {
    expect(canonicalUserRef('github:Alice')).toBe('github:alice');
    expect(canonicalUserRef('GitHub:12345')).toBe('github:12345');
    expect(canonicalUserRef('orcid:0000-0002-1825-009X')).toBe('orcid:0000-0002-1825-009X');
  });
  it('returns null for empty/structurally-invalid input', () => {
    expect(canonicalUserRef('   ')).toBeNull();
    expect(canonicalUserRef('github:')).toBeNull();
  });
});

describe('userMatchesIndex', () => {
  it('bare handle matches the GitHub user by handle, not a non-GitHub user', () => {
    const idx = buildUserRefIndex(['alice']);
    expect(userMatchesIndex(githubAlice, idx)).toBe(true);
    expect(userMatchesIndex(googleUser, idx)).toBe(false);
  });
  it('github:<id> matches by account id regardless of handle', () => {
    const idx = buildUserRefIndex(['github:12345']);
    expect(userMatchesIndex(githubAlice, idx)).toBe(true);
  });
  it('github:<handle> matches by handle', () => {
    const idx = buildUserRefIndex(['github:alice']);
    expect(userMatchesIndex(githubAlice, idx)).toBe(true);
  });
  it('provider-qualified id matches a non-GitHub user', () => {
    const idx = buildUserRefIndex(['google:10657']);
    expect(userMatchesIndex(googleUser, idx)).toBe(true);
    expect(userMatchesIndex(githubAlice, idx)).toBe(false);
  });
});

describe('isAdmin', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('matches a bare handle and a provider-qualified id', () => {
    vi.stubEnv('ADMIN_USERNAMES', 'alice, google:10657');
    expect(isAdmin(githubAlice)).toBe(true);
    expect(isAdmin(googleUser)).toBe(true);
  });
  it('does not match a user absent from the list', () => {
    vi.stubEnv('ADMIN_USERNAMES', 'someone-else');
    expect(isAdmin(githubAlice)).toBe(false);
    expect(isAdmin(googleUser)).toBe(false);
  });
});

describe('AppSettingsManager.isPremium', () => {
  it('matches bare handles, github:<id>, and provider-qualified ids; stores canonical', async () => {
    const manager = new AppSettingsManager(new InMemoryAppSettingsStore());
    await manager.restore();

    expect(await manager.addPremiumUsername('github:12345')).toBe('github:12345');
    expect(await manager.addPremiumUsername('google:10657')).toBe('google:10657');

    expect(manager.isPremium(githubAlice)).toBe(true); // by github:<id>
    expect(manager.isPremium(googleUser)).toBe(true); // by google:<id>

    // A different GitHub user (handle bob, id 999) isn't premium.
    expect(manager.isPremium(githubUser({ id: 999, login: 'bob' }))).toBe(false);

    expect(manager.getPremiumUsernames()).toEqual(['github:12345', 'google:10657']);
  });
});
