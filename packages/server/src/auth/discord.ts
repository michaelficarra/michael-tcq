/**
 * The Discord authentication provider — a plain OAuth 2.0 login (not OIDC).
 *
 * Discord's authorization-code exchange returns an opaque access token (no
 * id_token), so basic sign-in needs one extra call: `GET /users/@me` with the
 * bearer token returns the profile (`id`, `username`, `global_name`, `avatar`,
 * `email`). The token exchange is form-encoded like the OIDC providers; the
 * profile fetch mirrors GitHub's bearer-authenticated `GET /user`.
 *
 * Discord has no public lookup-by-id with a user's own credentials, so — like
 * Google — there is no `resolveByAccountId`: a Discord user referenced before
 * they log in (an agenda presenter, a chair added by reference, a premium-list
 * entry) is re-resolved from the server-wide known-users cache
 * (`../knownUsers.ts`), and an unknown `discord:<id>` falls through to the
 * badge silhouette. The avatar is the CDN URL built from the account id +
 * avatar hash captured at login (see `./discordUser.ts`).
 */

import type { MeetingState, User, DirectorySuggestion } from '@tcq/shared';
import type { AuthenticationProvider, OAuthProfile } from './provider.js';
import { DISCORD_PROVIDER_ID, isDiscordConfigured, discordUser } from './discordUser.js';
import { warning, serialiseError } from '../logger.js';

const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID ?? '';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET ?? '';

const DISCORD_AUTH_URL = 'https://discord.com/oauth2/authorize';
const DISCORD_TOKEN_URL = 'https://discord.com/api/oauth2/token';
const DISCORD_USER_URL = 'https://discord.com/api/users/@me';

/** Case-insensitive substring match of a query against a Discord meeting
 *  participant's name / organisation / id / username. Empty query matches all. */
function meetingDiscordMatches(meeting: MeetingState | undefined, query: string, limit: number): DirectorySuggestion[] {
  if (!meeting) return [];
  const q = query.trim().toLowerCase();
  const out: DirectorySuggestion[] = [];
  for (const user of Object.values(meeting.users)) {
    if (user.provider !== DISCORD_PROVIDER_ID) continue;
    if (
      q.length === 0 ||
      user.name.toLowerCase().includes(q) ||
      user.organisation.toLowerCase().includes(q) ||
      user.accountId.toLowerCase().includes(q) ||
      (user.handle?.toLowerCase().includes(q) ?? false)
    ) {
      out.push({ user, badge: 'meeting' });
      if (out.length >= limit) break;
    }
  }
  return out;
}

export const discordProvider: AuthenticationProvider = {
  id: DISCORD_PROVIDER_ID,
  label: 'Discord',
  get enabled() {
    return isDiscordConfigured();
  },

  authorizationUrl({ state, redirectUri }) {
    const params = new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      response_type: 'code',
      // `identify` yields the basic profile (id, username, global_name,
      // avatar). We deliberately do not request `email` — it is never shown.
      scope: 'identify',
      redirect_uri: redirectUri,
      ...(state ? { state } : {}),
    });
    return `${DISCORD_AUTH_URL}?${params}`;
  },

  async exchangeCode(code, redirectUri): Promise<OAuthProfile | null> {
    // Step 1: exchange the authorisation code for an access token.
    const body = new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      client_secret: DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    });
    let tokenRes: Response;
    try {
      tokenRes = await fetch(DISCORD_TOKEN_URL, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
    } catch (err) {
      warning('discord_oauth_error', { error: serialiseError(err) });
      return null;
    }
    if (!tokenRes.ok) {
      warning('discord_oauth_token_error', { status: tokenRes.status });
      return null;
    }
    const tokenData = (await tokenRes.json()) as { access_token?: string };
    if (!tokenData.access_token) {
      warning('discord_oauth_no_access_token', {});
      return null;
    }

    // Step 2: fetch the user's profile with the access token.
    let userRes: Response;
    try {
      userRes = await fetch(DISCORD_USER_URL, {
        headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: 'application/json' },
      });
    } catch (err) {
      warning('discord_profile_error', { error: serialiseError(err) });
      return null;
    }
    if (!userRes.ok) {
      warning('discord_profile_status_error', { status: userRes.status });
      return null;
    }
    const profile = (await userRes.json()) as {
      id?: string;
      username?: string;
      global_name?: string | null;
      avatar?: string | null;
    };
    if (!profile.id || !profile.username) {
      warning('discord_profile_invalid', {});
      return null;
    }
    const user = discordUser({
      id: profile.id,
      username: profile.username,
      globalName: profile.global_name,
      avatar: profile.avatar,
    });
    // No server-side access token is retained — there are no post-login Discord
    // API calls (the directory is meeting-tier only).
    return { user };
  },

  async resolveByHandle(): Promise<User | null> {
    // Discord has no public lookup by username, so free text never resolves.
    return null;
  },

  // resolveByAccountId is intentionally omitted: Discord has no public
  // lookup-by-id with a user's own credentials. Re-resolving a stored
  // `discord:<id>` reference is handled by the server-wide known-users cache
  // (`../knownUsers.ts`); an account never seen on this server degrades to the
  // badge silhouette.

  avatarUrl() {
    // The avatar needs the per-user avatar hash, available only in the profile
    // captured at login (stored on the `User`). Nothing is derivable from the
    // account id alone, so this synthesise-from-key fallback yields the
    // silhouette — mirrors Google.
    return '';
  },

  directory: {
    // Meeting-tier only: Discord exposes no public directory API for the scopes
    // we request, so we only ever surface Discord users already in the meeting.
    // Mirrors Google's and ORCID's local-only design.
    async searchUsers(_session, query, meeting, limit) {
      return meetingDiscordMatches(meeting, query, limit);
    },

    searchUsersLocal(_session, query, meeting, limit) {
      return meetingDiscordMatches(meeting, query, limit);
    },

    resolvePresenterFromDirectory(_session, query, meeting) {
      const matches = meetingDiscordMatches(meeting, query, 2);
      return matches.length === 1 ? matches[0] : null;
    },

    async warmDirectory() {
      // No external directory to prime.
    },
  },
};
