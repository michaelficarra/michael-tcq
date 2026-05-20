import { Suspense, lazy } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext.js';
import { PreferencesProvider } from './contexts/PreferencesContext.js';
import { PreferencesModal } from './components/PreferencesModal.js';
import { StaleVersionBanner } from './components/StaleVersionBanner.js';
import { LoginPage } from './pages/LoginPage.js';
import { useStaleVersionCheck } from './hooks/useStaleVersionCheck.js';

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
  // Polls /api/version to detect a redeploy. Mounted at the root so the
  // staleness check survives route changes within the SPA.
  const stale = useStaleVersionCheck();
  return (
    <PreferencesProvider>
      <AuthProvider>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </AuthProvider>
      <PreferencesModal />
      {stale && <StaleVersionBanner />}
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
