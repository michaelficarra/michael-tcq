/**
 * Gravatar avatar URLs, in a dependency-free leaf so any provider that lacks a
 * provider-supplied avatar can share it without import cycles. Used by ORCID
 * (`./orcidUser.ts`) and Microsoft (`./microsoftUser.ts`), neither of which
 * hands back an avatar URL.
 */

import { createHash } from 'node:crypto';

/**
 * Build the Gravatar avatar URL for a user. Gravatar keys off the SHA-256 of
 * the lowercased, trimmed email; `d=identicon` returns the real photo when that
 * hash matches a Gravatar account and a deterministic identicon otherwise. With
 * no email we hash a stable seed (the account id) instead, which is stable per
 * user but never matches an account (always an identicon).
 */
export function gravatarUrl(emailOrSeed: string): string {
  const hash = createHash('sha256').update(emailOrSeed.trim().toLowerCase()).digest('hex');
  return `https://gravatar.com/avatar/${hash}?d=identicon&s=80`;
}
