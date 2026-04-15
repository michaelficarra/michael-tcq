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

import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import type { User } from '@tcq/shared';

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

  // Fetch the current user from the server
  const fetchMe = useCallback(async () => {
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
      setUser(data as User);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMe();
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
