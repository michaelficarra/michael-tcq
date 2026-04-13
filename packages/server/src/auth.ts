/**
 * GitHub OAuth authentication routes.
 *
 * Implements the three-step OAuth flow directly (no Passport.js) since
 * we only support a single OAuth provider:
 *
 * 1. GET /auth/github — Redirect the user to GitHub's authorisation page.
 * 2. GET /auth/github/callback — Exchange the authorisation code for an
 *    access token, fetch the user's profile, and store it in the session.
 * 3. GET /auth/logout — Destroy the session and redirect home.
 *
 * The user's GitHub profile (ghid, ghUsername, name, organisation) is
 * stored in the session and used to identify them throughout the app.
 */

import { Router } from 'express';
import type { User } from '@tcq/shared';

// OAuth configuration from environment variables
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID ?? '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET ?? '';
const GITHUB_CALLBACK_URL = process.env.GITHUB_CALLBACK_URL ?? 'http://localhost:3000/auth/github/callback';

/**
 * Fetch a GitHub user's profile by username using a personal access token
 * or the OAuth app's client credentials. Used to resolve chair usernames
 * to full User objects when creating meetings.
 *
 * Returns null if the username doesn't exist.
 */
export async function fetchGitHubUser(username: string): Promise<User | null> {
  const res = await fetch(`https://api.github.com/users/${encodeURIComponent(username)}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      // Use client credentials for higher rate limits (5000/hr vs 60/hr)
      ...(GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET
        ? { Authorization: `Basic ${btoa(`${GITHUB_CLIENT_ID}:${GITHUB_CLIENT_SECRET}`)}` }
        : {}),
    },
  });

  if (!res.ok) return null;

  const data = await res.json();
  return {
    ghid: data.id,
    ghUsername: data.login,
    name: data.name ?? data.login,
    organisation: data.company ?? '',
  };
}

export function createAuthRoutes(): Router {
  const router = Router();

  // --- GET /auth/github ---
  // Redirect to GitHub's OAuth authorisation page. The user will be
  // asked to grant our app access to their profile information.
  router.get('/github', (_req, res) => {
    if (!GITHUB_CLIENT_ID) {
      res.status(500).send('GitHub OAuth is not configured. Set GITHUB_CLIENT_ID in your .env file.');
      return;
    }

    const params = new URLSearchParams({
      client_id: GITHUB_CLIENT_ID,
      redirect_uri: GITHUB_CALLBACK_URL,
      scope: 'read:user',
    });

    res.redirect(`https://github.com/login/oauth/authorize?${params}`);
  });

  // --- GET /auth/github/callback ---
  // GitHub redirects back here with an authorisation code. We exchange
  // it for an access token, fetch the user's profile, and store it in
  // the session.
  router.get('/github/callback', async (req, res) => {
    const code = req.query.code as string | undefined;
    if (!code) {
      res.status(400).send('Missing authorisation code');
      return;
    }

    try {
      // Step 1: Exchange the authorisation code for an access token
      const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_id: GITHUB_CLIENT_ID,
          client_secret: GITHUB_CLIENT_SECRET,
          code,
          redirect_uri: GITHUB_CALLBACK_URL,
        }),
      });

      const tokenData = await tokenRes.json();
      if (tokenData.error) {
        console.error('GitHub OAuth token error:', tokenData.error_description);
        res.status(401).send('Authentication failed');
        return;
      }

      const accessToken = tokenData.access_token as string;

      // Step 2: Fetch the user's profile from the GitHub API
      const userRes = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
        },
      });

      if (!userRes.ok) {
        console.error('GitHub user API error:', userRes.status);
        res.status(401).send('Failed to fetch user profile');
        return;
      }

      const userData = await userRes.json();

      // Step 3: Store the user in the session
      const user: User = {
        ghid: userData.id,
        ghUsername: userData.login,
        name: userData.name ?? userData.login,
        organisation: userData.company ?? '',
      };

      req.session.user = user;

      // Redirect to the app's home page (the Vite dev server in development)
      const redirectTo = req.session.returnTo ?? '/';
      delete req.session.returnTo;
      res.redirect(redirectTo);
    } catch (err) {
      console.error('GitHub OAuth error:', err);
      res.status(500).send('Authentication failed');
    }
  });

  // --- GET /auth/logout ---
  // Destroy the session and redirect to the home page.
  router.get('/logout', (req, res) => {
    req.session.destroy(() => {
      res.redirect('/');
    });
  });

  return router;
}
