/**
 * Unit tests for the lazy on-read migration helpers in `@tcq/shared`'s
 * `migrate.ts`. Lives in the server package because `@tcq/shared` has no
 * test runner of its own. Exercises the legacy→provider-key upgrade for
 * users, keys, meetings, logs, and app-settings, plus idempotency and the
 * colon-based legacy detection invariant.
 */

import { describe, it, expect } from 'vitest';
import type { LegacyUser, MeetingState, LogEntry, UserKey, User } from '@tcq/shared';
import {
  upgradeUser,
  migrateKey,
  isLegacyKey,
  isLegacyUser,
  isLegacyMeeting,
  upgradeMeeting,
  upgradeLog,
  isLegacyAppSettings,
  upgradeAppSettings,
  userKey,
} from '@tcq/shared';

const legacy = (ghid: number, ghUsername: string, name = ghUsername, organisation = ''): LegacyUser => ({
  ghid,
  ghUsername,
  name,
  organisation,
});

describe('upgradeUser', () => {
  it('maps a legacy GitHub user to the provider-neutral shape', () => {
    const u = upgradeUser(legacy(42, 'AliceA', 'Alice Anderson', 'ACME'));
    expect(u).toEqual({
      provider: 'github',
      accountId: 'alicea',
      handle: 'AliceA',
      name: 'Alice Anderson',
      organisation: 'ACME',
      avatarUrl: 'https://github.com/alicea.png?size=80',
    });
  });

  it('marks a ghid:0 placeholder with an empty avatarUrl', () => {
    const u = upgradeUser(legacy(0, 'Some Free Text'));
    expect(u.provider).toBe('github');
    expect(u.accountId).toBe('some free text');
    expect(u.avatarUrl).toBe('');
  });

  it('preserves isPremium when set and omits it otherwise', () => {
    expect(upgradeUser({ ...legacy(1, 'a'), isPremium: true }).isPremium).toBe(true);
    expect('isPremium' in upgradeUser(legacy(1, 'a'))).toBe(false);
  });

  it('is idempotent on an already-migrated user', () => {
    const once = upgradeUser(legacy(7, 'Bob'));
    expect(upgradeUser(once)).toEqual(once);
  });
});

describe('key helpers', () => {
  it('detects legacy (unprefixed) keys', () => {
    expect(isLegacyKey('alice')).toBe(true);
    expect(isLegacyKey('github:alice')).toBe(false);
  });

  it('prefixes bare keys and passes through prefixed ones', () => {
    expect(migrateKey('alice')).toBe('github:alice');
    expect(migrateKey('github:alice')).toBe('github:alice');
    expect(migrateKey('google:12345')).toBe('google:12345');
  });

  it('isLegacyUser discriminates on the provider field', () => {
    expect(isLegacyUser(legacy(1, 'a'))).toBe(true);
    expect(isLegacyUser(upgradeUser(legacy(1, 'a')))).toBe(false);
  });
});

// A legacy meeting with one chair (alice), an agenda item presented by bob,
// a queue entry from carol, a poll started by alice with a reaction from bob,
// current speaker/topic, and operational attribution — exercising every
// UserKey-typed field.
function legacyMeeting(): MeetingState {
  const k = (s: string) => s as UserKey;
  return {
    id: 'm1',
    createdAt: '2026-01-01T00:00:00Z',
    participantIds: [k('alice'), k('bob')],
    users: {
      alice: legacy(1, 'alice') as unknown as User,
      bob: legacy(2, 'bob') as unknown as User,
      carol: legacy(3, 'carol') as unknown as User,
    } as unknown as Record<UserKey, User>,
    chairIds: [k('alice')],
    agenda: [{ kind: 'item', id: 'i1', name: 'Item', presenterIds: [k('bob')] }],
    queue: {
      entries: { e1: { id: 'e1', type: 'topic', topic: 'hi', userId: k('carol') } },
      orderedIds: ['e1'],
      closed: false,
    },
    current: {
      speaker: { id: 's1', userId: k('bob'), type: 'topic', topic: 't', source: 'queue', startTime: 'x' },
      topic: { speakerId: 's1', userId: k('bob'), topic: 't', startTime: 'x' },
      topicSpeakers: [{ userId: k('carol'), type: 'topic', topic: 't', startTime: 'x' }],
    },
    poll: {
      options: [{ id: 'o1', emoji: '👍', label: 'yes' }],
      reactions: [{ optionId: 'o1', userId: k('bob') }],
      startTime: 'x',
      startChairId: k('alice'),
      multiSelect: false,
    },
    operational: { lastAdvancementBy: k('alice'), lastConnectionTime: '', maxConcurrent: 1, version: 3 },
  };
}

