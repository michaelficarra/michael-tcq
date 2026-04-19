import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';

// Apply the stored theme preference before React renders to avoid a flash of
// light content. The PreferencesProvider owns the canonical logic; this is the
// same computation applied eagerly.
try {
  const stored = localStorage.getItem('tcq-theme-preference');
  const theme = stored === 'light' || stored === 'dark' ? stored : 'system';
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
} catch {
  // localStorage unavailable — fall back to system behaviour on first paint.
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
