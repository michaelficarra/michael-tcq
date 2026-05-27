/**
 * GitHub-specific `User` construction helpers, kept in a dependency-free
 * leaf module so both the GitHub provider (`./github.ts`), the mock-user
 * resolver (`../mockUser.ts`), and the directory (`../githubDirectory.ts`)
 * can share them without import cycles.
 *
 * GitHub's `accountId` is the lowercased login (so it round-trips with the
 * pre-multi-provider key, which was the lowercased login). The `handle`
 * preserves the login's original casing for display. The numeric GitHub id
 * is intentionally dropped from `User`.
 */

import type { User, UserKey } from '@tcq/shared';
import { userKey } from '@tcq/shared';

/** The provider id GitHub-sourced users carry in `User.provider`. */
export const GITHUB_PROVIDER_ID = 'github';

/** Whether GitHub OAuth credentials are configured. When false, the GitHub
 *  provider is disabled and GitHub-backed resolution falls back to mock data. */
export function isGitHubConfigured(): boolean {
  return !!process.env.GITHUB_CLIENT_ID;
}

/**
 * Synthesise the public avatar URL for a GitHub login. `github.com/{login}.png`
 * is a redirect to the user's canonical avatar that works for any valid login,
 * including mock-auth users whose meeting-state record has no real numeric id
 * (a `avatars.githubusercontent.com/u/{id}` URL would 404 for them).
 */
export function githubAvatarUrl(login: string): string {
  return `https://github.com/${encodeURIComponent(login)}.png?size=80`;
}

/** The canonical UserKey for a GitHub login (`github:<lowercased-login>`). */
export function githubUserKey(login: string): UserKey {
  return userKey({ provider: GITHUB_PROVIDER_ID, accountId: login.toLowerCase() });
}

/** Build a resolved GitHub `User` from profile fields. */
export function githubUser(fields: { login: string; name?: string | null; organisation?: string | null }): User {
  return {
    provider: GITHUB_PROVIDER_ID,
    accountId: fields.login.toLowerCase(),
    handle: fields.login,
    // `||` (not `??`) so an empty/whitespace name falls through to the login.
    name: fields.name?.trim() || fields.login,
    organisation: fields.organisation?.trim() ?? '',
    avatarUrl: githubAvatarUrl(fields.login),
  };
}

/**
 * Build a placeholder GitHub `User` for a free-text presenter name that
 * didn't resolve to a real account (e.g. a typo, or a name with no GitHub
 * account). Keyed distinctly per name (so multiple placeholders coexist),
 * but marked by an empty `avatarUrl` — the sole signal the directory uses
 * to skip these so they don't shadow real autocomplete matches. A resolved
 * GitHub user always has a non-empty synthesised `avatarUrl`.
 */
export function githubPlaceholderUser(name: string): User {
  return {
    provider: GITHUB_PROVIDER_ID,
    accountId: name.toLowerCase(),
    handle: name,
    name,
    organisation: '',
    avatarUrl: '',
  };
}
