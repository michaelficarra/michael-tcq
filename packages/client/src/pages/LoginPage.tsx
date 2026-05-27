/**
 * Login page — shown when the user is not authenticated.
 *
 * Displays the TCQ branding and a "Log in with …" button per configured
 * authentication provider (fetched from `/api/auth/providers`), each
 * redirecting to `/auth/:id` to start that provider's OAuth flow. In
 * mock-auth (dev) mode the endpoint returns a single pseudo-provider so the
 * page still offers a way back in after an explicit logout.
 */

import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Logo } from '../components/Logo.js';

interface AuthProvider {
  id: string;
  label: string;
}

export function LoginPage() {
  // Preserve whatever deep-link the user landed on so the server's auth
  // handler can redirect back here after OAuth completes. For "/" we skip
  // the query param — it's the default redirect target.
  const { pathname, search, hash } = useLocation();
  const current = `${pathname}${search}${hash}`;
  const returnToQuery = current === '/' ? '' : `?returnTo=${encodeURIComponent(current)}`;

  const [providers, setProviders] = useState<AuthProvider[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/providers')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error('failed'))))
      .then((data: { providers?: AuthProvider[] }) => {
        if (!cancelled) setProviders(data.providers ?? []);
      })
      .catch(() => {
        if (!cancelled) setProviders([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="min-h-screen bg-stone-50 dark:bg-stone-900 text-stone-900 dark:text-stone-100 flex flex-col">
      <header className="border-b border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 px-6 py-3">
        <Logo className="text-2xl" />
      </header>

      <main className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-semibold text-stone-800 dark:text-stone-200 mb-2">Welcome to TCQ</h1>
          <p className="text-stone-500 dark:text-stone-400 mb-6">A structured meeting discussion queue.</p>
          <div className="flex flex-col items-center gap-3">
            {(providers ?? []).map((provider) => (
              <a
                key={provider.id}
                href={`/auth/${provider.id}${returnToQuery}`}
                className="inline-block bg-stone-800 dark:bg-stone-200 text-white dark:text-stone-900 px-6 py-2.5 rounded-lg
                           font-medium hover:bg-stone-900 dark:hover:bg-stone-300 transition-colors
                           focus:outline-none focus:ring-2 focus:ring-stone-800 dark:focus:ring-stone-200 focus:ring-offset-2 dark:focus:ring-offset-stone-900"
              >
                Log in with {provider.label}
              </a>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
