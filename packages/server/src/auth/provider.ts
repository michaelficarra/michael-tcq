/**
 * The provider-neutral authentication abstraction.
 *
 * TCQ historically spoke only GitHub OAuth. This interface generalises the
 * pieces an auth provider must supply so other OAuth providers (Google
 * OIDC, ORCID) can be added without the rest of the app knowing which one
 * a given account came from. The single GitHub implementation lives in
 * `./github.ts`; the set of enabled providers is assembled in
 * `./registry.ts`.
 *
 * All three target providers are OAuth 2.0 authorization-code flows, so the
 * interface is shaped around that: a provider hands back an authorization
 * URL, then exchanges the returned code for a profile. Anything that is not
 * universal across providers — most notably a searchable user directory —
 * is an optional capability.
 */

import type { User } from '@tcq/shared';
import type { MeetingState } from '@tcq/shared';
import type { SessionUser } from '../session.js';
import type { DirectoryUser } from '../githubDirectory.js';

/** Result of a successful OAuth callback: the resolved user plus, optionally,
 *  a server-held access token for later calls on the user's behalf. */
export interface OAuthProfile {
  user: User;
  /** Server-only credential (e.g. for directory refreshes). Never sent to clients. */
  accessToken?: string;
}

/**
 * A searchable user directory backing the username-autocomplete dropdown
 * and agenda-import presenter resolution. Optional: only providers with a
 * meaningful directory (GitHub's org public-members) implement it. Mirrors
 * the existing functions exported from `githubDirectory.ts`.
 */
export interface DirectoryCapability {
  searchUsers(
    session: SessionUser,
    query: string,
    meeting: MeetingState | undefined,
    limit: number,
  ): Promise<DirectoryUser[]>;
  searchUsersLocal(
    session: SessionUser,
    query: string,
    meeting: MeetingState | undefined,
    limit: number,
  ): DirectoryUser[];
  resolvePresenterFromDirectory(
    session: SessionUser,
    query: string,
    meeting: MeetingState | undefined,
  ): DirectoryUser | null;
  warmDirectory(session: SessionUser): Promise<void>;
}

export interface AuthenticationProvider {
  /** Stable provider id — equals `User.provider` and the `/auth/:id` route segment. */
  readonly id: string;
  /** Human-readable name shown on the login button (e.g. "GitHub"). */
  readonly label: string;
  /** Whether this provider is configured (credentials present) and therefore usable. */
  readonly enabled: boolean;

  /** Build the provider's OAuth authorization URL to redirect the user to. */
  authorizationUrl(opts: { state?: string; redirectUri: string }): string;
  /** Exchange the authorization code for a user profile (and any access token). Null on failure. */
  exchangeCode(code: string, redirectUri: string): Promise<OAuthProfile | null>;

  /**
   * Resolve a typed-in handle to a full User — used for chair/presenter
   * entry. Returns null when the handle doesn't resolve to a real account.
   * Async; see the provider implementation for any synchronous fast path.
   */
  resolveByHandle(handle: string): Promise<User | null>;

  /** Synthesise an avatar URL for a stored user, where the provider can derive one. */
  avatarUrl(user: Pick<User, 'handle' | 'accountId'>): string;

  /** Optional searchable directory (autocomplete / agenda import). */
  readonly directory?: DirectoryCapability;
}
