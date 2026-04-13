/**
 * Login page — shown when the user is not authenticated.
 *
 * Displays the TCQ branding and a "Log in with GitHub" button that
 * redirects to /auth/github to start the OAuth flow.
 */

export function LoginPage() {
  return (
    <div className="min-h-screen bg-stone-50 text-stone-900 flex flex-col">
      <header className="border-b border-stone-200 bg-white px-6 py-3">
        <span className="text-2xl font-semibold text-stone-800">TCQ</span>
      </header>

      <main className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-semibold text-stone-800 mb-2">
            Welcome to TCQ
          </h1>
          <p className="text-stone-500 mb-6">
            A structured meeting discussion queue.
          </p>
          <a
            href="/auth/github"
            className="inline-block bg-stone-800 text-white px-6 py-2.5 rounded-lg
                       font-medium hover:bg-stone-900 transition-colors
                       focus:outline-none focus:ring-2 focus:ring-stone-800 focus:ring-offset-2"
          >
            Log in with GitHub
          </a>
        </div>
      </main>
    </div>
  );
}
