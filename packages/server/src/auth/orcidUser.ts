/**
 * ORCID-specific `User` helpers, kept in a dependency-free leaf module so the
 * ORCID provider (`./orcid.ts`) and the public-API client (`../orcidApi.ts`)
 * can share them without import cycles. Mirrors `./githubUser.ts`.
 *
 * ORCID's `accountId` is the ORCID iD itself (e.g. `0000-0002-1825-0097`).
 * ORCID has no handle, so `User.handle` is left undefined — `userLabel` then
 * shows the iD. ORCID provides no avatar, so we synthesise one via Gravatar
 * (`./gravatar.ts`): the SHA-256 of the researcher's public email when known,
 * otherwise of the iD (which yields a stable identicon, never a real photo).
 */

import type { User } from '@tcq/shared';
import { gravatarUrl } from './gravatar.js';

// Re-exported for back-compat: existing call sites import `gravatarUrl` from
// this module (the ORCID provider and its tests). The implementation now lives
// in the shared `./gravatar.ts` leaf so non-ORCID providers can reuse it.
export { gravatarUrl } from './gravatar.js';

/** The provider id ORCID-sourced users carry in `User.provider`. */
export const ORCID_PROVIDER_ID = 'orcid';

/** Whether ORCID OAuth credentials are configured (both id and secret). */
export function isOrcidConfigured(): boolean {
  return !!process.env.ORCID_CLIENT_ID && !!process.env.ORCID_CLIENT_SECRET;
}

/**
 * ORCID iD: four groups of four characters, hyphen-separated, the last of
 * which may be the checksum `X`. Used to recognise a pasted iD (so it can be
 * resolved directly) and to validate search input.
 */
const ORCID_ID_RE = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/;

/** True when `s` is a bare ORCID iD (optionally an `https://orcid.org/<iD>` URL). */
export function isOrcidId(s: string): boolean {
  return ORCID_ID_RE.test(normaliseOrcidId(s));
}

/** Strip a leading `https://orcid.org/` (or sandbox) and surrounding space,
 *  uppercasing a trailing `x` checksum, to get the bare iD. */
export function normaliseOrcidId(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\/(?:sandbox\.)?orcid\.org\//i, '')
    .toUpperCase();
}

/** Build a resolved ORCID `User`. The iD is the canonical `accountId`/key. */
export function orcidUser(fields: {
  id: string;
  name?: string | null;
  email?: string | null;
  organisation?: string | null;
}): User {
  const id = normaliseOrcidId(fields.id);
  return {
    provider: ORCID_PROVIDER_ID,
    accountId: id,
    // No handle — the iD is the identifier. `userLabel` renders `<iD> · orcid`.
    handle: undefined,
    // `||` (not `??`) so an empty/whitespace/absent name falls through to the iD.
    name: fields.name?.trim() || id,
    organisation: fields.organisation?.trim() ?? '',
    // Real Gravatar when we have a public email; otherwise a stable identicon.
    avatarUrl: gravatarUrl(fields.email?.trim() || id),
  };
}
