/**
 * ORCID-specific `User` helpers, kept in a dependency-free leaf module so the
 * ORCID provider (`./orcid.ts`) and the public-API client (`../orcidApi.ts`)
 * can share them without import cycles. Mirrors `./githubUser.ts`.
 *
 * ORCID's `accountId` is the ORCID iD itself (e.g. `0000-0002-1825-0097`).
 * ORCID has no handle, so `User.handle` is left undefined — `userLabel` then
 * shows the iD. ORCID provides no avatar, so we synthesise one via Gravatar:
 * the SHA-256 of the researcher's public email when known, otherwise of the
 * iD (which yields a stable identicon, never a real photo).
 */

import { createHash } from 'node:crypto';
import type { User } from '@tcq/shared';

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

/**
 * Build the Gravatar avatar URL for an ORCID user. Gravatar keys off the
 * SHA-256 of the lowercased, trimmed email; `d=identicon` returns the real
 * photo when that hash matches a Gravatar account and a deterministic
 * identicon otherwise. With no public email we hash the iD instead, which is
 * stable per user but never matches an account (always an identicon).
 */
export function gravatarUrl(emailOrSeed: string): string {
  const hash = createHash('sha256').update(emailOrSeed.trim().toLowerCase()).digest('hex');
  return `https://gravatar.com/avatar/${hash}?d=identicon&s=80`;
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
