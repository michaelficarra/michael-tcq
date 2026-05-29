/**
 * Microsoft-specific `User` helpers, kept in a dependency-free leaf module so
 * the Microsoft provider (`./microsoft.ts`) can share them without import
 * cycles. Mirrors `./googleUser.ts`.
 *
 * Microsoft's `accountId` is the OIDC `sub` claim — an opaque string that is
 * stable for a given user within this application. Microsoft has no handle, so
 * `User.handle` is left undefined; the email/UPN is stored as `email` so
 * `userLabel` can show `<email> · microsoft` in the badge tooltip (the opaque
 * `sub` means nothing to a human), falling back to the `sub` only when neither
 * an email nor a `preferred_username` is available. Microsoft's id_token
 * carries no avatar (a real photo needs a separate Microsoft Graph binary
 * call), so — like ORCID — we synthesise a Gravatar (`./gravatar.ts`) from the
 * email: the user's real photo when it's registered with Gravatar, otherwise a
 * deterministic identicon.
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
 * claim is the canonical `accountId`/key. The `email` claim is often absent,
 * but `preferred_username` is almost always present and is typically the
 * email/UPN, so we use `email || preferred_username` as the human-readable
 * identifier — stored as `email` (for the badge tooltip), used as the display
 * name fallback, and as the Gravatar seed. Falls back to the opaque `sub` when
 * neither is present. Organisation is left empty because the id_token carries
 * no human-readable organisation claim.
 */
export function microsoftUser(fields: {
  sub: string;
  name?: string | null;
  email?: string | null;
  preferredUsername?: string | null;
}): User {
  const email = fields.email?.trim() || fields.preferredUsername?.trim() || undefined;
  return {
    provider: MICROSOFT_PROVIDER_ID,
    accountId: fields.sub,
    // No handle — the email/UPN (when present) is the recognisable label
    // `userLabel` shows in the badge tooltip; otherwise the opaque `sub`.
    handle: undefined,
    // `||` (not `??`) so an empty/whitespace/absent value falls through the chain.
    name: fields.name?.trim() || email || fields.sub,
    organisation: '',
    // Real Gravatar when the email is registered; otherwise a stable identicon.
    avatarUrl: gravatarUrl(email || fields.sub),
    // Display-only, surfaced in the hover tooltip; omitted when absent.
    ...(email ? { email } : {}),
  };
}
