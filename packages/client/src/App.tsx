import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext.js';
import { LoginPage } from './pages/LoginPage.js';
import { HomePage } from './pages/HomePage.js';
import { MeetingPage } from './pages/MeetingPage.js';

/**
 * Root component. Wraps the app in AuthProvider so all routes can
 * check whether the user is authenticated.
 */
function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </AuthProvider>
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
    return (
      <div className="min-h-screen bg-stone-50 flex items-center justify-center">
        <p className="text-stone-400">Loading&hellip;</p>
      </div>
    );
  }

  // Not authenticated — show login page regardless of URL
  if (!user) {
    return <LoginPage />;
  }

  // Authenticated — render normal app routes
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/meeting/:id" element={<MeetingPage />} />
    </Routes>
  );
}

export default App;
