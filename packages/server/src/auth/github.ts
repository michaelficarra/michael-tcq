/**
 * The GitHub authentication provider — the single concrete
 * `AuthenticationProvider` today. Wraps GitHub's OAuth 2.0
 * authorization-code flow (token exchange + profile fetch), handle
 * resolution against the GitHub REST API, avatar synthesis, and the
 * org-public-members directory (`../githubDirectory.ts`) as its optional
 * directory capability.
 */

import type { User } from '@tcq/shared';
import type { AuthenticationProvider, OAuthProfile } from './provider.js';
import { GITHUB_PROVIDER_ID, isGitHubConfigured, githubAvatarUrl, githubUser } from './githubUser.js';
import { mockUserFromLogin, mockUserFromId } from '../mockUser.js';
import { warning } from '../logger.js';
import {
  searchUsers,
  searchUsersLocal,
  resolvePresenterFromDirectory,
  warmDirectoryForUser,
} from '../githubDirectory.js';

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID ?? '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET ?? '';

/**
 * Fetch a GitHub user's profile by login using the OAuth app's client
 * credentials (for higher rate limits) or unauthenticated. Used to resolve
 * chair/presenter handles to full User objects. Returns null if the login
 * doesn't exist.
 */
export async function fetchGitHubUser(login: string): Promise<User | null> {
  return fetchGitHubUserFrom(`https://api.github.com/users/${encodeURIComponent(login)}`);
}

/** Fetch a GitHub user's profile by numeric id (`GET /user/{id}`). */
async function fetchGitHubUserById(id: string): Promise<User | null> {
  return fetchGitHubUserFrom(`https://api.github.com/user/${encodeURIComponent(id)}`);
}

async function fetchGitHubUserFrom(url: string): Promise<User | null> {
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      // Client credentials raise the rate limit from 60/hr to 5000/hr.
      ...(GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET
        ? { Authorization: `Basic ${btoa(`${GITHUB_CLIENT_ID}:${GITHUB_CLIENT_SECRET}`)}` }
        : {}),
    },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return githubUser({ id: data.id, login: data.login, name: data.name, organisation: data.company });
}

export const githubProvider: AuthenticationProvider = {
  id: GITHUB_PROVIDER_ID,
  label: 'GitHub',
  get enabled() {
    return isGitHubConfigured();
  },

  authorizationUrl({ state, redirectUri }) {
    const params = new URLSearchParams({
      client_id: GITHUB_CLIENT_ID,
      redirect_uri: redirectUri,
      // Only profile data is needed. The directory uses public-membership
      // endpoints (no `read:user`-beyond-identity grant required), so we
      // deliberately don't request `read:org` — it surfaced on the consent
      // screen as access to all of the user's org memberships.
      scope: 'read:user',
      ...(state ? { state } : {}),
    });
    return `https://github.com/login/oauth/authorize?${params}`;
  },

  async exchangeCode(code, redirectUri): Promise<OAuthProfile | null> {
    // Step 1: exchange the authorisation code for an access token.
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: redirectUri,
      }),
    });
    const tokenData = await tokenRes.json();
    if (tokenData.error) {
      warning('github_oauth_token_error', { description: tokenData.error_description });
      return null;
    }
    const accessToken = tokenData.access_token as string;

    // Step 2: fetch the user's profile.
    const userRes = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json' },
    });
    if (!userRes.ok) {
      warning('github_user_api_error', { status: userRes.status });
      return null;
    }
    const userData = await userRes.json();
    const user = githubUser({
      id: userData.id,
      login: userData.login,
      name: userData.name,
      organisation: userData.company,
    });
    return { user, accessToken };
  },

  async resolveByHandle(handle): Promise<User | null> {
    // When GitHub OAuth is configured, validate against the live API
    // (null ⇒ "not found", surfaced as an error to the chair). In mock
    // mode, resolve via the seed-aware helper, which always succeeds.
    return isGitHubConfigured() ? fetchGitHubUser(handle) : mockUserFromLogin(handle);
  },

  async resolveByAccountId(accountId): Promise<User | null> {
    // Re-resolve a directory-picked account by its numeric id. In mock mode
    // there's no API, so map the id back to a seed member (null if unknown).
    return isGitHubConfigured() ? fetchGitHubUserById(accountId) : mockUserFromId(accountId);
  },

  avatarUrl(user) {
    return githubAvatarUrl(user.handle ?? user.accountId);
  },

  directory: {
    searchUsers,
    searchUsersLocal,
    resolvePresenterFromDirectory,
    warmDirectory: warmDirectoryForUser,
  },
};
