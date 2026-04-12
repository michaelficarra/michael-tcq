/**
 * Home page — landing page shown at /.
 *
 * For now this is a minimal placeholder. The full create/join meeting UI
 * will be built in Step 10.
 */

export function HomePage() {
  return (
    <div className="min-h-screen bg-stone-50 text-stone-900">
      <header className="border-b border-stone-200 bg-white px-6 py-3">
        <span className="text-2xl font-semibold text-stone-800">TCQ</span>
      </header>
      <main className="p-6 max-w-xl mx-auto">
        <h1 className="text-xl font-semibold mb-4">Welcome to TCQ</h1>
        <p className="text-stone-600">
          TCQ is a meeting discussion queue. To join a meeting, navigate to{' '}
          <code className="bg-stone-100 px-1.5 py-0.5 rounded text-sm">
            /meeting/&lt;meeting-id&gt;
          </code>
          .
        </p>
      </main>
    </div>
  );
}
