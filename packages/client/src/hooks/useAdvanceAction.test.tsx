import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { MeetingState, User } from '@tcq/shared';
import { useAdvanceAction } from './useAdvanceAction.js';
import { MeetingStateContext, MeetingDispatchContext, type MeetingContextState } from '../contexts/MeetingContext.js';
import { SocketContext, type TypedSocket } from '../contexts/SocketContext.js';

const alice: User = { ghid: 1, ghUsername: 'alice', name: 'Alice', organisation: 'ACME' };

/** Create a minimal meeting state for testing. */
function makeMeeting(overrides?: Partial<MeetingState>): MeetingState {
  return {
    id: 'test-meeting',
    users: {},
    chairIds: [],
    agenda: [],
    currentAgendaItemId: undefined,
    currentSpeakerEntryId: undefined,
    currentTopicEntryId: undefined,
    queueEntries: {},
    queuedSpeakerIds: [],
    queueClosed: false,
    log: [],
    currentTopicSpeakers: [],
    ...overrides,
  };
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
      current: { meeting: makeMeeting({ currentSpeakerEntryId: 'entry-1' }), user: null },
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
      current: { meeting: makeMeeting({ currentSpeakerEntryId: 'entry-1' }), user: alice },
    };

    const { result, rerender } = renderHook(() => useAdvanceAction('queue:next'), {
      wrapper: makeMutableWrapper(stateRef, socket),
    });

    expect(result.current.disabled).toBe(false);

    // Another chair (bob) advanced — triggers cooldown
    stateRef.current = {
      meeting: makeMeeting({ currentSpeakerEntryId: 'entry-2', lastSpeakerAdvancementAttributedTo: 'bob' }),
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
      current: { meeting: makeMeeting({ currentSpeakerEntryId: 'entry-1' }), user: alice },
    };

    const { result, rerender } = renderHook(() => useAdvanceAction('queue:next'), {
      wrapper: makeMutableWrapper(stateRef, socket),
    });

    // Server responds with speaker change attributed to us
    stateRef.current = {
      meeting: makeMeeting({ currentSpeakerEntryId: 'entry-2', lastSpeakerAdvancementAttributedTo: 'alice' }),
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
      current: { meeting: makeMeeting({ currentSpeakerEntryId: 'entry-1' }), user: alice },
    };

    const { result, rerender } = renderHook(() => useAdvanceAction('queue:next'), {
      wrapper: makeMutableWrapper(stateRef, socket),
    });

    stateRef.current = {
      meeting: makeMeeting({ currentSpeakerEntryId: 'entry-2', lastSpeakerAdvancementAttributedTo: 'bob' }),
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
      current: { meeting: makeMeeting({ currentSpeakerEntryId: 'entry-1' }), user: null },
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
      current: { meeting: makeMeeting({ currentSpeakerEntryId: 'entry-1' }), user: alice },
    };

    const { result, rerender } = renderHook(() => useAdvanceAction('meeting:nextAgendaItem'), {
      wrapper: makeMutableWrapper(stateRef, socket),
    });

    stateRef.current = {
      meeting: makeMeeting({ currentSpeakerEntryId: 'entry-2', lastSpeakerAdvancementAttributedTo: 'bob' }),
      user: alice,
    };
    rerender();
    act(() => vi.advanceTimersByTime(0));
    expect(result.current.disabled).toBe(false);
  });

  it('enters cooldown when speaker changes with no attribution', () => {
    const socket = makeSocket();
    const stateRef = {
      current: { meeting: makeMeeting({ currentSpeakerEntryId: 'entry-1' }), user: alice },
    };

    const { result, rerender } = renderHook(() => useAdvanceAction('queue:next'), {
      wrapper: makeMutableWrapper(stateRef, socket),
    });

    // Speaker changes with no attribution (e.g. reconnection state sync)
    stateRef.current = {
      meeting: makeMeeting({ currentSpeakerEntryId: 'entry-2' }),
      user: alice,
    };
    rerender();
    act(() => vi.advanceTimersByTime(0));
    expect(result.current.disabled).toBe(true);
  });
});
