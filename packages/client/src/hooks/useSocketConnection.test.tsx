/**
 * Tests for `useSocketConnection` — the React hook that owns the
 * client's Socket.IO connection, dispatches state into MeetingContext,
 * and runs the gap-detect / resync logic.
 *
 * The Phase B–D server tests verify a *surrogate* of this logic —
 * structurally identical, but a separate implementation. These tests
 * cover the production hook directly, including the React-specific
 * concerns the surrogate doesn't simulate:
 *
 *   - The version cursor lives in a `useRef`, not state, so back-to-back
 *     deltas in the same JS turn each see the up-to-date cursor before
 *     the next one runs (a `useState`-based mirror would gap-detect on
 *     v2 because the listener would still see the previous render's
 *     `lastSeen`).
 *   - Connection lifecycle: `connect`, `disconnect`, browser
 *     `offline` / `online`, `userGhid`-driven socket rebuild, useEffect
 *     cleanup on unmount.
 *
 * The mock socket lives in `../test/mockSocket.ts`. `vi.mock('socket.io-client')`
 * swaps out the real `io()` factory for a vitest-controlled stub so each
 * `useSocketConnection` mount picks up a fresh harness we can drive.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { io } from 'socket.io-client';
import { createMockSocket, type MockSocketHarness } from '../test/mockSocket.js';
import { MeetingProvider, useMeetingState } from '../contexts/MeetingContext.js';
import { useSocketConnection } from './useSocketConnection.js';
import { makeMeeting } from '../test/makeMeeting.js';

// `socket.io-client` is mocked so we can intercept every `io()` call
// the hook makes. The factory needs to be a vi.fn so individual tests
// can inspect call counts / args.
vi.mock('socket.io-client', () => ({
  io: vi.fn(),
}));

// The hook also imports `socket.io-msgpack-parser` and passes it as an
// option to `io()`. The mocked io ignores its options, but stubbing
// the import avoids loading the real parser (which has a transitive
// dependency on Node Buffer that's awkward in jsdom).
vi.mock('socket.io-msgpack-parser', () => ({ default: {} }));

const ioMock = vi.mocked(io);

let harnesses: MockSocketHarness[];

beforeEach(() => {
  harnesses = [];
  ioMock.mockReset();
  ioMock.mockImplementation(() => {
    const h = createMockSocket();
    harnesses.push(h);
    return h.socket;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Render the hook inside a real `MeetingProvider`, with a thin reader
 * that exposes the current state alongside the hook's return value.
 * Tests use the returned `result` to read state and `rerender` to
 * change props (e.g. the userGhid swap test).
 */
interface HookProps {
  meetingId: string;
  userGhid: number | null;
}

function renderHookInProvider(initialProps: HookProps = { meetingId: 'test-meeting', userGhid: 1 }) {
  return renderHook(
    ({ meetingId, userGhid }: HookProps) => {
      const socket = useSocketConnection(meetingId, userGhid);
      const state = useMeetingState();
      return { socket, state };
    },
    {
      wrapper: ({ children }: { children: ReactNode }) => <MeetingProvider>{children}</MeetingProvider>,
      initialProps,
    },
  );
}

/** Convenience: build a queue:closedChanged delta payload. */
function closedDelta(version: number, closed = true) {
  return { version, closed };
}

// ---------------------------------------------------------------------------
// Delta handling (H.1 – H.6)
// ---------------------------------------------------------------------------