describe('upgradeMeeting', () => {
  it('re-keys every UserKey-typed field and upgrades user records', () => {
    const m = upgradeMeeting(legacyMeeting());
    expect(Object.keys(m.users).sort()).toEqual(['github:alice', 'github:bob', 'github:carol']);
    expect(m.users['github:alice' as UserKey].provider).toBe('github');
    expect(m.participantIds).toEqual(['github:alice', 'github:bob']);
    expect(m.chairIds).toEqual(['github:alice']);
    expect((m.agenda[0] as { presenterIds: UserKey[] }).presenterIds).toEqual(['github:bob']);
    expect(m.queue.entries.e1.userId).toBe('github:carol');
    expect(m.current.speaker?.userId).toBe('github:bob');
    expect(m.current.topic?.userId).toBe('github:bob');
    expect(m.current.topicSpeakers[0].userId).toBe('github:carol');
    expect(m.poll?.startChairId).toBe('github:alice');
    expect(m.poll?.reactions[0].userId).toBe('github:bob');
    expect(m.operational.lastAdvancementBy).toBe('github:alice');
  });

  it('detects legacy vs migrated meetings and is idempotent', () => {
    const lm = legacyMeeting();
    expect(isLegacyMeeting(lm)).toBe(true);
    const once = upgradeMeeting(lm);
    expect(isLegacyMeeting(once)).toBe(false);
    expect(upgradeMeeting(once)).toEqual(once);
  });
});

describe('upgradeLog', () => {
  it('re-keys log entry user fields but leaves remainingQueue text untouched', () => {
    const entries: LogEntry[] = [
      { id: 'l1', timestamp: 't', type: 'meeting-started', chairId: 'alice' as UserKey },
      {
        id: 'l2',
        timestamp: 't',
        type: 'agenda-item-finished',
        chairId: 'alice' as UserKey,
        itemName: 'X',
        duration: 1,
        participantIds: ['bob' as UserKey],
        remainingQueue: 'Topic: hi (carol)',
      },
      {
        id: 'l3',
        timestamp: 't',
        type: 'topic-discussed',
        chairId: 'alice' as UserKey,
        topicName: 'T',
        speakers: [{ userId: 'carol' as UserKey, type: 'topic', topic: 't', startTime: 'x' }],
        duration: 1,
      },
    ];
    const out = upgradeLog(entries);
    expect((out[0] as { chairId: string }).chairId).toBe('github:alice');
    const finished = out[1] as { participantIds: string[]; remainingQueue: string };
    expect(finished.participantIds).toEqual(['github:bob']);
    // Display text is preserved verbatim — the (carol) is a handle, not a key.
    expect(finished.remainingQueue).toBe('Topic: hi (carol)');
    expect((out[2] as { speakers: { userId: string }[] }).speakers[0].userId).toBe('github:carol');
  });
});

describe('app settings', () => {
  it('expands bare premium usernames to github keys and detects legacy', () => {
    expect(isLegacyAppSettings({ premiumUsernames: ['alice', 'github:bob'] })).toBe(true);
    expect(isLegacyAppSettings({ premiumUsernames: ['github:alice'] })).toBe(false);
    expect(upgradeAppSettings({ premiumUsernames: ['alice', 'github:bob'] })).toEqual({
      premiumUsernames: ['github:alice', 'github:bob'],
    });
  });
});

describe('userKey integration', () => {
  it('an upgraded user keys to the migrated form of its old key', () => {
    const u = upgradeUser(legacy(99, 'Dana'));
    expect(userKey(u)).toBe('github:dana');
    expect(userKey(u)).toBe(migrateKey('dana'));
  });
});
