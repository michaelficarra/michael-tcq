import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { CurrentSpeaker, MeetingState, QueueEntry, User } from '@tcq/shared';
import { useAdvanceAction } from './useAdvanceAction.js';
import { MeetingStateContext, MeetingDispatchContext, type MeetingContextState } from '../contexts/MeetingContext.js';
import { SocketContext, type TypedSocket } from '../contexts/SocketContext.js';
import { makeMeeting as buildMeeting } from '../test/makeMeeting.js';

const alice: User = {
  provider: 'github',
  accountId: 'alice',
  handle: 'alice',
  name: 'Alice',
  organisation: 'ACME',
  avatarUrl: 'https://github.com/alice.png?size=80',
};

/** Build a minimal CurrentSpeaker struct with the given turn id. */
function speakerWith(id: string): CurrentSpeaker {
  return {
    id,
    userId: 'github:alice',
    type: 'topic',
    topic: 't',
    source: 'queue',
    startTime: '2026-01-01T00:00:00.000Z',
  };
}

interface MakeMeetingOverrides {
  /** Convenience: set current.speaker to a minimal struct with this id. */
  speakerId?: string;
  /** Convenience: set operational.lastAdvancementBy. */
  lastAdvancementBy?: string;
  /** Convenience: populate queue.orderedIds + entries with these ids (as topics by alice). */
  queueIds?: string[];
}

function entryWith(id: string): QueueEntry {
  return { id, type: 'topic', topic: id, userId: 'github:alice' };
}

/** Create a minimal meeting state for testing. */
function makeMeeting(overrides?: MakeMeetingOverrides): MeetingState {
  const ids = overrides?.queueIds ?? [];
  const entries: Record<string, QueueEntry> = {};
  for (const id of ids) entries[id] = entryWith(id);
  return buildMeeting({
    current: overrides?.speakerId
      ? { topicSpeakers: [], speaker: speakerWith(overrides.speakerId) }
      : { topicSpeakers: [] },
    queue: { entries, orderedIds: ids, closed: false },
    operational: overrides?.lastAdvancementBy ? { lastAdvancementBy: overrides.lastAdvancementBy } : {},
  });
}

function makeSocket(): TypedSocket {
  return { emit: vi.fn() } as unknown as TypedSocket;
}

interface WrapperState {
  meeting: MeetingState;
  user: User | null;
}

/**
 * Creates a wrapper whose state can be updated between renders
 * by mutating stateRef.current before calling rerender().
 */
function makeMutableWrapper(stateRef: { current: WrapperState }, socket: TypedSocket) {
  return function Wrapper({ children }: { children: ReactNode }) {
    const state: MeetingContextState = {
      meeting: stateRef.current.meeting,
      user: stateRef.current.user,
      connected: true,
      error: null,
    };
    return (
      <MeetingStateContext value={state}>
        <MeetingDispatchContext value={() => {}}>
          <SocketContext value={socket}>{children}</SocketContext>
        </MeetingDispatchContext>
      </MeetingStateContext>
    );
  };
}

