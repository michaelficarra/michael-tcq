import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { AuthProvider, useAuth } from './AuthContext.js';

// Mock fetch globally — every test stubs the responses it expects.
const mockFetch = vi.fn();

// In-memory BroadcastChannel implementation used in tests. The real
// BroadcastChannel API does not deliver messages between instances in the
// same browsing context, which makes it hard to write a same-window test
// asserting that AuthProvider's outgoing post is received by another
// listener. The mock relaxes that constraint and delivers asynchronously
// (via a microtask) to mirror the real API's async semantics.
class MockBroadcastChannel {
  static byName = new Map<string, Set<MockBroadcastChannel>>();
  onmessage: ((event: { data: unknown }) => void) | null = null;
  closed = false;

  constructor(public name: string) {
    if (!MockBroadcastChannel.byName.has(name)) {
      MockBroadcastChannel.byName.set(name, new Set());
    }
    MockBroadcastChannel.byName.get(name)!.add(this);
  }

  postMessage(data: unknown) {
    const peers = MockBroadcastChannel.byName.get(this.name);
    if (!peers) return;
    for (const peer of peers) {
      if (peer === this || peer.closed) continue;
      queueMicrotask(() => {
        peer.onmessage?.({ data });
      });
    }
  }

  close() {
    this.closed = true;
    MockBroadcastChannel.byName.get(this.name)?.delete(this);
  }

  static reset() {
    MockBroadcastChannel.byName.clear();
  }
}

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  vi.stubGlobal('BroadcastChannel', MockBroadcastChannel);
  MockBroadcastChannel.reset();
  mockFetch.mockReset();
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const ALICE = { ghid: 1, ghUsername: 'alice', name: 'Alice', organisation: 'ACME' };
const BOB = { ghid: 2, ghUsername: 'bob', name: 'Bob', organisation: 'ACME' };

function mockMeOnce(user: typeof ALICE | null, opts: { mockAuth?: boolean; isAdmin?: boolean } = {}) {
  if (user === null) {
    mockFetch.mockResolvedValueOnce({ ok: false });
  } else {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ...user, mockAuth: !!opts.mockAuth, isAdmin: !!opts.isAdmin }),
    });
  }
}

function CurrentUser() {
  const { user, loading } = useAuth();
  if (loading) return <span>loading</span>;
  return <span>{user ? user.ghUsername : 'anon'}</span>;
}

describe('AuthContext cross-tab sync', () => {
  it('seeds the localStorage marker on first read without broadcasting', async () => {
    mockMeOnce(ALICE);
    // Observer attaches before the provider mounts so we can assert it
    // never receives a message during the initial bootstrap.
    const observer = new BroadcastChannel('tcq:auth');
    const received = vi.fn();
    observer.onmessage = received;

    render(
      <AuthProvider>
        <CurrentUser />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByText('alice')).toBeInTheDocument());
    // Drain microtasks so any erroneously queued broadcast would have arrived.
    await act(async () => {
      await Promise.resolve();
    });

    expect(localStorage.getItem('tcq:auth:ghid')).toBe('1');
    expect(received).not.toHaveBeenCalled();
    observer.close();
  });

  it('does not broadcast when the marker matches the fetched user', async () => {
    localStorage.setItem('tcq:auth:ghid', '1');
    mockMeOnce(ALICE);

    const observer = new BroadcastChannel('tcq:auth');
    const received = vi.fn();
    observer.onmessage = received;

    render(
      <AuthProvider>
        <CurrentUser />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByText('alice')).toBeInTheDocument());
    await act(async () => {
      await Promise.resolve();
    });

    expect(received).not.toHaveBeenCalled();
    observer.close();
  });

  it('broadcasts when the fetched identity differs from the marker (e.g., post-login bootstrap)', async () => {
    // Simulate Tab A returning from /auth/github — last-known identity was
    // logged-out, the fresh /api/me reveals a logged-in user.
    localStorage.setItem('tcq:auth:ghid', '');
    mockMeOnce(ALICE);

    const observer = new BroadcastChannel('tcq:auth');
    const received = vi.fn();
    observer.onmessage = received;

    render(
      <AuthProvider>
        <CurrentUser />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByText('alice')).toBeInTheDocument());
    await waitFor(() => expect(received).toHaveBeenCalledTimes(1));
    expect(received.mock.calls[0]?.[0]?.data).toEqual({ type: 'auth-changed' });
    expect(localStorage.getItem('tcq:auth:ghid')).toBe('1');
    observer.close();
  });

  it('broadcasts a logout (ghid → empty) when the marker held a previous user', async () => {
    localStorage.setItem('tcq:auth:ghid', '1');
    mockMeOnce(null);

    const observer = new BroadcastChannel('tcq:auth');
    const received = vi.fn();
    observer.onmessage = received;

    render(
      <AuthProvider>
        <CurrentUser />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByText('anon')).toBeInTheDocument());
    await waitFor(() => expect(received).toHaveBeenCalledTimes(1));
    expect(localStorage.getItem('tcq:auth:ghid')).toBe('');
    observer.close();
  });

  it('refetches /api/me when an auth-changed message arrives on the channel', async () => {
    localStorage.setItem('tcq:auth:ghid', '1');
    mockMeOnce(ALICE);
    // Second fetch — peer broadcast indicates identity may have changed.
    mockMeOnce(BOB);

    render(
      <AuthProvider>
        <CurrentUser />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByText('alice')).toBeInTheDocument());

    // A peer tab updates the marker (this is what the broadcasting tab
    // would have done before posting) so the receiver doesn't re-broadcast
    // and create a feedback loop.
    localStorage.setItem('tcq:auth:ghid', '2');
    const peer = new BroadcastChannel('tcq:auth');
    peer.postMessage({ type: 'auth-changed' });

    await waitFor(() => expect(screen.getByText('bob')).toBeInTheDocument());
    expect(mockFetch).toHaveBeenCalledTimes(2);
    peer.close();
  });

  it('switchUser triggers a broadcast when the identity changes', async () => {
    localStorage.setItem('tcq:auth:ghid', '1');
    mockMeOnce(ALICE);
    // Sequence triggered by switchUser():
    //   POST /api/dev/switch-user → fetchMe() → /api/me returns BOB.
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(BOB) });
    mockMeOnce(BOB);

    function SwitchHarness() {
      const { user, switchUser } = useAuth();
      return (
        <>
          <span>{user?.ghUsername ?? 'anon'}</span>
          <button onClick={() => switchUser('bob')}>switch</button>
        </>
      );
    }

    const observer = new BroadcastChannel('tcq:auth');
    const received = vi.fn();
    observer.onmessage = received;

    render(
      <AuthProvider>
        <SwitchHarness />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByText('alice')).toBeInTheDocument());

    await act(async () => {
      screen.getByRole('button', { name: 'switch' }).click();
    });

    await waitFor(() => expect(screen.getByText('bob')).toBeInTheDocument());
    await waitFor(() => expect(received).toHaveBeenCalledTimes(1));
    expect(received.mock.calls[0]?.[0]?.data).toEqual({ type: 'auth-changed' });
    expect(localStorage.getItem('tcq:auth:ghid')).toBe('2');
    observer.close();
  });

  it('renders without throwing when BroadcastChannel is unavailable', async () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    localStorage.setItem('tcq:auth:ghid', '');
    mockMeOnce(ALICE);

    render(
      <AuthProvider>
        <CurrentUser />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByText('alice')).toBeInTheDocument());
    expect(localStorage.getItem('tcq:auth:ghid')).toBe('1');
  });
});
