/**
 * Login page — shown when the user is not authenticated.
 *
 * Displays the TCQ branding and a "Log in with …" button per configured
 * authentication provider (fetched from `/api/auth/providers`), each
 * redirecting to `/auth/:id` to start that provider's OAuth flow. In
 * mock-auth (dev) mode the endpoint returns a single `mock` pseudo-provider,
 * which renders as a distinct teal "Enter dev mode" button (with a caption
 * flagging it as mock auth) so it's never mistaken for a real provider — and
 * still offers a way back in after an explicit logout.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { Logo } from '../components/Logo.js';
import { GitHubMark, OrcidMark, GoogleMark, DevMark } from '../components/BrandLogos.js';

interface AuthProvider {
  id: string;
  label: string;
}

interface Brand {
  className: string;
  logo: ReactNode;
  /** Full button text. When omitted the button reads "Log in with {label}". */
  text?: string;
  /** Small caption rendered beneath the button (e.g. the dev-mode warning). */
  caption?: string;
}

/**
 * Per-provider button styling. Real providers use their official brand colour
 * with a contrasting mark (white on GitHub's charcoal; dark on ORCID's green,
 * since white on `#a6ce39` fails contrast; dark text on Google's mandated white
 * variant). The dev `mock` pseudo-provider deliberately looks *unlike* a real
 * provider: TCQ teal, a code-bracket glyph, and explicit "dev mode" wording so
 * nobody mistakes it for a production login.
 */
const PROVIDER_BRAND: Record<string, Brand> = {
  github: {
    className:
      'bg-[#24292f] text-white hover:bg-[#2b3137] focus-visible:ring-[#24292f] focus-visible:ring-offset-stone-50 dark:focus-visible:ring-offset-stone-900',
    logo: <GitHubMark />,
  },
  orcid: {
    className:
      'bg-[#a6ce39] text-[#1f2328] hover:bg-[#99be33] focus-visible:ring-[#a6ce39] focus-visible:ring-offset-stone-50 dark:focus-visible:ring-offset-stone-900',
    logo: <OrcidMark />,
  },
  google: {
    // Google's "Sign in with Google" white variant: white background, dark
    // text, thin grey border (#747775). Permitted in both light and dark mode;
    // the text and the multi-colour "G" mark are mandated by the branding
    // guidelines, so the text is set here and the mark is never recoloured.
    className:
      'bg-white text-[#1f1f1f] border border-[#747775] hover:bg-[#f8f9fa] focus-visible:ring-[#dadce0] focus-visible:ring-offset-stone-50 dark:focus-visible:ring-offset-stone-900',
    logo: <GoogleMark />,
    text: 'Sign in with Google',
  },
  mock: {
    className:
      'bg-teal-700 text-white hover:bg-teal-800 focus-visible:ring-teal-500 focus-visible:ring-offset-stone-50 dark:focus-visible:ring-offset-stone-900',
    logo: <DevMark />,
    text: 'Enter dev mode',
    caption: 'Mock authentication — no OAuth provider is configured.',
  },
};

const NEUTRAL_BRAND: Brand = {
  className:
    'bg-stone-800 text-white hover:bg-stone-900 focus-visible:ring-stone-800 focus-visible:ring-offset-2 dark:bg-stone-200 dark:text-stone-900 dark:hover:bg-stone-300 dark:focus-visible:ring-stone-200 dark:focus-visible:ring-offset-stone-900',
  logo: null,
};

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
          <div className="flex flex-col items-stretch gap-3">
            {(providers ?? []).map((provider) => {
              const brand = PROVIDER_BRAND[provider.id] ?? NEUTRAL_BRAND;
              return (
                <div key={provider.id} className="flex flex-col items-stretch gap-1.5">
                  <a
                    href={`/auth/${provider.id}${returnToQuery}`}
                    className={`inline-flex items-center justify-center gap-2 px-6 py-2.5 rounded-lg font-medium
                               transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ${brand.className}`}
                  >
                    {brand.logo}
                    {brand.text ?? `Log in with ${provider.label}`}
                  </a>
                  {brand.caption ? <p className="text-xs text-stone-500 dark:text-stone-400">{brand.caption}</p> : null}
                </div>
              );
            })}
          </div>
        </div>
      </main>
    </div>
  );
}
