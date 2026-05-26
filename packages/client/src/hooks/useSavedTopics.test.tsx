/**
 * Tests for `useSavedTopics` — per-user localStorage-backed list of
 * saved queue topics with a 5-item cap.
 *
 * Each test wraps the hook in an AuthProvider stub so `user.ghid` drives
 * the storage key. The module-level cache is cleared between tests so a
 * previous test's seed doesn't leak into the next.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { AuthProvider } from '../contexts/AuthContext.js';
import {
  __resetSavedTopicsCacheForTests,
  SAVED_TOPICS_MAX,
  DEFAULT_SAVED_TOPICS,
  useSavedTopics,
} from './useSavedTopics.js';

/** Stub /api/me so AuthProvider resolves to the requested user. */
function stubMe(ghid: number, username = 'alice'): void {
  globalThis.fetch = (async (url: string | URL | Request) => {
    if (String(url) === '/api/me') {
      return {
        ok: true,
        json: async () => ({ ghid, ghUsername: username, name: username, organisation: '' }),
      } as Response;
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
}

function wrapper({ children }: { children: ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}

/** Render the hook and wait for AuthProvider to populate the user.
 *  Returns the renderHook result. */
async function renderUseSavedTopics() {
  const r = renderHook(() => useSavedTopics(), { wrapper });
  // Let the /api/me fetch resolve and AuthProvider commit.
  await act(async () => {});
  return r;
}

beforeEach(() => {
  localStorage.clear();
  __resetSavedTopicsCacheForTests();
});

describe('useSavedTopics', () => {
  it('seeds the default list on first read for a new user', async () => {
    stubMe(42);
    const { result } = await renderUseSavedTopics();
    expect(result.current.topics).toHaveLength(DEFAULT_SAVED_TOPICS.length);
    expect(result.current.topics[0].text).toBe('👍 I support this. (EOM)');
    // Default is persisted so a second mount sees the same ids.
    const stored = JSON.parse(localStorage.getItem('tcq:saved-topics:42') ?? '[]');
    expect(stored).toHaveLength(1);
    expect(stored[0].text).toBe('👍 I support this. (EOM)');
  });

  it('does not re-seed when storage already has a (possibly empty) list', async () => {
    localStorage.setItem('tcq:saved-topics:42', JSON.stringify([]));
    stubMe(42);
    const { result } = await renderUseSavedTopics();
    // The user explicitly emptied the list — don't put the default back.
    expect(result.current.topics).toEqual([]);
  });

  it('returns an empty list when no user is signed in', () => {
    // No /api/me stub → AuthProvider keeps user as null
    const { result } = renderHook(() => useSavedTopics(), { wrapper });
    expect(result.current.topics).toEqual([]);
    // Mutations are no-ops without a user, so they don't crash.
    expect(result.current.add('hi')).toBeNull();
    result.current.update('x', 'y');
    result.current.remove('x');
    result.current.reorder('a', 'b');
    expect(result.current.topics).toEqual([]);
  });

  it('add appends a new entry and persists', async () => {
    stubMe(7);
    const { result } = await renderUseSavedTopics();
    const initialLen = result.current.topics.length;

    let newId: string | null = null;
    await act(async () => {
      newId = result.current.add('Thanks');
    });

    expect(newId).not.toBeNull();
    expect(result.current.topics).toHaveLength(initialLen + 1);
    expect(result.current.topics[initialLen].text).toBe('Thanks');
    const stored = JSON.parse(localStorage.getItem('tcq:saved-topics:7') ?? '[]');
    expect(stored).toHaveLength(initialLen + 1);
  });

  it('add returns null and is a no-op at the cap', async () => {
    // Seed exactly MAX entries
    const full = Array.from({ length: SAVED_TOPICS_MAX }, (_, i) => ({ id: `id-${i}`, text: `t-${i}` }));
    localStorage.setItem('tcq:saved-topics:9', JSON.stringify(full));
    stubMe(9);
    const { result } = await renderUseSavedTopics();
    expect(result.current.topics).toHaveLength(SAVED_TOPICS_MAX);

    let added: string | null = null;
    await act(async () => {
      added = result.current.add('overflow');
    });
    expect(added).toBeNull();
    expect(result.current.topics).toHaveLength(SAVED_TOPICS_MAX);
  });

  it('update trims text and ignores empty edits', async () => {
    localStorage.setItem('tcq:saved-topics:5', JSON.stringify([{ id: 'a', text: 'hi' }]));
    stubMe(5);
    const { result } = await renderUseSavedTopics();

    await act(async () => {
      result.current.update('a', '  edited  ');
    });
    expect(result.current.topics[0].text).toBe('edited');

    // Empty/whitespace updates are ignored (row reverts on blur in UI).
    await act(async () => {
      result.current.update('a', '   ');
    });
    expect(result.current.topics[0].text).toBe('edited');

    // Unknown id is also ignored.
    await act(async () => {
      result.current.update('does-not-exist', 'nope');
    });
    expect(result.current.topics).toEqual([{ id: 'a', text: 'edited', type: 'topic' }]);
  });

  it('remove deletes by id and persists', async () => {
    localStorage.setItem(
      'tcq:saved-topics:11',
      JSON.stringify([
        { id: 'a', text: 'A' },
        { id: 'b', text: 'B' },
      ]),
    );
    stubMe(11);
    const { result } = await renderUseSavedTopics();
    expect(result.current.topics).toHaveLength(2);

    await act(async () => {
      result.current.remove('a');
    });
    expect(result.current.topics).toEqual([{ id: 'b', text: 'B', type: 'topic' }]);
    expect(JSON.parse(localStorage.getItem('tcq:saved-topics:11') ?? '[]')).toEqual([
      { id: 'b', text: 'B', type: 'topic' },
    ]);
  });

  it('reorder moves an entry by id and persists', async () => {
    localStorage.setItem(
      'tcq:saved-topics:13',
      JSON.stringify([
        { id: 'a', text: 'A' },
        { id: 'b', text: 'B' },
        { id: 'c', text: 'C' },
      ]),
    );
    stubMe(13);
    const { result } = await renderUseSavedTopics();

    // Move 'a' onto 'c' — expect [B, C, A]
    await act(async () => {
      result.current.reorder('a', 'c');
    });
    expect(result.current.topics.map((r) => r.id)).toEqual(['b', 'c', 'a']);

    // No-op cases.
    await act(async () => {
      result.current.reorder('a', 'a');
    });
    await act(async () => {
      result.current.reorder('unknown', 'b');
    });
    expect(result.current.topics.map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });

  it('caps the read at MAX even if storage has more', async () => {
    const overflow = Array.from({ length: SAVED_TOPICS_MAX + 3 }, (_, i) => ({
      id: `id-${i}`,
      text: `t-${i}`,
    }));
    localStorage.setItem('tcq:saved-topics:21', JSON.stringify(overflow));
    stubMe(21);
    const { result } = await renderUseSavedTopics();
    expect(result.current.topics).toHaveLength(SAVED_TOPICS_MAX);
  });

  it('ignores garbled storage rather than crashing', async () => {
    localStorage.setItem('tcq:saved-topics:99', '{not json');
    stubMe(99);
    const { result } = await renderUseSavedTopics();
    // Garbled storage → empty list (caller may seed by adding entries).
    expect(result.current.topics).toEqual([]);
  });

  it('seeds the default entry with the New Topic priority', async () => {
    stubMe(42);
    const { result } = await renderUseSavedTopics();
    expect(result.current.topics[0].type).toBe('topic');
  });

  it('add defaults to topic and stores an explicit type', async () => {
    localStorage.setItem('tcq:saved-topics:7', JSON.stringify([]));
    stubMe(7);
    const { result } = await renderUseSavedTopics();

    await act(async () => {
      result.current.add('default-priority');
      result.current.add('a reply', 'reply');
    });

    expect(result.current.topics[0]).toMatchObject({ text: 'default-priority', type: 'topic' });
    expect(result.current.topics[1]).toMatchObject({ text: 'a reply', type: 'reply' });
    // Persisted with the type intact.
    const stored = JSON.parse(localStorage.getItem('tcq:saved-topics:7') ?? '[]');
    expect(stored.map((t: { type: string }) => t.type)).toEqual(['topic', 'reply']);
  });

  it('coerces a missing or invalid stored type to topic', async () => {
    localStorage.setItem(
      'tcq:saved-topics:31',
      JSON.stringify([
        { id: 'a', text: 'legacy, no type' },
        { id: 'b', text: 'bogus type', type: 'not-a-real-type' },
        { id: 'c', text: 'valid', type: 'point-of-order' },
      ]),
    );
    stubMe(31);
    const { result } = await renderUseSavedTopics();
    expect(result.current.topics).toEqual([
      { id: 'a', text: 'legacy, no type', type: 'topic' },
      { id: 'b', text: 'bogus type', type: 'topic' },
      { id: 'c', text: 'valid', type: 'point-of-order' },
    ]);
  });

  it('setType updates a topic priority and persists; unknown ids are ignored', async () => {
    localStorage.setItem('tcq:saved-topics:33', JSON.stringify([{ id: 'a', text: 'A', type: 'topic' }]));
    stubMe(33);
    const { result } = await renderUseSavedTopics();

    await act(async () => {
      result.current.setType('a', 'question');
    });
    expect(result.current.topics[0].type).toBe('question');
    expect(JSON.parse(localStorage.getItem('tcq:saved-topics:33') ?? '[]')).toEqual([
      { id: 'a', text: 'A', type: 'question' },
    ]);

    // Unknown id is a no-op.
    await act(async () => {
      result.current.setType('does-not-exist', 'reply');
    });
    expect(result.current.topics[0].type).toBe('question');
  });
});