describe('useSocketConnection — delta handling', () => {
  it('H.1: dispatches an in-order delta and advances the cursor', () => {
    const { result } = renderHookInProvider();
    const h = harnesses[0];

    // The hook attaches its listeners synchronously inside useEffect,
    // so by the time renderHook returns, `state` and the per-delta
    // listeners are wired up. Bootstrap the cursor with a `state`
    // event then deliver an in-order delta.
    act(() => {
      h.deliver('state', makeMeeting());
      h.deliver('queue:closedChanged', closedDelta(1, true));
    });

    expect(result.current.state.lastSeenVersion).toBe(1);
    expect(result.current.state.meeting?.queue.closed).toBe(true);
    // No gap was seen, so no resync should have been requested.
    expect(h.emitted.find((e) => e.event === 'state:resync')).toBeUndefined();
  });

  it('H.2: a forward gap emits state:resync and does not dispatch', () => {
    const { result } = renderHookInProvider();
    const h = harnesses[0];

    act(() => {
      h.deliver('state', makeMeeting());
    });
    expect(result.current.state.lastSeenVersion).toBe(0);
    expect(result.current.state.meeting?.queue.closed).toBe(false);

    act(() => {
      // Skip v1, v2 — deliver v3 directly. Cursor was 0, expected 1,
      // got 3 → gap.
      h.deliver('queue:closedChanged', closedDelta(3, true));
    });

    // Reducer should NOT have applied the delta.
    expect(result.current.state.lastSeenVersion).toBe(0);
    expect(result.current.state.meeting?.queue.closed).toBe(false);
    // Hook should have asked for a fresh state.
    const resyncs = h.emitted.filter((e) => e.event === 'state:resync');
    expect(resyncs).toHaveLength(1);
  });

  it('H.3: a late / duplicate delta is silently dropped', () => {
    const { result } = renderHookInProvider();
    const h = harnesses[0];

    act(() => {
      // Bootstrap at v5 — anything <= 5 is now stale.
      h.deliver('state', makeMeeting({ operational: { version: 5, lastConnectionTime: '', maxConcurrent: 0 } }));
    });
    expect(result.current.state.lastSeenVersion).toBe(5);

    const emittedBefore = h.emitted.length;
    act(() => {
      h.deliver('queue:closedChanged', closedDelta(3, true));
    });

    // No state change, no resync — just dropped.
    expect(result.current.state.lastSeenVersion).toBe(5);
    expect(result.current.state.meeting?.queue.closed).toBe(false);
    expect(h.emitted.length).toBe(emittedBefore);
  });

  it('H.4: a state event re-seeds the cursor synchronously', () => {
    const { result } = renderHookInProvider();
    const h = harnesses[0];

    // Single act: state event then a delta in the same JS turn. If
    // the cursor weren't reseeded synchronously inside the state
    // listener (e.g. if it lived in React state instead of a ref),
    // the delta listener would still see lastSeen = null and either
    // drop the delta or gap-detect.
    act(() => {
      h.deliver('state', makeMeeting({ operational: { version: 5, lastConnectionTime: '', maxConcurrent: 0 } }));
      h.deliver('queue:closedChanged', closedDelta(6, true));
    });

    expect(result.current.state.lastSeenVersion).toBe(6);
    expect(result.current.state.meeting?.queue.closed).toBe(true);
    expect(h.emitted.find((e) => e.event === 'state:resync')).toBeUndefined();
  });

  it('H.5: a delta arriving before any bootstrap state is dropped silently', () => {
    const { result } = renderHookInProvider();
    const h = harnesses[0];

    const emittedBefore = h.emitted.length;
    act(() => {
      h.deliver('queue:closedChanged', closedDelta(1, true));
    });

    // No state has loaded, so the delta has no version cursor to
    // reconcile against. The hook's `if (lastSeen === null) return;`
    // skips both the dispatch AND the resync emit.
    expect(result.current.state.lastSeenVersion).toBeNull();
    expect(result.current.state.meeting).toBeNull();
    expect(h.emitted.length).toBe(emittedBefore);
  });

  it('H.6: back-to-back in-order deltas in the same turn all advance the cursor', () => {
    const { result } = renderHookInProvider();
    const h = harnesses[0];

    act(() => {
      h.deliver('state', makeMeeting());
      // Three deltas, all in the same synchronous block. The ref-based
      // cursor must advance synchronously inside each listener call so
      // the next delta sees the new `lastSeen`. A state-based mirror
      // would still see lastSeen=0 on v2 and v3 and gap-detect both.
      h.deliver('queue:closedChanged', closedDelta(1, true));
      h.deliver('queue:closedChanged', closedDelta(2, false));
      h.deliver('queue:closedChanged', closedDelta(3, true));
    });

    expect(result.current.state.lastSeenVersion).toBe(3);
    expect(result.current.state.meeting?.queue.closed).toBe(true);
    expect(h.emitted.find((e) => e.event === 'state:resync')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Connection lifecycle (H.7 – H.10)
// ---------------------------------------------------------------------------

describe('useSocketConnection — connection lifecycle', () => {
  it('H.7: connect fires setConnected:true and re-emits join; disconnect flips it back', () => {
    const { result } = renderHookInProvider({ meetingId: 'meeting-xyz', userGhid: 1 });
    const h = harnesses[0];

    expect(result.current.state.connected).toBe(false);

    act(() => {
      h.simulateConnect();
    });
    expect(result.current.state.connected).toBe(true);
    const firstJoin = h.emitted.find((e) => e.event === 'join');
    expect(firstJoin).toBeDefined();
    expect(firstJoin!.args).toEqual(['meeting-xyz']);

    act(() => {
      h.simulateDisconnect();
    });
    expect(result.current.state.connected).toBe(false);

    // A subsequent reconnect re-emits join (Socket.IO does this on its
    // own in production via the `connect` event handler in the hook).
    act(() => {
      h.simulateConnect();
    });
    expect(result.current.state.connected).toBe(true);
    const joins = h.emitted.filter((e) => e.event === 'join');
    expect(joins).toHaveLength(2);
    expect(joins[1].args).toEqual(['meeting-xyz']);
  });

  it('H.8: unmount disconnects the socket and removes window listeners', () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const { unmount } = renderHookInProvider();
    const h = harnesses[0];

    expect(h.disconnected).toBe(false);

    unmount();

    expect(h.disconnected).toBe(true);
    // Both `offline` and `online` listeners attached during the
    // effect must be removed on cleanup. `removeEventListener` could
    // also be called for unrelated reasons, so filter by type.
    const removedTypes = removeSpy.mock.calls.map((c) => c[0]);
    expect(removedTypes).toContain('offline');
    expect(removedTypes).toContain('online');
  });

  it('H.9: changing userGhid tears down the existing socket and creates a new one', () => {
    const { rerender } = renderHookInProvider({ meetingId: 'meeting', userGhid: 1 });
    expect(harnesses).toHaveLength(1);
    const first = harnesses[0];
    expect(first.disconnected).toBe(false);

    rerender({ meetingId: 'meeting', userGhid: 2 });

    // The old socket was torn down and a fresh one created. Both
    // observable through the harness queue and the io() call count.
    expect(first.disconnected).toBe(true);
    expect(harnesses).toHaveLength(2);
    expect(harnesses[1].disconnected).toBe(false);
    expect(ioMock).toHaveBeenCalledTimes(2);
  });

  it('H.10: a browser offline event dispatches setConnected:false ahead of the WS detecting', () => {
    const { result } = renderHookInProvider();
    const h = harnesses[0];

    // Establish a connected state first so the offline → connected
    // transition is meaningful.
    act(() => {
      h.simulateConnect();
    });
    expect(result.current.state.connected).toBe(true);

    // Fire the browser-level event without touching the socket. The
    // hook listens for window.offline so it can update the indicator
    // before Socket.IO's ping timeout (typically a few seconds)
    // detects the dropped connection.
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(result.current.state.connected).toBe(false);
    // The mock socket was not disconnected by this — only the
    // `connected` reducer flag was flipped.
    expect(h.disconnected).toBe(false);
  });
});
