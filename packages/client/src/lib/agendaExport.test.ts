import { describe, it, expect } from 'vitest';
import type { User } from '@tcq/shared';
import { placeholderUser, userKey } from '@tcq/shared';
import { makeMeeting } from '../test/makeMeeting.js';
import { serializeAgenda } from './agendaExport.js';

const alice: User = {
  provider: 'github',
  accountId: 'alice',
  handle: 'alice',
  name: 'Alice Anderson',
  organisation: 'ACME',
  avatarUrl: 'https://github.com/alice.png?size=80',
};
// A free-text (placeholder) presenter: `name` holds the typed name verbatim.
const bob = placeholderUser('Bob the Builder');

describe('serializeAgenda', () => {
  it('serialises the flat agenda into the import/export document format', () => {
    const meeting = makeMeeting({
      users: { [userKey(alice)]: alice, [userKey(bob)]: bob },
      agenda: [
        { kind: 'session', id: 's1', name: 'Morning', capacity: 60 },
        { kind: 'session', id: 's2', name: 'Open block' },
        { kind: 'item', id: 'a', name: 'Welcome', presenterIds: [userKey(alice)], duration: 5 },
        { kind: 'item', id: 'b', name: 'Two presenters', presenterIds: [userKey(alice), userKey(bob)] },
        { kind: 'item', id: 'c', name: 'No presenter', presenterIds: [] },
      ],
    });

    expect(serializeAgenda(meeting.agenda, meeting.users)).toEqual([
      { type: 'session', name: 'Morning', capacity: 60 },
      { type: 'session', name: 'Open block' },
      { type: 'topic', name: 'Welcome', presenters: ['Alice Anderson'], duration: 5 },
      { type: 'topic', name: 'Two presenters', presenters: ['Alice Anderson', 'Bob the Builder'] },
      { type: 'topic', name: 'No presenter' },
    ]);
  });

  it('drops presenter ids that are absent from the users map', () => {
    const meeting = makeMeeting({
      users: {},
      agenda: [{ kind: 'item', id: 'a', name: 'Orphan', presenterIds: [userKey(alice)] }],
    });

    expect(serializeAgenda(meeting.agenda, meeting.users)).toEqual([{ type: 'topic', name: 'Orphan' }]);
  });
});