describe('useAdvanceAction', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('emits queue:next on fire()', () => {
    const socket = makeSocket();
    const stateRef = {
      current: { meeting: makeMeeting({ speakerId: 'entry-1' }), user: null },
    };

    const { result } = renderHook(() => useAdvanceAction('queue:next'), {
      wrapper: makeMutableWrapper(stateRef, socket),
    });

    act(() => result.current.fire());

    expect(socket.emit).toHaveBeenCalledWith('queue:next', { currentSpeakerEntryId: 'entry-1' }, expect.any(Function));
  });

  it('debounces rapid calls within 400ms', () => {
    const socket = makeSocket();
    const stateRef = { current: { meeting: makeMeeting(), user: null } };

    const { result } = renderHook(() => useAdvanceAction('queue:next'), {
      wrapper: makeMutableWrapper(stateRef, socket),
    });

    act(() => result.current.fire());
    act(() => result.current.fire());
    act(() => result.current.fire());

    expect(socket.emit).toHaveBeenCalledTimes(1);
  });

  it('disables during debounce period and re-enables after', () => {
    const socket = makeSocket();
    const stateRef = { current: { meeting: makeMeeting(), user: null } };

    const { result } = renderHook(() => useAdvanceAction('queue:next'), {
      wrapper: makeMutableWrapper(stateRef, socket),
    });

    expect(result.current.disabled).toBe(false);

    act(() => result.current.fire());
    expect(result.current.disabled).toBe(true);

    act(() => vi.advanceTimersByTime(400));
    expect(result.current.disabled).toBe(false);

    // A second fire should now work
    act(() => result.current.fire());
    expect(socket.emit).toHaveBeenCalledTimes(2);
  });

  it('enters cooldown when currentSpeakerEntryId changes and attributed to another user', () => {
    const socket = makeSocket();
    const stateRef = {
      current: { meeting: makeMeeting({ speakerId: 'entry-1' }), user: alice },
    };

    const { result, rerender } = renderHook(() => useAdvanceAction('queue:next'), {
      wrapper: makeMutableWrapper(stateRef, socket),
    });

    expect(result.current.disabled).toBe(false);

    // Another chair (bob) advanced — triggers cooldown
    stateRef.current = {
      meeting: makeMeeting({ speakerId: 'entry-2', lastAdvancementBy: 'github:bob' }),
      user: alice,
    };
    rerender();

    act(() => vi.advanceTimersByTime(0));
    expect(result.current.disabled).toBe(true);

    // fire() should be a no-op during cooldown
    act(() => result.current.fire());
    expect(socket.emit).not.toHaveBeenCalled();
  });

  it('skips cooldown when the speaker change is attributed to the current user', () => {
    const socket = makeSocket();
    const stateRef = {
      current: { meeting: makeMeeting({ speakerId: 'entry-1' }), user: alice },
    };

    const { result, rerender } = renderHook(() => useAdvanceAction('queue:next'), {
      wrapper: makeMutableWrapper(stateRef, socket),
    });

    // Server responds with speaker change attributed to us
    stateRef.current = {
      meeting: makeMeeting({ speakerId: 'entry-2', lastAdvancementBy: 'github:alice' }),
      user: alice,
    };
    rerender();
    act(() => vi.advanceTimersByTime(0));

    // Should NOT enter cooldown
    expect(result.current.disabled).toBe(false);
  });

  it('clears cooldown after 2000ms', () => {
    const socket = makeSocket();
    const stateRef = {
      current: { meeting: makeMeeting({ speakerId: 'entry-1' }), user: alice },
    };

    const { result, rerender } = renderHook(() => useAdvanceAction('queue:next'), {
      wrapper: makeMutableWrapper(stateRef, socket),
    });

    stateRef.current = {
      meeting: makeMeeting({ speakerId: 'entry-2', lastAdvancementBy: 'github:bob' }),
      user: alice,
    };
    rerender();
    act(() => vi.advanceTimersByTime(0));
    expect(result.current.disabled).toBe(true);

    act(() => vi.advanceTimersByTime(2000));
    expect(result.current.disabled).toBe(false);

    // fire() should work again
    act(() => result.current.fire());
    expect(socket.emit).toHaveBeenCalledTimes(1);
  });

  it('does not trigger cooldown on initial render', () => {
    const socket = makeSocket();
    const stateRef = {
      current: { meeting: makeMeeting({ speakerId: 'entry-1' }), user: null },
    };

    const { result } = renderHook(() => useAdvanceAction('queue:next'), {
      wrapper: makeMutableWrapper(stateRef, socket),
    });

    act(() => vi.advanceTimersByTime(0));
    expect(result.current.disabled).toBe(false);
  });

  it('does not trigger cooldown for meeting:nextAgendaItem when speaker changes', () => {
    const socket = makeSocket();
    const stateRef = {
      current: { meeting: makeMeeting({ speakerId: 'entry-1' }), user: alice },
    };

    const { result, rerender } = renderHook(() => useAdvanceAction('meeting:nextAgendaItem'), {
      wrapper: makeMutableWrapper(stateRef, socket),
    });

    stateRef.current = {
      meeting: makeMeeting({ speakerId: 'entry-2', lastAdvancementBy: 'github:bob' }),
      user: alice,
    };
    rerender();
    act(() => vi.advanceTimersByTime(0));
    expect(result.current.disabled).toBe(false);
  });

  it('enters cooldown when the next queue entry is deleted (race with Next Speaker click)', () => {
    // Scenario: chair is about to click Next Speaker to advance to the next
    // queue entry. Before the server processes the click, the next entry is
    // deleted (by its owner). Without the cooldown, the chair could skip
    // past the intended speaker to whoever's now first in line.
    const socket = makeSocket();
    const stateRef = {
      current: {
        meeting: makeMeeting({ speakerId: 'entry-current', queueIds: ['entry-next', 'entry-after'] }),
        user: alice,
      },
    };

    const { result, rerender } = renderHook(() => useAdvanceAction('queue:next'), {
      wrapper: makeMutableWrapper(stateRef, socket),
    });

    expect(result.current.disabled).toBe(false);

    // entry-next is removed; entry-after shifts to position 0
    stateRef.current = {
      meeting: makeMeeting({ speakerId: 'entry-current', queueIds: ['entry-after'] }),
      user: alice,
    };
    rerender();
    act(() => vi.advanceTimersByTime(0));

    expect(result.current.disabled).toBe(true);

    // fire() should be a no-op during cooldown
    act(() => result.current.fire());
    expect(socket.emit).not.toHaveBeenCalled();

    // Cooldown clears after 2000ms
    act(() => vi.advanceTimersByTime(2000));
    expect(result.current.disabled).toBe(false);
  });

  it('does not enter cooldown when a new entry is inserted ahead of the next-up entry', () => {
    // A point-of-order jumping to the front shifts the next-up entry, but
    // the original entry is still in the queue — not a deletion — so the
    // button stays usable.
    const socket = makeSocket();
    const stateRef = {
      current: {
        meeting: makeMeeting({ speakerId: 'entry-current', queueIds: ['entry-a', 'entry-b'] }),
        user: alice,
      },
    };

    const { result, rerender } = renderHook(() => useAdvanceAction('queue:next'), {
      wrapper: makeMutableWrapper(stateRef, socket),
    });

    stateRef.current = {
      meeting: makeMeeting({ speakerId: 'entry-current', queueIds: ['entry-poo', 'entry-a', 'entry-b'] }),
      user: alice,
    };
    rerender();
    act(() => vi.advanceTimersByTime(0));

    expect(result.current.disabled).toBe(false);
  });

  it('does not enter cooldown when the queue gains its first entry', () => {
    // Loading into (or watching) a meeting whose queue fills up from empty
    // must not disable the button — there was no next-up entry to delete.
    const socket = makeSocket();
    const stateRef = {
      current: {
        meeting: makeMeeting({ speakerId: 'entry-current', queueIds: [] }),
        user: alice,
      },
    };

    const { result, rerender } = renderHook(() => useAdvanceAction('queue:next'), {
      wrapper: makeMutableWrapper(stateRef, socket),
    });

    stateRef.current = {
      meeting: makeMeeting({ speakerId: 'entry-current', queueIds: ['entry-1'] }),
      user: alice,
    };
    rerender();
    act(() => vi.advanceTimersByTime(0));

    expect(result.current.disabled).toBe(false);
  });

  it('does not enter cooldown when the next-up entry is reordered but stays in the queue', () => {
    // A reorder that pushes a different entry to the front is not a
    // deletion — the original next-up entry is still queued.
    const socket = makeSocket();
    const stateRef = {
      current: {
        meeting: makeMeeting({ speakerId: 'entry-current', queueIds: ['entry-a', 'entry-b'] }),
        user: alice,
      },
    };

    const { result, rerender } = renderHook(() => useAdvanceAction('queue:next'), {
      wrapper: makeMutableWrapper(stateRef, socket),
    });

    stateRef.current = {
      meeting: makeMeeting({ speakerId: 'entry-current', queueIds: ['entry-b', 'entry-a'] }),
      user: alice,
    };
    rerender();
    act(() => vi.advanceTimersByTime(0));

    expect(result.current.disabled).toBe(false);
  });

  it('does not enter cooldown when only later queue entries change', () => {
    // Reordering or deleting entries past position 0 should NOT trigger
    // cooldown — the next-up entry is unchanged so the button is still safe.
    const socket = makeSocket();
    const stateRef = {
      current: {
        meeting: makeMeeting({ speakerId: 'entry-current', queueIds: ['entry-next', 'entry-a', 'entry-b'] }),
        user: alice,
      },
    };

    const { result, rerender } = renderHook(() => useAdvanceAction('queue:next'), {
      wrapper: makeMutableWrapper(stateRef, socket),
    });

    stateRef.current = {
      meeting: makeMeeting({ speakerId: 'entry-current', queueIds: ['entry-next', 'entry-b'] }),
      user: alice,
    };
    rerender();
    act(() => vi.advanceTimersByTime(0));

    expect(result.current.disabled).toBe(false);
  });

  it('does not enter cooldown when self-advancing through the queue (next entry shifts as expected)', () => {
    // When the current user advances, both the speaker and the next entry
    // change — but it's the expected outcome of their own action, so no
    // cooldown.
    const socket = makeSocket();
    const stateRef = {
      current: {
        meeting: makeMeeting({ speakerId: 'entry-1', queueIds: ['entry-2', 'entry-3'] }),
        user: alice,
      },
    };

    const { result, rerender } = renderHook(() => useAdvanceAction('queue:next'), {
      wrapper: makeMutableWrapper(stateRef, socket),
    });

    // Self-advances: entry-2 becomes the speaker, entry-3 becomes next.
    stateRef.current = {
      meeting: makeMeeting({ speakerId: 'entry-2', queueIds: ['entry-3'], lastAdvancementBy: 'github:alice' }),
      user: alice,
    };
    rerender();
    act(() => vi.advanceTimersByTime(0));

    expect(result.current.disabled).toBe(false);
  });

  it('does not enter cooldown for queue changes on meeting:nextAgendaItem', () => {
    const socket = makeSocket();
    const stateRef = {
      current: {
        meeting: makeMeeting({ speakerId: 'entry-current', queueIds: ['entry-a'] }),
        user: alice,
      },
    };

    const { result, rerender } = renderHook(() => useAdvanceAction('meeting:nextAgendaItem'), {
      wrapper: makeMutableWrapper(stateRef, socket),
    });

    stateRef.current = {
      meeting: makeMeeting({ speakerId: 'entry-current', queueIds: [] }),
      user: alice,
    };
    rerender();
    act(() => vi.advanceTimersByTime(0));

    expect(result.current.disabled).toBe(false);
  });

  it('enters cooldown when speaker changes with no attribution', () => {
    const socket = makeSocket();
    const stateRef = {
      current: { meeting: makeMeeting({ speakerId: 'entry-1' }), user: alice },
    };

    const { result, rerender } = renderHook(() => useAdvanceAction('queue:next'), {
      wrapper: makeMutableWrapper(stateRef, socket),
    });

    // Speaker changes with no attribution (e.g. reconnection state sync)
    stateRef.current = {
      meeting: makeMeeting({ speakerId: 'entry-2' }),
      user: alice,
    };
    rerender();
    act(() => vi.advanceTimersByTime(0));
    expect(result.current.disabled).toBe(true);
  });
});
