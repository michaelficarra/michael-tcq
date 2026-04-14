import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MeetingState } from '@tcq/shared';
import { FileMeetingStore } from './fileStore.js';

/** Create a minimal valid MeetingState for testing. */
function makeMeeting(id: string): MeetingState {
  return {
    id,
    chairs: [],
    agenda: [],
    currentAgendaItem: undefined,
    currentSpeaker: undefined,
    currentTopic: undefined,
    queuedSpeakers: [],
    reactions: [],
    trackPoll: false, pollOptions: [], version: 0,
    log: [], currentTopicSpeakers: [],
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
    meeting.trackPoll = true;
    await store.save(meeting);

    const loaded = await store.load('bright-pine');
    expect(loaded?.trackPoll).toBe(true);
  });
});
