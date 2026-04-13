/**
 * Login page — shown when the user is not authenticated.
 *
 * Displays the TCQ branding and a "Log in with GitHub" button that
 * redirects to /auth/github to start the OAuth flow.
 */

import { Logo } from '../components/Logo.js';

export function LoginPage() {
  return (
    <div className="min-h-screen bg-stone-50 dark:bg-stone-900 text-stone-900 dark:text-stone-100 flex flex-col">
      <header className="border-b border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 px-6 py-3">
        <Logo className="text-2xl" />
      </header>

      <main className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-semibold text-stone-800 dark:text-stone-200 mb-2">
            Welcome to TCQ
          </h1>
          <p className="text-stone-500 dark:text-stone-400 mb-6">
            A structured meeting discussion queue.
          </p>
          <a
            href="/auth/github"
            className="inline-block bg-stone-800 dark:bg-stone-200 text-white dark:text-stone-900 px-6 py-2.5 rounded-lg
                       font-medium hover:bg-stone-900 dark:hover:bg-stone-300 transition-colors
                       focus:outline-none focus:ring-2 focus:ring-stone-800 dark:focus:ring-stone-200 focus:ring-offset-2 dark:focus:ring-offset-stone-900"
          >
            Log in with GitHub
          </a>
        </div>
      </main>
    </div>
  );
}
