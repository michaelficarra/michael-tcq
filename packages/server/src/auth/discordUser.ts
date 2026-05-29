/**
 * Discord-specific `User` helpers, kept in a dependency-free leaf module so the
 * Discord provider (`./discord.ts`) can share them without import cycles.
 *
 * Discord's `accountId` is the user's numeric snowflake id (e.g.
 * `80351110224678912`) — opaque and stable, used as the key. The `username` is
 * Discord's globally-unique handle (unique since the 2023 discriminator
 * removal), stored as `User.handle` so `userLabel` shows `@username · discord`
 * in the badge tooltip — like a GitHub login. It can change, which is fine: a
 * GitHub login can too, and the snowflake id remains the stable key. The
 * display name prefers the `global_name`. We do **not** request or store the
 * email (the `email` scope is not requested), so no email is ever exposed. The
 * avatar is built from the account id + avatar hash captured at login (Discord's
 * CDN); there is no way to derive one from the id alone, so users referenced
 * before they log in rely on the known-users cache (`../knownUsers.ts`).
 */

import type { User } from '@tcq/shared';

/** The provider id Discord-sourced users carry in `User.provider`. */
export const DISCORD_PROVIDER_ID = 'discord';

/** Whether Discord OAuth credentials are configured (both id and secret). */
export function isDiscordConfigured(): boolean {
  return !!process.env.DISCORD_CLIENT_ID && !!process.env.DISCORD_CLIENT_SECRET;
}

/**
 * Build the CDN URL for a Discord avatar from the user's id and avatar hash.
 * Returns '' when the user has no custom avatar (hash absent) — the client
 * then falls back to the generic silhouette, mirroring Google.
 */
export function discordAvatarUrl(id: string, avatarHash?: string | null): string {
  return avatarHash ? `https://cdn.discordapp.com/avatars/${id}/${avatarHash}.png` : '';
}

/**
 * Build a resolved Discord `User` from the `GET /users/@me` profile. The
 * snowflake `id` is the canonical `accountId`/key; the `username` is the
 * (globally-unique) handle. The display name prefers the `global_name`, then
 * the `username`, then the id — so a `User` always has a non-empty label.
 * Discord exposes no organisation, so it is left empty.
 */
export function discordUser(fields: {
  id: string;
  username: string;
  globalName?: string | null;
  avatar?: string | null;
}): User {
  return {
    provider: DISCORD_PROVIDER_ID,
    accountId: fields.id,
    // Discord's globally-unique username is the handle (mutable, like a GitHub
    // login; the snowflake id stays the stable key). Empty → no handle.
    handle: fields.username || undefined,
    // `||` (not `??`) so an empty/whitespace/absent value falls through to the
    // next fallback, ending at the opaque id as a last resort.
    name: fields.globalName?.trim() || fields.username?.trim() || fields.id,
    organisation: '',
    avatarUrl: discordAvatarUrl(fields.id, fields.avatar),
  };
}
