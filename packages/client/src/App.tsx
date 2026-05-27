import { Suspense, lazy } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext.js';
import { PreferencesProvider } from './contexts/PreferencesContext.js';
import { ToastProvider } from './contexts/ToastContext.js';
import { PreferencesModal } from './components/PreferencesModal.js';
import { LoginPage } from './pages/LoginPage.js';
import { useAriaInvalidSync } from './hooks/useAriaInvalidSync.js';

// Route-level code splitting: HomePage and MeetingPage each pull in a
// large slice of the dependency tree (MeetingPage in particular owns the
// markdown stack and @dnd-kit), so loading them lazily keeps the initial
// chunk well below Vite's 600 kB warning threshold and means home-page
// visitors don't pay for meeting-page code.
const HomePage = lazy(() => import('./pages/HomePage.js').then((m) => ({ default: m.HomePage })));
const MeetingPage = lazy(() => import('./pages/MeetingPage.js').then((m) => ({ default: m.MeetingPage })));

function LoadingScreen() {
  return (
    <div className="min-h-screen bg-stone-50 flex items-center justify-center">
      <p className="text-stone-400">Loading&hellip;</p>
    </div>
  );
}

/**
 * Root component. Wraps the app in AuthProvider so all routes can
 * check whether the user is authenticated.
 */
function App() {
  // Keep aria-invalid mirrored to the visual :user-invalid state app-wide.
  useAriaInvalidSync();

  return (
    <PreferencesProvider>
      <AuthProvider>
        {/* ToastProvider wraps the router so any surface — home page, meeting
            page, and the socket layer inside MeetingProvider — can raise
            toasts. Toasts render in the top layer, so its position in the tree
            doesn't affect where they appear. */}
        <ToastProvider>
          <BrowserRouter>
            <AppRoutes />
          </BrowserRouter>
          {/* PreferencesModal sits inside AuthProvider because the Saved
              Topics section reads/writes per-user (keyed by user.ghid). */}
          <PreferencesModal />
        </ToastProvider>
      </AuthProvider>
    </PreferencesProvider>
  );
}

/**
 * Route definitions. Shows the login page if the user is not
 * authenticated, or the normal app routes if they are.
 */
function AppRoutes() {
  const { user, loading } = useAuth();

  // Show nothing while checking auth status to avoid a flash of login page
  if (loading) {
    return <LoadingScreen />;
  }

  // Not authenticated — show login page regardless of URL
  if (!user) {
    return <LoginPage />;
  }

  // Authenticated — render normal app routes. Suspense covers the lazy-
  // loaded route components above; LoadingScreen mirrors the auth-loading
  // state so transitions look consistent.
  return (
    <Suspense fallback={<LoadingScreen />}>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/meeting/:id" element={<MeetingPage />} />
      </Routes>
    </Suspense>
  );
}

export default App;
