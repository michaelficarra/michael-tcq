/**
 * The ORCID authentication provider — the first non-GitHub provider.
 *
 * Login uses the `/authenticate` 3-legged flow; ORCID's token response already
 * carries the iD and (public) display name, so basic sign-in needs no further
 * call. The public API (`../orcidApi.ts`) is used best-effort to enrich the
 * user with a Gravatar (from a public email) and current employer, and to back
 * the directory (registry search + iD lookup).
 *
 * ORCID has no handle and no avatar, so `User.handle` is undefined (the iD is
 * shown) and the avatar is synthesised via Gravatar (`orcidUser`).
 */

import type { MeetingState, User, DirectorySuggestion } from '@tcq/shared';
import type { AuthenticationProvider, OAuthProfile } from './provider.js';
import {
  ORCID_PROVIDER_ID,
  isOrcidConfigured,
  isOrcidId,
  normaliseOrcidId,
  gravatarUrl,
  orcidUser,
} from './orcidUser.js';
import { orcidBase, fetchOrcidPublic, orcidExpandedSearch, primeOrcidToken } from '../orcidApi.js';
import { warning, serialiseError } from '../logger.js';

const ORCID_CLIENT_ID = process.env.ORCID_CLIENT_ID ?? '';
const ORCID_CLIENT_SECRET = process.env.ORCID_CLIENT_SECRET ?? '';

/** Resolve a well-formed ORCID iD to a full User via the public record.
 *  Lenient: a well-formed iD always yields a user (name falls back to the iD),
 *  so a directory pick is never silently dropped during re-resolution. */
async function resolveById(id: string): Promise<User | null> {
  if (!isOrcidId(id)) return null;
  const normalised = normaliseOrcidId(id);
  const profile = await fetchOrcidPublic(normalised);
  return orcidUser({ id: normalised, name: profile.name, email: profile.email, organisation: profile.organisation });
}

/** Case-insensitive substring match of a query against an ORCID meeting
 *  participant's name / organisation / iD. Empty query matches all. */
function meetingOrcidMatches(meeting: MeetingState | undefined, query: string, limit: number): DirectorySuggestion[] {
  if (!meeting) return [];
  const q = query.trim().toLowerCase();
  const out: DirectorySuggestion[] = [];
  for (const user of Object.values(meeting.users)) {
    if (user.provider !== ORCID_PROVIDER_ID) continue;
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

export const orcidProvider: AuthenticationProvider = {
  id: ORCID_PROVIDER_ID,
  label: 'ORCID',
  get enabled() {
    return isOrcidConfigured();
  },

  authorizationUrl({ state, redirectUri }) {
    const params = new URLSearchParams({
      client_id: ORCID_CLIENT_ID,
      response_type: 'code',
      // `/authenticate` is the least-privilege scope; it returns the
      // authenticated iD (and public name) in the token response.
      scope: '/authenticate',
      redirect_uri: redirectUri,
      ...(state ? { state } : {}),
    });
    return `${orcidBase()}/oauth/authorize?${params}`;
  },

  async exchangeCode(code, redirectUri): Promise<OAuthProfile | null> {
    const body = new URLSearchParams({
      client_id: ORCID_CLIENT_ID,
      client_secret: ORCID_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    });
    let res: Response;
    try {
      res = await fetch(`${orcidBase()}/oauth/token`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
    } catch (err) {
      warning('orcid_oauth_error', { error: serialiseError(err) });
      return null;
    }
    if (!res.ok) {
      warning('orcid_oauth_token_error', { status: res.status });
      return null;
    }
    const data = (await res.json()) as { access_token?: string; orcid?: string; name?: string | null };
    if (!data.orcid) {
      warning('orcid_oauth_no_id', {});
      return null;
    }
    // Best-effort enrichment for the avatar (public email → Gravatar) and the
    // employer. Login still succeeds with just the iD + token name if this fails.
    const profile = await fetchOrcidPublic(data.orcid);
    const user = orcidUser({
      id: data.orcid,
      name: data.name ?? profile.name,
      email: profile.email,
      organisation: profile.organisation,
    });
    return { user, accessToken: data.access_token };
  },

  async resolveByAccountId(accountId): Promise<User | null> {
    return resolveById(accountId);
  },

  async resolveByHandle(handle): Promise<User | null> {
    // ORCID has no handle; only a pasted iD (or orcid.org URL) resolves. Other
    // free text returns null → an unverified placeholder upstream.
    return isOrcidId(handle) ? resolveById(handle) : null;
  },

  avatarUrl(user) {
    // Sync fallback: an identicon from the iD. The real-email Gravatar is set
    // on the stored User at construction (login / resolveByAccountId).
    return gravatarUrl(user.accountId);
  },

  directory: {
    async searchUsers(_session, query, meeting, limit) {
      const tier1 = meetingOrcidMatches(meeting, query, limit);

      // A pasted iD resolves directly; otherwise search the registry by
      // name/affiliation. Registry results carry no email, so their avatar is
      // an identicon until the pick is re-resolved (which fetches the email).
      let external: DirectorySuggestion[];
      if (isOrcidId(query)) {
        const direct = await resolveById(query);
        external = direct ? [{ user: direct }] : [];
      } else {
        const results = await orcidExpandedSearch(query, limit);
        external = results.map((r) => ({ user: orcidUser({ id: r.id, name: r.name, organisation: r.organisation }) }));
      }

      // Merge tier-1 (meeting) ahead of registry hits, dedupe by iD, cap.
      const seen = new Set<string>();
      const merged: DirectorySuggestion[] = [];
      for (const s of [...tier1, ...external]) {
        if (seen.has(s.user.accountId)) continue;
        seen.add(s.user.accountId);
        merged.push(s);
        if (merged.length >= limit) break;
      }
      return merged;
    },

    searchUsersLocal(_session, query, meeting, limit) {
      // Synchronous tier-1 only (meeting participants); no registry call.
      return meetingOrcidMatches(meeting, query, limit);
    },

    resolvePresenterFromDirectory(_session, query, meeting) {
      const matches = meetingOrcidMatches(meeting, query, 2);
      return matches.length === 1 ? matches[0] : null;
    },

    async warmDirectory() {
      // No per-user cache; just prime the shared read-public token.
      await primeOrcidToken();
    },
  },
};
