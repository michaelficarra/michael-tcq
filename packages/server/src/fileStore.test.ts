import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MeetingState } from '@tcq/shared';
import { asUserKey } from '@tcq/shared';
import { FileMeetingStore } from './fileStore.js';

/** Create a minimal valid MeetingState for testing. */
function makeMeeting(id: string): MeetingState {
  return {
    id,
    createdAt: '2026-01-01T00:00:00.000Z',
    participantIds: [],
    users: {},
    chairIds: [],
    agenda: [],
    queue: { entries: {}, orderedIds: [], closed: false },
    current: { topicSpeakers: [] },
    operational: { lastConnectionTime: '2026-01-01T00:00:00.000Z', maxConcurrent: 0 },
  };
}

describe('FileMeetingStore', () => {
  let dir: string;
  let store: FileMeetingStore;

  beforeEach(async () => {
    // Create a unique temp directory for each test
    dir = await mkdtemp(join(tmpdir(), 'tcq-test-'));
    store = new FileMeetingStore(dir);
    await store.init();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('save and load round-trips a meeting', async () => {
    const meeting = makeMeeting('calm-wave');
    await store.save(meeting);

    const loaded = await store.load('calm-wave');
    expect(loaded).toEqual(meeting);
  });

  it('load returns null for a non-existent meeting', async () => {
    const result = await store.load('no-such-meeting');
    expect(result).toBeNull();
  });

  it('loadAll returns all saved meetings', async () => {
    await store.save(makeMeeting('bright-pine'));
    await store.save(makeMeeting('calm-wave'));

    const all = await store.loadAll();
    expect(all).toHaveLength(2);

    const ids = all.map((m) => m.id).sort();
    expect(ids).toEqual(['bright-pine', 'calm-wave']);
  });

  it('loadAll returns empty array when directory is empty', async () => {
    const all = await store.loadAll();
    expect(all).toEqual([]);
  });

  it('remove deletes a meeting from disk', async () => {
    await store.save(makeMeeting('bright-pine'));
    await store.remove('bright-pine');

    const loaded = await store.load('bright-pine');
    expect(loaded).toBeNull();
  });

  it('remove is a no-op for a non-existent meeting', async () => {
    // Should not throw
    await store.remove('no-such-meeting');
  });

  it('save overwrites an existing meeting', async () => {
    const meeting = makeMeeting('bright-pine');
    await store.save(meeting);

    // Modify and re-save
    meeting.queue.closed = true;
    await store.save(meeting);

    const loaded = await store.load('bright-pine');
    expect(loaded?.queue.closed).toBe(true);
  });

  // -- Log methods --

  it('appendLog/loadLog round-trip log entries in append order', async () => {
    await store.appendLog('calm-wave', {
      id: 'e1',
      type: 'meeting-started',
      timestamp: '2026-01-01T00:00:00.000Z',
      chairId: asUserKey('a'),
    });
    await store.appendLog('calm-wave', {
      id: 'e2',
      type: 'agenda-item-started',
      timestamp: '2026-01-01T00:01:00.000Z',
      chairId: asUserKey('a'),
      itemName: 'First',
      itemPresenterIds: [asUserKey('a')],
    });

    const log = await store.loadLog('calm-wave');
    expect(log.map((e) => e.id)).toEqual(['e1', 'e2']);
  });

  it('loadLog returns an empty array for a meeting with no log file', async () => {
    const log = await store.loadLog('no-such-meeting');
    expect(log).toEqual([]);
  });

  it('loadAll skips .log.json files when listing meetings', async () => {
    await store.save(makeMeeting('bright-pine'));
    await store.appendLog('bright-pine', {
      id: 'e1',
      type: 'meeting-started',
      timestamp: '2026-01-01T00:00:00.000Z',
      chairId: asUserKey('a'),
    });

    const all = await store.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe('bright-pine');
  });

  it('loadAllLogs returns logs keyed by meeting id', async () => {
    await store.appendLog('alpha', {
      id: 'a1',
      type: 'meeting-started',
      timestamp: '2026-01-01T00:00:00.000Z',
      chairId: asUserKey('a'),
    });
    await store.appendLog('beta', {
      id: 'b1',
      type: 'meeting-started',
      timestamp: '2026-01-02T00:00:00.000Z',
      chairId: asUserKey('b'),
    });
    await store.appendLog('beta', {
      id: 'b2',
      type: 'agenda-item-started',
      timestamp: '2026-01-02T00:01:00.000Z',
      chairId: asUserKey('b'),
      itemName: 'First',
      itemPresenterIds: [asUserKey('b')],
    });

    const all = await store.loadAllLogs();
    expect(all.size).toBe(2);
    expect(all.get('alpha')!.map((e) => e.id)).toEqual(['a1']);
    expect(all.get('beta')!.map((e) => e.id)).toEqual(['b1', 'b2']);
  });

  it('remove also deletes the meeting log file', async () => {
    await store.save(makeMeeting('bright-pine'));
    await store.appendLog('bright-pine', {
      id: 'e1',
      type: 'meeting-started',
      timestamp: '2026-01-01T00:00:00.000Z',
      chairId: asUserKey('a'),
    });

    await store.remove('bright-pine');

    expect(await store.load('bright-pine')).toBeNull();
    expect(await store.loadLog('bright-pine')).toEqual([]);
  });
});
