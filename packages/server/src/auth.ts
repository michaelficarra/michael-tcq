/**
 * Generic OAuth authentication routes, provider-agnostic.
 *
 * Mounted at `/auth`. Each enabled `AuthenticationProvider` (see
 * `./auth/registry.ts`) is reachable as:
 *
 * 1. GET /auth/:providerId          — redirect to the provider's auth page.
 * 2. GET /auth/:providerId/callback — exchange the code, store the user.
 * 3. GET /auth/logout               — clear the session and redirect home.
 *
 * When no provider is configured the server is in mock-auth mode: any
 * `/auth/:providerId` hit simply clears the logged-out flag so the mock
 * middleware repopulates a fake user on the next request.
 *
 * The resolved (provider-neutral) user is stored in the session and used to
 * identify the account throughout the app.
 */

import { Router } from 'express';
import type { RequestHandler } from 'express';
import { toSessionUser } from './session.js';
import { warning, error as logError, serialiseError } from './logger.js';
import { enabledProviders, getProvider } from './auth/registry.js';
import { isMockAuthEnabled } from './mockAuth.js';

/**
 * Build the OAuth callback URL for a provider: `${base}/${providerId}/callback`,
 * where `base` is `OAUTH_CALLBACK_BASE_URL` (default `http://localhost:3000/auth`).
 * Provider-agnostic — set the base per deployment so each provider's derived
 * callback matches what its OAuth app is registered with.
 */
function callbackUrl(providerId: string): string {
  const base = process.env.OAUTH_CALLBACK_BASE_URL ?? 'http://localhost:3000/auth';
  return `${base}/${providerId}/callback`;
}

/**
 * Validate a candidate post-login redirect URL. Only same-origin paths are
 * allowed: must start with "/" but not "//" or "/\" (which browsers may
 * interpret as protocol-relative cross-origin URLs). Anything else returns
 * null so the caller falls back to "/" — this is the open-redirect guard
 * on the `returnTo` query parameter accepted by GET /auth/:providerId.
 */
function sanitiseReturnTo(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  if (raw[0] !== '/') return null;
  if (raw[1] === '/' || raw[1] === '\\') return null;
  return raw;
}

/**
 * Public handler (no auth) for `GET /api/auth/providers`. Lists the login
 * options for the login page. In mock-auth mode it returns a single
 * pseudo-provider so the login page still offers a way back in after an
 * explicit logout.
 */
export const authProvidersHandler: RequestHandler = (_req, res) => {
  if (isMockAuthEnabled()) {
    // Mock-auth (dev) mode: a single pseudo-provider whose id routes to the
    // mock branch of GET /auth/:providerId. The client renders the `mock` id
    // as a distinct teal "Enter dev mode" button so it's never mistaken for a
    // real OAuth login; the label is only a fallback.
    res.json({ providers: [{ id: 'mock', label: 'Dev Mode' }], mockAuth: true });
    return;
  }
  // Either real providers are configured, or none are and we're in production
  // (mock auth disabled) — in the latter case the list is empty and the login
  // page simply offers no way in, which is the intended fail-closed behaviour.
  res.json({
    providers: enabledProviders().map((p) => ({ id: p.id, label: p.label })),
    mockAuth: false,
  });
};

export function createAuthRoutes(): Router {
  const router = Router();

  // --- GET /auth/:providerId/callback ---
  // The provider redirects back here with an authorisation code. Exchange
  // it for a profile and store the user in the session. Registered before
  // the bare `/:providerId` route so the deeper path matches first.
  router.get('/:providerId/callback', async (req, res) => {
    const provider = getProvider(req.params.providerId);
    if (!provider) {
      res.status(404).send('Unknown authentication provider');
      return;
    }
    const code = req.query.code as string | undefined;
    if (!code) {
      res.status(400).send('Missing authorisation code');
      return;
    }
    try {
      const profile = await provider.exchangeCode(code, callbackUrl(provider.id));
      if (!profile) {
        res.status(401).send('Authentication failed');
        return;
      }
      const sessionUser = toSessionUser(profile.user);
      // Persist any server-side access token alongside the user (e.g. for
      // GitHub directory refreshes). `toClientUser` strips it before any
      // response is shaped.
      if (profile.accessToken) sessionUser.accessToken = profile.accessToken;
      req.session.user = sessionUser;

      // Fire-and-forget directory warm (no-op for providers without one).
      provider.directory?.warmDirectory(sessionUser).catch((err) => {
        warning('directory_warm_failed', { error: serialiseError(err), provider: provider.id });
      });

      const redirectTo = req.session.returnTo ?? '/';
      delete req.session.returnTo;
      res.redirect(redirectTo);
    } catch (err) {
      logError('oauth_error', { error: serialiseError(err), provider: provider.id });
      res.status(500).send('Authentication failed');
    }
  });

  // --- GET /auth/logout ---
  // Clear the user and redirect home. In mock-auth mode, set a flag so the
  // middleware doesn't auto-repopulate. Registered before `/:providerId` so
  // "logout" isn't captured as a provider id.
  router.get('/logout', (req, res) => {
    delete req.session.user;
    req.session.mockLoggedOut = true;
    req.session.save(() => {
      res.redirect('/');
    });
  });

  // --- GET /auth/:providerId ---
  // Redirect to the provider's authorisation page.
  router.get('/:providerId', (req, res) => {
    // Allow callers (e.g. LoginPage) to specify where to land after login.
    // Validated to reject open-redirect attempts.
    const returnTo = sanitiseReturnTo(req.query.returnTo);

    if (isMockAuthEnabled()) {
      // Mock-auth mode: any provider id just clears the logged-out flag.
      // The mock middleware repopulates the user on the next request, so we
      // can land directly on the requested URL.
      delete req.session.mockLoggedOut;
      res.redirect(returnTo ?? '/');
      return;
    }

    const provider = getProvider(req.params.providerId);
    if (!provider) {
      res.status(404).send('Unknown authentication provider');
      return;
    }

    // Stash the requested URL so the callback can redirect back to it.
    if (returnTo) req.session.returnTo = returnTo;
    res.redirect(provider.authorizationUrl({ redirectUri: callbackUrl(provider.id) }));
  });

  return router;
}
