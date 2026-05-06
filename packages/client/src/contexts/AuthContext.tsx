/**
 * Authentication context.
 *
 * Fetches the current user from /api/me on mount. Provides the user
 * (or null if not authenticated), a loading flag, and a mockAuth flag
 * to all components.
 *
 * When OAuth is not configured on the server, mock auth sets a fake
 * user automatically, so the app behaves the same way — just with a
 * mock identity. The mockAuth flag lets the UI show a dev user-switcher.
 */

import { createContext, useContext, useEffect, useRef, useState, useCallback, type ReactNode } from 'react';
import type { User } from '@tcq/shared';

// Channel name and storage key used to keep the logged-in identity in sync
// across tabs of the same browser. See the BroadcastChannel effect below.
const AUTH_CHANNEL_NAME = 'tcq:auth';
const AUTH_GHID_STORAGE_KEY = 'tcq:auth:ghid';

interface AuthState {
  /** The authenticated user, or null if not logged in. */
  user: User | null;

  /** True while the initial /api/me request is in flight. */
  loading: boolean;

  /** True when the server is using mock auth (no GitHub OAuth configured). */
  mockAuth: boolean;

  /** True when the current user has admin privileges. */
  isAdmin: boolean;

  /** Switch to a different mock user (dev only). Reloads auth state. */
  switchUser: (username: string) => Promise<void>;
}

const AuthContext = createContext<AuthState>({
  user: null,
  loading: true,
  mockAuth: false,
  isAdmin: false,
  switchUser: async () => {},
});

/** Read the current auth state. */
// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthState {
  return useContext(AuthContext);
}

/** Provider that fetches the current user on mount. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [mockAuth, setMockAuth] = useState(false);
  const [adminFlag, setAdminFlag] = useState(false);

  // BroadcastChannel for cross-tab auth sync. Held in a ref because both the
  // listener effect and fetchMe need to access the same instance, and we want
  // to construct it exactly once per provider lifetime.
  const channelRef = useRef<BroadcastChannel | null>(null);

  // Fetch the current user from the server
  const fetchMe = useCallback(async () => {
    let nextGhid = '';
    try {
      const res = await fetch('/api/me');
      if (!res.ok) {
        setUser(null);
        return;
      }
      const data = await res.json();
      setMockAuth(!!data.mockAuth);
      setAdminFlag(!!data.isAdmin);
      // Remove the extra flags before storing as User
      delete data.mockAuth;
      delete data.isAdmin;
      const fetched = data as User;
      nextGhid = String(fetched.ghid);
      setUser(fetched);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
      // Compare the freshly observed identity against the marker persisted
      // by whichever tab last saw an auth change. If the marker is missing,
      // this is the first read in this browser — seed it without broadcasting,
      // since either no peer tabs exist or they're about to write the same
      // value themselves on their own initial fetchMe.
      try {
        const marker = localStorage.getItem(AUTH_GHID_STORAGE_KEY);
        if (marker === null) {
          localStorage.setItem(AUTH_GHID_STORAGE_KEY, nextGhid);
        } else if (marker !== nextGhid) {
          localStorage.setItem(AUTH_GHID_STORAGE_KEY, nextGhid);
          channelRef.current?.postMessage({ type: 'auth-changed' });
        }
      } catch {
        // localStorage may be unavailable (e.g. strict privacy modes); the
        // app still works, just without cross-tab sync.
      }
    }
  }, []);

  useEffect(() => {
    // Intentional initial fetch; the eventual setState updates are async,
    // not synchronous within the effect body.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchMe();
  }, [fetchMe]);

  // Subscribe to the auth-sync BroadcastChannel so login/logout/dev-switch
  // performed in any tab is reflected here. The receiver re-fetches /api/me
  // rather than reloading so ephemeral state (form drafts, scroll position,
  // open meeting context) is preserved. Identity changes propagate from
  // AuthContext through MeetingContext (see MeetingPage's setUser effect)
  // and force a WebSocket re-handshake via useSocketConnection's user.ghid
  // dependency.
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel(AUTH_CHANNEL_NAME);
    channelRef.current = channel;
    channel.onmessage = (event) => {
      if (event.data?.type === 'auth-changed') {
        fetchMe();
      }
    };
    return () => {
      channel.close();
      channelRef.current = null;
    };
  }, [fetchMe]);

  // Switch to a different mock user — calls the dev endpoint,
  // then refreshes auth state so the whole app updates.
  const switchUser = useCallback(
    async (username: string) => {
      const res = await fetch('/api/dev/switch-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username }),
      });
      if (res.ok) {
        // Re-fetch /api/me to update the whole auth state
        await fetchMe();
      }
    },
    [fetchMe],
  );

  return <AuthContext value={{ user, loading, mockAuth, isAdmin: adminFlag, switchUser }}>{children}</AuthContext>;
}
