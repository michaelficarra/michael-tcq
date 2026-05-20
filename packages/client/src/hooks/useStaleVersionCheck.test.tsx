/**
 * Tests for `useStaleVersionCheck` — the polling hook that watches
 * `/api/version` for a Cloud Run revision change and flips to `true`
 * once the revision diverges from the first observed value.
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

  it('stays false while the revision matches the baseline', async () => {
    vi.stubGlobal('fetch', mockVersionFetch([{ status: 200, body: { sha: 'a', revision: 'r-1' } }]));

    const { result } = renderHook(() => useStaleVersionCheck(1000));

    // Flush the initial poll's microtasks (the fetch resolves immediately
    // because the mock awaits no real I/O).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(result.current).toBe(false);
  });

  it('flips to true when a later poll sees a different revision', async () => {
    vi.stubGlobal(
      'fetch',
      mockVersionFetch([
        { status: 200, body: { sha: 'a', revision: 'r-1' } },
        { status: 200, body: { sha: 'b', revision: 'r-2' } },
      ]),
    );

    const { result } = renderHook(() => useStaleVersionCheck(1000));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(result.current).toBe(true);
  });

  it('stays false when the endpoint returns 204 (no GIT_SHA / local dev)', async () => {
    vi.stubGlobal('fetch', mockVersionFetch([{ status: 204 }]));

    const { result } = renderHook(() => useStaleVersionCheck(1000));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(result.current).toBe(false);
  });

  it('stays false when revision is null in the response', async () => {
    vi.stubGlobal(
      'fetch',
      mockVersionFetch([
        { status: 200, body: { sha: 'a', revision: null } },
        { status: 200, body: { sha: 'b', revision: null } },
      ]),
    );

    const { result } = renderHook(() => useStaleVersionCheck(1000));

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
      if (call === 2) return { status: 200, json: async () => ({ sha: 'a', revision: 'r-1' }) } as unknown as Response;
      return { status: 200, json: async () => ({ sha: 'b', revision: 'r-2' }) } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useStaleVersionCheck(1000));

    // Initial poll throws → baseline still unset.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current).toBe(false);

    // Second poll succeeds → baseline = r-1.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(result.current).toBe(false);

    // Third poll diverges → stale.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(result.current).toBe(true);
  });
});
