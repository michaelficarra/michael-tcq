/**
 * The Microsoft authentication provider — an OpenID Connect (OIDC) login on the
 * Microsoft identity platform (Entra ID, formerly Azure AD), v2.0 endpoints.
 *
 * Like Google, Microsoft's authorization-code flow returns an `id_token` (a
 * JWT) directly from the token endpoint, carrying the basic profile (`sub`,
 * `name`, `preferred_username`, `email`). We decode the payload but do **not**
 * verify its signature — the id_token is received directly from the token
 * endpoint over TLS, which authenticates Microsoft (the same justification the
 * Google provider documents). See `./idToken.ts`.
 *
 * Microsoft's id_token has no `picture` claim, so — like ORCID — the avatar is
 * synthesised via Gravatar (real photo if registered, else an identicon); see
 * `./microsoftUser.ts`. And like Google, Microsoft has no public lookup-by-id,
 * so there is no `resolveByAccountId`: a Microsoft user referenced before they
 * sign in is re-resolved from the server-wide known-users cache
 * (`../knownUsers.ts`), and otherwise falls back to a `sub`-seeded identicon.
 *
 * The tenant defaults to `common` (work/school *and* personal Microsoft
 * accounts); set `MICROSOFT_TENANT` to a specific tenant id, `organizations`,
 * or `consumers` to restrict it.
 */

import type { MeetingState, User, DirectorySuggestion } from '@tcq/shared';
import type { AuthenticationProvider, OAuthProfile } from './provider.js';
import { MICROSOFT_PROVIDER_ID, isMicrosoftConfigured, microsoftUser } from './microsoftUser.js';
import { decodeIdTokenPayload } from './idToken.js';
import { gravatarUrl } from './gravatar.js';
import { warning, serialiseError } from '../logger.js';

const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID ?? '';
const MICROSOFT_CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET ?? '';

/** The v2.0 endpoint base for the configured tenant (default `common`). */
function endpointBase(): string {
  const tenant = process.env.MICROSOFT_TENANT || 'common';
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0`;
}

/** The id_token claims we read. All optional except `sub` (the stable id). */
interface MicrosoftIdTokenClaims {
  sub: string;
  name?: string;
  email?: string;
  preferred_username?: string;
}

/** Read a string claim, ignoring any non-string (or absent) value. */
function strClaim(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Decode a Microsoft id_token's payload (shared decoder, signature not
 *  verified) and return it as Microsoft claims, or null when `sub` is
 *  missing/empty. */
function microsoftClaims(jwt: string): MicrosoftIdTokenClaims | null {
  const claims = decodeIdTokenPayload(jwt);
  if (!claims) return null;
  const sub = claims.sub;
  if (typeof sub !== 'string' || sub === '') return null;
  return {
    sub,
    name: strClaim(claims.name),
    email: strClaim(claims.email),
    preferred_username: strClaim(claims.preferred_username),
  };
}

/** Case-insensitive substring match of a query against a Microsoft meeting
 *  participant's name / organisation / sub. Empty query matches all. */
function meetingMicrosoftMatches(
  meeting: MeetingState | undefined,
  query: string,
  limit: number,
): DirectorySuggestion[] {
  if (!meeting) return [];
  const q = query.trim().toLowerCase();
  const out: DirectorySuggestion[] = [];
  for (const user of Object.values(meeting.users)) {
    if (user.provider !== MICROSOFT_PROVIDER_ID) continue;
    if (
      q.length === 0 ||
      user.name.toLowerCase().includes(q) ||
      user.organisation.toLowerCase().includes(q) ||
      user.accountId.toLowerCase().includes(q)
    ) {
      out.push({ user, badge: 'meeting' });
      if (out.length >= limit) break;
    }
  }
  return out;
}

export const microsoftProvider: AuthenticationProvider = {
  id: MICROSOFT_PROVIDER_ID,
  label: 'Microsoft',
  get enabled() {
    return isMicrosoftConfigured();
  },

  authorizationUrl({ state, redirectUri }) {
    const params = new URLSearchParams({
      client_id: MICROSOFT_CLIENT_ID,
      response_type: 'code',
      // `openid` yields the id_token; `email profile` add the name, email, and
      // preferred_username claims.
      scope: 'openid email profile',
      redirect_uri: redirectUri,
      ...(state ? { state } : {}),
    });
    return `${endpointBase()}/authorize?${params}`;
  },

  async exchangeCode(code, redirectUri): Promise<OAuthProfile | null> {
    const body = new URLSearchParams({
      client_id: MICROSOFT_CLIENT_ID,
      client_secret: MICROSOFT_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    });
    let res: Response;
    try {
      res = await fetch(`${endpointBase()}/token`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
    } catch (err) {
      warning('microsoft_oauth_error', { error: serialiseError(err) });
      return null;
    }
    if (!res.ok) {
      warning('microsoft_oauth_token_error', { status: res.status });
      return null;
    }
    const data = (await res.json()) as { access_token?: string; id_token?: string };
    if (!data.id_token) {
      warning('microsoft_oauth_no_id_token', {});
      return null;
    }
    const claims = microsoftClaims(data.id_token);
    if (!claims) {
      warning('microsoft_oauth_bad_id_token', {});
      return null;
    }
    const user = microsoftUser({
      sub: claims.sub,
      name: claims.name,
      email: claims.email,
      preferredUsername: claims.preferred_username,
    });
    return { user, accessToken: data.access_token };
  },

  async resolveByHandle(): Promise<User | null> {
    // Microsoft has no public lookup by any handle, so free text never resolves.
    return null;
  },

  // resolveByAccountId is intentionally omitted: Microsoft has no public
  // lookup-by-id (a Graph lookup needs admin-consented application permissions).
  // Re-resolving a stored `microsoft:<sub>` reference is handled by the
  // server-wide known-users cache (`../knownUsers.ts`); an account never seen on
  // this server falls back to the `sub`-seeded identicon from `avatarUrl` below.

  avatarUrl(user) {
    // A stable identicon seeded by the `sub`. The real Gravatar (keyed off the
    // email) is set on the stored `User` at login; this synth-from-key fallback
    // gives a referenced-but-unknown Microsoft user an identicon rather than a
    // blank silhouette, mirroring ORCID.
    return gravatarUrl(user.accountId);
  },

  directory: {
    // Meeting-tier only: Microsoft exposes no public directory we can query
    // without admin-consented Graph scopes, so we only surface Microsoft users
    // already in the meeting. Mirrors ORCID's / Google's local-only design.
    async searchUsers(_session, query, meeting, limit) {
      return meetingMicrosoftMatches(meeting, query, limit);
    },

    searchUsersLocal(_session, query, meeting, limit) {
      return meetingMicrosoftMatches(meeting, query, limit);
    },

    resolvePresenterFromDirectory(_session, query, meeting) {
      const matches = meetingMicrosoftMatches(meeting, query, 2);
      return matches.length === 1 ? matches[0] : null;
    },

    async warmDirectory() {
      // No external directory to prime.
    },
  },
};
