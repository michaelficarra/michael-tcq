import { describe, it, expect, beforeEach } from 'vitest';
import type { MeetingState, User, UserSelection } from '@tcq/shared';
import { userKey } from '@tcq/shared';
import { resolveSelections } from './resolveUser.js';
import { recordUser, resetKnownUsersForTesting } from './knownUsers.js';
import type { SessionUser } from './session.js';

const searcher: SessionUser = {
  provider: 'github',
  accountId: '1',
  handle: 'searcher',
  name: 'Searcher',
  organisation: '',
  avatarUrl: '',
  isAdmin: false,
};

/** Empty meeting — the point of these tests is that the user is NOT in it, yet
 *  still resolves because it has been seen elsewhere on the server. */
function emptyMeeting(): MeetingState {
  return {
    id: 'm1',
    createdAt: new Date().toISOString(),
    participantIds: [],
    users: {} as MeetingState['users'],
    chairIds: [],
    agenda: [],
    queue: { entries: {}, orderedIds: [], closed: false },
    current: { topicSpeakers: [] },
    operational: { lastConnectionTime: '', maxConcurrent: 0, version: 0 },
  };
}

describe('resolveSelections — known-users fallback', () => {
  beforeEach(() => {
    resetKnownUsersForTesting();
  });

  it('resolves a {provider, accountId} selection from the known-users cache, synchronously', () => {
    const ada: User = {
      provider: 'google',
      accountId: 'sub-ada',
      handle: undefined,
      name: 'Ada Lovelace',
      organisation: 'analytical.test',
      avatarUrl: 'https://lh3.googleusercontent.com/a/ada=s96',
    };
    recordUser(ada);

    const sel: UserSelection = { provider: 'google', accountId: 'sub-ada' };
    const result = resolveSelections(searcher, emptyMeeting(), [sel]);

    // The cache hit lets the sync path complete, so the result is an array,
    // not a Promise — preserving the synchronous-resolution contract.
    expect(Array.isArray(result)).toBe(true);
    expect((result as User[])[0]).toEqual(ada);
    // Sanity: the key really wasn't in the meeting.
    expect(userKey(ada)).toBe('google:sub-ada');
  });

  it('resolves a {handle} selection from the known-users cache, case-insensitively', () => {
    const alice: User = {
      provider: 'github',
      accountId: '100',
      handle: 'Alice',
      name: 'Alice Anderson',
      organisation: 'ACME',
      avatarUrl: '',
    };
    recordUser(alice);

    const result = resolveSelections(searcher, emptyMeeting(), [{ handle: 'alice' }]);
    expect(Array.isArray(result)).toBe(true);
    expect((result as User[])[0]).toEqual(alice);
  });
});
