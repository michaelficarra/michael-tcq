/**
 * Resolves stored premium-user references into displayable `User` profiles for
 * the admin Premium-users panel.
 *
 * The premium list persists only canonical references (a bare GitHub handle,
 * or a `provider:accountId` like `github:5952481`) so it survives renames and
 * never collides across providers. The admin panel, however, wants to show the
 * person's real display name and avatar — neither of which is derivable from
 * the bare reference. This module bridges the two by resolving each reference
 * through its provider's `AuthenticationProvider` (`resolveByHandle` /
 * `resolveByAccountId`), exactly the way a directory pick is re-resolved
 * elsewhere. Nothing here is provider-specific: the bare-handle default and the
 * `provider:accountId` split mirror `canonicalUserRef`'s reference format, and
 * the avatar/name come from the provider, so adding a provider needs no change.
 *
 * Resolution is best-effort: a reference that can't be reached (offline, an
 * unknown id, a provider with no resolver) degrades to a display-only fallback
 * whose avatar is still synthesised by the provider's own `avatarUrl`. Successful
 * resolutions are cached briefly so the panel's ~10 s poll doesn't make a
 * provider API call per reference on every tick.
 */

import type { User, PremiumUser } from '@tcq/shared';
import type { AuthenticationProvider } from './auth/provider.js';
import { providerById } from './auth/registry.js';
import { GITHUB_PROVIDER_ID } from './auth/githubUser.js';
import { getKnownUserByProviderAccount, getKnownUserByHandle } from './knownUsers.js';

interface CacheEntry {
  user: User;
  expiresAt: number;
}

// Process-global cache keyed by canonical reference, shared across every
// request and admin session. Display names/avatars change rarely and an admin
// panel tolerates staleness, so the TTL is generous (1 hour): a reference is
// resolved through its provider at most once per hour no matter how many times
// the panel is loaded or how often its ~10 s poll fires.
const cache = new Map<string, CacheEntry>();
const TTL_MS = 60 * 60_000;

/** Clear the resolution cache (tests). */
export function resetPremiumDirectoryForTesting(): void {
  cache.clear();
}

/**
 * Split a canonical reference into provider + identifier. This is purely the
 * inverse of `canonicalUserRef`'s encoding: a bare reference (no colon) is a
 * GitHub handle; `provider:rest` is a provider-qualified account id (`rest` is
 * the `accountId`, the same form `userKey` produces).
 */
function parseRef(ref: string): { provider: string; accountId: string; isBareHandle: boolean } {
  const colon = ref.indexOf(':');
  if (colon === -1) return { provider: GITHUB_PROVIDER_ID, accountId: ref, isBareHandle: true };
  return { provider: ref.slice(0, colon), accountId: ref.slice(colon + 1), isBareHandle: false };
}

/**
 * Resolve through the provider: a bare handle resolves by handle; a
 * provider-qualified reference resolves by its account id. Returns null when
 * the provider is unknown, lacks the relevant resolver, or doesn't recognise
 * the value.
 */
async function resolveViaProvider(
  impl: AuthenticationProvider,
  ref: { accountId: string; isBareHandle: boolean },
): Promise<User | null> {
  if (ref.isBareHandle) return impl.resolveByHandle(ref.accountId);
  return impl.resolveByAccountId ? impl.resolveByAccountId(ref.accountId) : null;
}

/**
 * Display-only `User` used when a reference can't be resolved. The avatar is
 * still synthesised by the provider's own `avatarUrl` (GitHub derives one from
 * the handle/id; ORCID a Gravatar identicon), so no provider-specific URL
 * logic lives here. The name is the handle/id — the best label available
 * without a successful lookup.
 */
function fallbackUser(ref: string): User {
  const { provider, accountId, isBareHandle } = parseRef(ref);
  const impl = providerById(provider);
  const handle = isBareHandle ? accountId : undefined;
  return {
    provider,
    accountId,
    ...(handle ? { handle } : {}),
    name: accountId,
    organisation: '',
    avatarUrl: impl?.avatarUrl({ handle, accountId }) ?? '',
  };
}

/** Resolve a single reference, consulting (and populating) the cache. */
async function resolveOne(ref: string): Promise<User> {
  const cached = cache.get(ref);
  if (cached && Date.now() < cached.expiresAt) return cached.user;

  const parsed = parseRef(ref);

  // Before any provider round-trip, consult the server-wide known-users cache:
  // a user seen anywhere on this server (login or any meeting) resolves to a
  // real name + avatar for free. This is the only path that resolves a Google
  // reference, which has no public lookup-by-id. A bare reference is a GitHub
  // handle; otherwise it's a `provider:accountId` key.
  const seen = parsed.isBareHandle
    ? getKnownUserByHandle(parsed.accountId)
    : getKnownUserByProviderAccount(parsed.provider, parsed.accountId);
  if (seen) {
    // Promote into the TTL cache so the panel's ~10 s poll is pure-cache for
    // the next hour, exactly as a provider-resolved hit would be.
    cache.set(ref, { user: seen, expiresAt: Date.now() + TTL_MS });
    return seen;
  }

  const impl = providerById(parsed.provider);
  let resolved: User | null = null;
  try {
    if (impl) resolved = await resolveViaProvider(impl, parsed);
  } catch {
    resolved = null;
  }

  if (resolved) {
    cache.set(ref, { user: resolved, expiresAt: Date.now() + TTL_MS });
    return resolved;
  }
  // Don't cache fallbacks — a transient failure shouldn't pin the bad result
  // for the whole TTL; the next poll retries.
  return fallbackUser(ref);
}

/** Resolve every reference in parallel into a `{ ref, user }` entry. */
export async function resolvePremiumUsers(refs: readonly string[]): Promise<PremiumUser[]> {
  return Promise.all(refs.map(async (ref) => ({ ref, user: await resolveOne(ref) })));
}
