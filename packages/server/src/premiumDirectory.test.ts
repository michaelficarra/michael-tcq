import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { User } from '@tcq/shared';
import { resolvePremiumUsers, resetPremiumDirectoryForTesting } from './premiumDirectory.js';
import { githubProvider } from './auth/github.js';
import { orcidProvider } from './auth/orcid.js';

/**
 * Resolution dispatches entirely through the `AuthenticationProvider`
 * interface — there is no provider-specific branching in this module. These
 * tests spy on the providers' `resolveByHandle` / `resolveByAccountId` so they
 * assert the dispatch and caching behaviour without any network access.
 */

const githubAlice: User = {
  provider: 'github',
  accountId: '100',
  handle: 'alice',
  name: 'Alice Anderson',
  organisation: 'ACME',
  avatarUrl: 'https://github.com/alice.png?size=80',
};

describe('resolvePremiumUsers', () => {
  beforeEach(() => {
    resetPremiumDirectoryForTesting();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves a bare reference as a handle, via the provider', async () => {
    const spy = vi.spyOn(githubProvider, 'resolveByHandle').mockResolvedValue(githubAlice);
    const [entry] = await resolvePremiumUsers(['alice']);
    expect(spy).toHaveBeenCalledWith('alice');
    expect(entry.ref).toBe('alice');
    expect(entry.user.name).toBe('Alice Anderson');
    expect(entry.user.avatarUrl).toBe('https://github.com/alice.png?size=80');
  });

  it('resolves a provider:accountId reference by account id', async () => {
    const spy = vi.spyOn(githubProvider, 'resolveByAccountId').mockResolvedValue({
      ...githubAlice,
      accountId: '5952481',
      handle: 'michaelficarra',
      name: 'Michael Ficarra',
    });
    const [entry] = await resolvePremiumUsers(['github:5952481']);
    expect(spy).toHaveBeenCalledWith('5952481');
    // The bare numeric id is replaced by the resolved display name.
    expect(entry.user.name).toBe('Michael Ficarra');
    expect(entry.user.handle).toBe('michaelficarra');
  });

  it('dispatches a non-GitHub reference to that provider generically', async () => {
    const orcidUser: User = {
      provider: 'orcid',
      accountId: '0000-0002-1825-0097',
      name: 'Grace Hopper',
      organisation: 'US Navy',
      avatarUrl: 'https://gravatar.com/avatar/abc?d=identicon&s=80',
    };
    const spy = vi.spyOn(orcidProvider, 'resolveByAccountId').mockResolvedValue(orcidUser);
    const [entry] = await resolvePremiumUsers(['orcid:0000-0002-1825-0097']);
    expect(spy).toHaveBeenCalledWith('0000-0002-1825-0097');
    expect(entry.user).toEqual(orcidUser);
  });

  it('falls back to a provider-synthesised avatar when resolution returns null', async () => {
    vi.spyOn(githubProvider, 'resolveByAccountId').mockResolvedValue(null);
    const [entry] = await resolvePremiumUsers(['github:999']);
    // Best label available without a successful lookup is the bare id...
    expect(entry.user.name).toBe('999');
    expect(entry.user.handle).toBeUndefined();
    // ...and the avatar still comes from the provider's own avatarUrl(), not
    // any hardcoded URL in this module.
    expect(entry.user.avatarUrl).toBe(githubProvider.avatarUrl({ accountId: '999', handle: undefined }));
  });

  it('caches a successful resolution within the TTL (one provider call)', async () => {
    const spy = vi.spyOn(githubProvider, 'resolveByHandle').mockResolvedValue(githubAlice);
    await resolvePremiumUsers(['alice']);
    await resolvePremiumUsers(['alice']);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does not cache a fallback (retries on the next call)', async () => {
    const spy = vi.spyOn(githubProvider, 'resolveByAccountId').mockResolvedValue(null);
    await resolvePremiumUsers(['github:999']);
    await resolvePremiumUsers(['github:999']);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('treats a thrown provider error as an unresolved fallback', async () => {
    vi.spyOn(githubProvider, 'resolveByHandle').mockRejectedValue(new Error('network down'));
    const [entry] = await resolvePremiumUsers(['alice']);
    expect(entry.ref).toBe('alice');
    expect(entry.user.provider).toBe('github');
    expect(entry.user.name).toBe('alice');
  });

  it('resolves multiple references in one call, preserving order', async () => {
    vi.spyOn(githubProvider, 'resolveByHandle').mockImplementation(async (handle: string) => ({
      ...githubAlice,
      handle,
      name: handle.toUpperCase(),
    }));
    const entries = await resolvePremiumUsers(['alice', 'bob']);
    expect(entries.map((e) => e.ref)).toEqual(['alice', 'bob']);
    expect(entries.map((e) => e.user.name)).toEqual(['ALICE', 'BOB']);
  });
});
