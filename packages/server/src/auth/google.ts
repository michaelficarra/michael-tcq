/**
 * The Google authentication provider — an OpenID Connect (OIDC) login.
 *
 * Google's authorization-code flow returns an `id_token` (a JWT) directly from
 * the token endpoint. That id_token already carries the full basic profile
 * (`sub`, `name`, `email`, `picture`, and the Workspace `hd` domain), so basic
 * sign-in needs no userinfo round-trip. We decode the JWT payload but do **not**
 * verify its signature: per Google's docs, signature verification is
 * unnecessary for the auth-code flow when the id_token is received directly
 * from Google's token endpoint over TLS — TLS authenticates Google's identity.
 *
 * Google deliberately has no public lookup-by-id, so there is no
 * `resolveByAccountId`: a Google user referenced before they log in (an agenda
 * presenter, a chair added by reference, a premium-list entry) is re-resolved
 * from the server-wide known-users cache (`../knownUsers.ts`) instead. An
 * unknown `google:<sub>` falls through to the badge silhouette.
 *
 * Google has no handle and no derivable avatar, so `User.handle` is undefined
 * (the `sub` is shown) and the avatar is the `picture` claim captured at login.
 */

import type { MeetingState, User, DirectorySuggestion } from '@tcq/shared';
import type { AuthenticationProvider, OAuthProfile } from './provider.js';
import { GOOGLE_PROVIDER_ID, isGoogleConfigured, googleUser } from './googleUser.js';
import { warning, serialiseError } from '../logger.js';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? '';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** The id_token claims we read. All optional except `sub` (the stable id). */
interface GoogleIdTokenClaims {
  sub: string;
  name?: string;
  email?: string;
  picture?: string;
  hd?: string;
}

/**
 * Decode (without verifying) the payload of a Google id_token. A JWT is
 * `header.payload.signature`; the middle segment is base64url-encoded JSON.
 * Returns null on any structural problem (wrong segment count, bad base64,
 * non-JSON, or a payload missing the `sub` claim).
 */
function decodeIdTokenPayload(jwt: string): GoogleIdTokenClaims | null {
  const segments = jwt.split('.');
  if (segments.length !== 3) return null;
  try {
    const json = Buffer.from(segments[1], 'base64url').toString('utf8');
    const claims = JSON.parse(json) as Partial<GoogleIdTokenClaims>;
    if (typeof claims.sub !== 'string' || claims.sub === '') return null;
    return claims as GoogleIdTokenClaims;
  } catch {
    return null;
  }
}

/** Case-insensitive substring match of a query against a Google meeting
 *  participant's name / organisation / sub. Empty query matches all. */
function meetingGoogleMatches(meeting: MeetingState | undefined, query: string, limit: number): DirectorySuggestion[] {
  if (!meeting) return [];
  const q = query.trim().toLowerCase();
  const out: DirectorySuggestion[] = [];
  for (const user of Object.values(meeting.users)) {
    if (user.provider !== GOOGLE_PROVIDER_ID) continue;
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

export const googleProvider: AuthenticationProvider = {
  id: GOOGLE_PROVIDER_ID,
  label: 'Google',
  get enabled() {
    return isGoogleConfigured();
  },

  authorizationUrl({ state, redirectUri }) {
    const params = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      response_type: 'code',
      // `openid` yields the id_token; `email profile` add the name, email,
      // picture, and (for Workspace) the `hd` domain claims.
      scope: 'openid email profile',
      redirect_uri: redirectUri,
      ...(state ? { state } : {}),
    });
    return `${GOOGLE_AUTH_URL}?${params}`;
  },

  async exchangeCode(code, redirectUri): Promise<OAuthProfile | null> {
    const body = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    });
    let res: Response;
    try {
      res = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
    } catch (err) {
      warning('google_oauth_error', { error: serialiseError(err) });
      return null;
    }
    if (!res.ok) {
      warning('google_oauth_token_error', { status: res.status });
      return null;
    }
    const data = (await res.json()) as { access_token?: string; id_token?: string };
    if (!data.id_token) {
      warning('google_oauth_no_id_token', {});
      return null;
    }
    const claims = decodeIdTokenPayload(data.id_token);
    if (!claims) {
      warning('google_oauth_bad_id_token', {});
      return null;
    }
    const user = googleUser({
      sub: claims.sub,
      name: claims.name,
      email: claims.email,
      picture: claims.picture,
      hd: claims.hd,
    });
    return { user, accessToken: data.access_token };
  },

  async resolveByHandle(): Promise<User | null> {
    // Google has no public lookup by any handle, so free text never resolves.
    return null;
  },

  // resolveByAccountId is intentionally omitted: Google has no public
  // lookup-by-id. Re-resolving a stored `google:<sub>` reference is handled by
  // the server-wide known-users cache (`../knownUsers.ts`); an account never
  // seen on this server degrades to the badge silhouette.

  avatarUrl() {
    // No avatar is derivable from the `sub` alone — Google has no avatar-by-id
    // endpoint. The real picture URL lives on the stored `User` (set from the
    // id_token `picture` claim at login); this synthesise-from-key fallback has
    // nothing to offer, so an otherwise-unknown user gets the badge silhouette.
    return '';
  },

  directory: {
    // Meeting-tier only: Google's directory API needs admin/Workspace scopes we
    // don't request, so we only ever surface Google users already in the
    // meeting. Mirrors ORCID's local-only design.
    async searchUsers(_session, query, meeting, limit) {
      return meetingGoogleMatches(meeting, query, limit);
    },

    searchUsersLocal(_session, query, meeting, limit) {
      return meetingGoogleMatches(meeting, query, limit);
    },

    resolvePresenterFromDirectory(_session, query, meeting) {
      const matches = meetingGoogleMatches(meeting, query, 2);
      return matches.length === 1 ? matches[0] : null;
    },

    async warmDirectory() {
      // No external directory to prime.
    },
  },
};
