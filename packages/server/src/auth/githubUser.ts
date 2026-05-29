/**
 * GitHub-specific `User` helpers, kept in a dependency-free leaf module so
 * the GitHub provider (`./github.ts`), the mock-user resolver
 * (`../mockUser.ts`), the directory (`../githubDirectory.ts`), and the
 * socket/route handlers can share them without import cycles.
 *
 * GitHub's `accountId` is the **numeric GitHub user id** (as a string). The
 * `handle` preserves the login's casing for display. Because the key isn't
 * derivable from a handle alone, code that has only a typed-in handle
 * resolves it via `findGitHubUserByHandle` (meeting lookup) or the
 * provider's `resolveByHandle` (API / mock), both of which yield the id.
 */

import type { MeetingState, User } from '@tcq/shared';

/** The provider id GitHub-sourced users carry in `User.provider`. */
export const GITHUB_PROVIDER_ID = 'github';

/** Whether GitHub OAuth credentials are configured. When false, the GitHub
 *  provider is disabled and GitHub-backed resolution falls back to mock data. */
export function isGitHubConfigured(): boolean {
  return !!process.env.GITHUB_CLIENT_ID;
}

/**
 * Synthesise the public avatar URL for a GitHub login. `github.com/{login}.png`
 * is a redirect to the user's canonical avatar that works for any valid login
 * (including mock-auth users), so we key it on the login rather than the
 * numeric id.
 */
export function githubAvatarUrl(login: string): string {
  return `https://github.com/${encodeURIComponent(login)}.png?size=80`;
}

/** Build a resolved GitHub `User` from profile fields. The numeric `id` is
 *  required — it becomes the canonical `accountId` (and thus the key). */
export function githubUser(fields: {
  id: number;
  login: string;
  name?: string | null;
  organisation?: string | null;
}): User {
  return {
    provider: GITHUB_PROVIDER_ID,
    accountId: String(fields.id),
    handle: fields.login,
    // `||` (not `??`) so an empty/whitespace name falls through to the login.
    name: fields.name?.trim() || fields.login,
    organisation: fields.organisation?.trim() ?? '',
    avatarUrl: githubAvatarUrl(fields.login),
  };
}

/**
 * Find a user already present in a meeting by their handle, case-insensitively.
 * This is how a typed-in handle is resolved to its full record (and key)
 * without a fresh API call — the key can't be derived from a handle alone.
 * Provider-agnostic: matches any provider's handle (users without a handle,
 * e.g. ORCID, simply never match).
 */
export function findUserByHandle(meeting: MeetingState | undefined, handle: string): User | undefined {
  if (!meeting) return undefined;
  const wanted = handle.toLowerCase();
  for (const u of Object.values(meeting.users)) {
    if (u.handle?.toLowerCase() === wanted) return u;
  }
  return undefined;
}
