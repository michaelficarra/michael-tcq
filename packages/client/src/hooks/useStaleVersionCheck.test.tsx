/**
 * Tests for `useStaleVersionCheck` — the polling hook that watches
 * `/api/version` for a Cloud Run revision change and flips to `true`
 * once a poll observes a revision different from the WebSocket-reported
 * baseline.
 *
 * Uses fake timers to drive the poll interval; `waitFor` is avoided
 * because its internal retry loop conflicts with `vi.useFakeTimers()`.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useStaleVersionCheck } from './useStaleVersionCheck.js';

function mockVersionFetch(responses: Array<{ status: number; body?: unknown }>) {
  let i = 0;
  return vi.fn(async (url: string) => {
    expect(url).toBe('/api/version');
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return {
      status: r.status,
      json: async () => r.body,
    } as unknown as Response;
  });
}

describe('useStaleVersionCheck', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('does not poll while baselineRevision is null', async () => {
    const fetchMock = mockVersionFetch([{ status: 200, body: { sha: 'a', revision: 'r-x' } }]);
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useStaleVersionCheck(null, 1000));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(result.current).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stays false while polls match the baseline revision', async () => {
    vi.stubGlobal('fetch', mockVersionFetch([{ status: 200, body: { sha: 'a', revision: 'r-1' } }]));

    const { result } = renderHook(() => useStaleVersionCheck('r-1', 1000));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(result.current).toBe(false);
  });

  it('flips to true when a poll observes a revision different from the baseline', async () => {
    vi.stubGlobal('fetch', mockVersionFetch([{ status: 200, body: { sha: 'b', revision: 'r-2' } }]));

    const { result } = renderHook(() => useStaleVersionCheck('r-1', 1000));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current).toBe(true);
  });

  it('stays false when the endpoint returns 204 (no GIT_SHA / local dev)', async () => {
    vi.stubGlobal('fetch', mockVersionFetch([{ status: 204 }]));

    const { result } = renderHook(() => useStaleVersionCheck('r-1', 1000));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(result.current).toBe(false);
  });

  it('stays false when revision is null in the response', async () => {
    vi.stubGlobal('fetch', mockVersionFetch([{ status: 200, body: { sha: 'a', revision: null } }]));

    const { result } = renderHook(() => useStaleVersionCheck('r-1', 1000));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(result.current).toBe(false);
  });

  it('ignores fetch errors and keeps polling', async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call++;
      if (call === 1) throw new Error('network down');
      return { status: 200, json: async () => ({ sha: 'b', revision: 'r-2' }) } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useStaleVersionCheck('r-1', 1000));

    // First poll throws — hook stays false.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current).toBe(false);

    // Next poll succeeds and reports a different revision.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(result.current).toBe(true);
  });

  it('starts polling once a baseline arrives', async () => {
    const fetchMock = mockVersionFetch([{ status: 200, body: { sha: 'b', revision: 'r-2' } }]);
    vi.stubGlobal('fetch', fetchMock);

    const { result, rerender } = renderHook(
      ({ baseline }: { baseline: string | null }) => useStaleVersionCheck(baseline, 1000),
      { initialProps: { baseline: null as string | null } },
    );

    // No baseline → no polling, no flip.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current).toBe(false);

    // Baseline arrives → poll fires and observes a diverged revision.
    rerender({ baseline: 'r-1' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current).toBe(true);
  });
});
