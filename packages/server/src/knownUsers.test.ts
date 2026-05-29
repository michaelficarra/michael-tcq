import { describe, it, expect, beforeEach } from 'vitest';
import type { User } from '@tcq/shared';
import { placeholderUser } from '@tcq/shared';
import {
  recordUser,
  getKnownUser,
  getKnownUserByProviderAccount,
  getKnownUserByHandle,
  resetKnownUsersForTesting,
} from './knownUsers.js';

const ada: User = {
  provider: 'google',
  accountId: 'sub-ada',
  handle: undefined,
  name: 'Ada Lovelace',
  organisation: 'analytical.test',
  avatarUrl: 'https://lh3.googleusercontent.com/a/ada=s96',
};

describe('knownUsers', () => {
  beforeEach(() => {
    resetKnownUsersForTesting();
  });

  it('records and retrieves a user by key and by provider+account', () => {
    recordUser(ada);
    expect(getKnownUser('google:sub-ada' as Parameters<typeof getKnownUser>[0])).toEqual(ada);
    expect(getKnownUserByProviderAccount('google', 'sub-ada')).toEqual(ada);
    expect(getKnownUserByProviderAccount('google', 'nope')).toBeUndefined();
  });

  it('looks a user up by handle, case-insensitively', () => {
    const alice: User = {
      provider: 'github',
      accountId: '100',
      handle: 'Alice',
      name: 'Alice',
      organisation: '',
      avatarUrl: '',
    };
    recordUser(alice);
    expect(getKnownUserByHandle('alice')).toEqual(alice);
    expect(getKnownUserByHandle('ALICE')).toEqual(alice);
    expect(getKnownUserByHandle('bob')).toBeUndefined();
  });

  it('ignores placeholder users so they never poison a real key', () => {
    recordUser(placeholderUser('Some Name'));
    expect(getKnownUserByProviderAccount('placeholder', 'some name')).toBeUndefined();
  });

  it('ignores users with an empty provider or account id', () => {
    recordUser({ ...ada, accountId: '' });
    recordUser({ ...ada, provider: '' });
    expect(getKnownUser('google:' as Parameters<typeof getKnownUser>[0])).toBeUndefined();
    expect(getKnownUser(':sub-ada' as Parameters<typeof getKnownUser>[0])).toBeUndefined();
  });

  it('last write wins — a fresher profile supersedes the cached entry', () => {
    recordUser(ada);
    const renamed: User = { ...ada, name: 'Ada, Countess of Lovelace', avatarUrl: 'https://example.test/new.png' };
    recordUser(renamed);
    expect(getKnownUserByProviderAccount('google', 'sub-ada')).toEqual(renamed);
  });
});
