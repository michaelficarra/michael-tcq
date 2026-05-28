/**
 * Google-specific `User` helpers, kept in a dependency-free leaf module so the
 * Google provider (`./google.ts`) can share them without import cycles.
 * Mirrors `./orcidUser.ts`.
 *
 * Google's `accountId` is the OIDC `sub` claim — an opaque, stable numeric
 * string (e.g. `110169484474386276334`). Google has no handle, so
 * `User.handle` is left undefined and `userLabel` shows `<sub> · google`.
 * The avatar is the `picture` claim from the id_token (a Google CDN URL),
 * captured at login; Google offers no way to derive one from the `sub` alone,
 * so users referenced before they log in rely on the known-users cache
 * (`../knownUsers.ts`) for a real avatar.
 */

import type { User } from '@tcq/shared';

/** The provider id Google-sourced users carry in `User.provider`. */
export const GOOGLE_PROVIDER_ID = 'google';

/** Whether Google OAuth credentials are configured (both id and secret). */
export function isGoogleConfigured(): boolean {
  return !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET;
}

/**
 * Build a resolved Google `User` from the decoded id_token claims. The `sub`
 * claim is the canonical `accountId`/key. The display name falls back to the
 * email and then the `sub`, so a `User` always has a non-empty label. The
 * Workspace `hd` (hosted-domain) claim becomes the organisation when present
 * (empty for consumer Google accounts).
 */
export function googleUser(fields: {
  sub: string;
  name?: string | null;
  email?: string | null;
  picture?: string | null;
  hd?: string | null;
}): User {
  return {
    provider: GOOGLE_PROVIDER_ID,
    accountId: fields.sub,
    // No handle — the `sub` is the identifier. `userLabel` renders `<sub> · google`.
    handle: undefined,
    // `||` (not `??`) so an empty/whitespace/absent name falls through to the
    // email, then the opaque `sub` as a last resort.
    name: fields.name?.trim() || fields.email?.trim() || fields.sub,
    organisation: fields.hd?.trim() ?? '',
    avatarUrl: fields.picture ?? '',
  };
}
