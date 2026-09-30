import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { MeetingState, PollRequest, User } from '@tcq/shared';
import { TestMeetingProvider } from '../test/TestMeetingProvider.js';
import { makeMeeting as buildMeeting } from '../test/makeMeeting.js';
import { usePollRequestGuard } from './usePollRequestGuard.js';

const alice: User = {
  provider: 'github',
  accountId: 'alice',
  handle: 'alice',
  name: 'Alice',
  organisation: '',
  avatarUrl: 'https://github.com/alice.png?size=80',
};

const request = (id: string, requesterId: string): PollRequest => ({
  id,
  requesterId,
  multiSelect: true,
  options: [
    { id: `${id}-a`, emoji: '👍', label: 'Yes' },
    { id: `${id}-b`, emoji: '👎', label: 'No' },
  ],
  requestedAt: '2026-01-01T00:00:00.000Z',
});

function makeMeeting(pollRequests?: PollRequest[]): MeetingState {
  return buildMeeting(pollRequests ? { pollRequests } : {}, { chairIds: ['github:alice'] });
}

/**
 * Render the hook under a meeting provider whose state can be swapped
 * between renders: `setMeeting(next)` re-renders with the new snapshot,
 * the way a server delta would.
 */
function setup(initial: MeetingState) {
  const box = { meeting: initial };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <TestMeetingProvider meeting={box.meeting} user={alice}>
      {children}
    </TestMeetingProvider>
  );
  const hook = renderHook(() => usePollRequestGuard(), { wrapper });
  const setMeeting = (next: MeetingState) => {
    box.meeting = next;
    hook.rerender();
    // Let the effect's deferred setState land.
    act(() => {
      vi.advanceTimersByTime(0);
    });
  };
  return { ...hook, setMeeting };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('usePollRequestGuard', () => {
  it('runs the action and then debounces repeats for a short window', () => {
    const { result } = setup(makeMeeting([request('r1', 'github:bob')]));
    const fn = vi.fn();

    act(() => result.current.guard('r1', fn));
    expect(fn).toHaveBeenCalledTimes(1);
    expect(result.current.disabled).toBe(true);
    expect(result.current.coolingDown).toBe(false);

    act(() => result.current.guard('r1', fn));
    expect(fn).toHaveBeenCalledTimes(1); // swallowed

    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(result.current.disabled).toBe(false);
    act(() => result.current.guard('r1', fn));
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not cool down on the first state seen', () => {
    const { result } = setup(makeMeeting([request('r1', 'github:bob')]));
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(result.current.coolingDown).toBe(false);
  });

  it('cools down when someone else adds, replaces, or removes a request', () => {
    const { result, setMeeting } = setup(makeMeeting([request('r1', 'github:bob')]));
    const fn = vi.fn();

    // Added by another participant.
    setMeeting(makeMeeting([request('r1', 'github:bob'), request('r2', 'github:carol')]));
    expect(result.current.coolingDown).toBe(true);
    expect(result.current.disabled).toBe(true);
    act(() => result.current.guard('r1', fn));
    expect(fn).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current.coolingDown).toBe(false);

    // Revised by its requester (same author, new id).
    setMeeting(makeMeeting([request('r3', 'github:bob'), request('r2', 'github:carol')]));
    expect(result.current.coolingDown).toBe(true);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current.coolingDown).toBe(false);

    // Removed by another chair.
    setMeeting(makeMeeting([request('r2', 'github:carol')]));
    expect(result.current.coolingDown).toBe(true);
  });

  it('extends rather than drops the cooldown when a second change arrives mid-window', () => {
    const { result, setMeeting } = setup(makeMeeting([request('r1', 'github:bob')]));
    setMeeting(makeMeeting([request('r1', 'github:bob'), request('r2', 'github:carol')]));
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    setMeeting(makeMeeting([request('r2', 'github:carol')]));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    // 2.5s after the first change but only 1s after the second: still held.
    expect(result.current.coolingDown).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.coolingDown).toBe(false);
  });

  it('does not cool down for removals we fired ourselves', () => {
    const { result, setMeeting } = setup(makeMeeting([request('r1', 'github:bob'), request('r2', 'github:carol')]));
    act(() => result.current.guard('r1', () => {}));
    // Server confirms our dismiss: r1 disappears.
    setMeeting(makeMeeting([request('r2', 'github:carol')]));
    expect(result.current.coolingDown).toBe(false);
  });

  it('does not cool down when the current user files, revises, or withdraws their own request', () => {
    const { result, setMeeting } = setup(makeMeeting([request('r1', 'github:bob')]));
    // Alice files, revises (old id out, new id in), then withdraws via the guard.
    setMeeting(makeMeeting([request('r1', 'github:bob'), request('a1', 'github:alice')]));
    setMeeting(makeMeeting([request('r1', 'github:bob'), request('a2', 'github:alice')]));
    act(() => result.current.guard('a2', () => {}));
    setMeeting(makeMeeting([request('r1', 'github:bob')]));
    expect(result.current.coolingDown).toBe(false);
  });

  it("cools down when a chair dismisses the current user's own request (their layout shifts)", () => {
    const { result, setMeeting } = setup(makeMeeting([request('a1', 'github:alice')]));
    setMeeting(makeMeeting(undefined));
    expect(result.current.coolingDown).toBe(true);
  });

  it('cools down when the list is cleared by an agenda advance', () => {
    const { result, setMeeting } = setup(makeMeeting([request('r1', 'github:bob')]));
    setMeeting(makeMeeting(undefined));
    expect(result.current.coolingDown).toBe(true);
  });
});
