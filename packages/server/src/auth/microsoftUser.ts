/**
 * Microsoft-specific `User` helpers, kept in a dependency-free leaf module so
 * the Microsoft provider (`./microsoft.ts`) can share them without import
 * cycles. Mirrors `./googleUser.ts`.
 *
 * Microsoft's `accountId` is the OIDC `sub` claim — an opaque string that is
 * stable for a given user within this application. Microsoft has no handle, so
 * `User.handle` is left undefined and `userLabel` shows `<sub> · microsoft`.
 * Microsoft's id_token carries no avatar (a real photo needs a separate
 * Microsoft Graph binary call), so — like ORCID — we synthesise a Gravatar
 * (`./gravatar.ts`) from the account email: the user's real photo when it's
 * registered with Gravatar, otherwise a deterministic identicon.
 */

import type { User } from '@tcq/shared';
import { gravatarUrl } from './gravatar.js';

/** The provider id Microsoft-sourced users carry in `User.provider`. */
export const MICROSOFT_PROVIDER_ID = 'microsoft';

/** Whether Microsoft OAuth credentials are configured (both id and secret). */
export function isMicrosoftConfigured(): boolean {
  return !!process.env.MICROSOFT_CLIENT_ID && !!process.env.MICROSOFT_CLIENT_SECRET;
}

/**
 * Build a resolved Microsoft `User` from the decoded id_token claims. The `sub`
 * claim is the canonical `accountId`/key. The display name falls back through
 * `preferred_username` (usually the email/UPN) and `email` to the opaque `sub`,
 * so a `User` always has a non-empty label. The Gravatar seed prefers a real
 * email so a registered photo can surface; organisation is left empty because
 * the id_token carries no human-readable organisation claim.
 */
export function microsoftUser(fields: {
  sub: string;
  name?: string | null;
  email?: string | null;
  preferredUsername?: string | null;
}): User {
  const seed = fields.email?.trim() || fields.preferredUsername?.trim() || fields.sub;
  return {
    provider: MICROSOFT_PROVIDER_ID,
    accountId: fields.sub,
    // No handle — the `sub` is the identifier. `userLabel` renders `<sub> · microsoft`.
    handle: undefined,
    // `||` (not `??`) so an empty/whitespace/absent value falls through the chain.
    name: fields.name?.trim() || fields.preferredUsername?.trim() || fields.email?.trim() || fields.sub,
    organisation: '',
    // Real Gravatar when the email is registered; otherwise a stable identicon.
    avatarUrl: gravatarUrl(seed),
  };
}
