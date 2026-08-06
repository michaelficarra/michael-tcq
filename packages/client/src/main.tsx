import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import { applyTheme, getTheme } from './lib/theme.js';

// Apply the stored theme preference before React renders, to avoid a flash of
// light content. The PreferencesProvider applies the very same functions once
// it mounts.
applyTheme(getTheme());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
