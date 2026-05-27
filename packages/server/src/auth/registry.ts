/**
 * The authentication-provider registry: the single list of providers TCQ
 * knows about, and the helpers the rest of the server uses to look one up
 * or ask whether any are configured.
 *
 * Adding a provider (Google, ORCID) is a one-line change here once its
 * implementation exists alongside `./github.ts`.
 */

import type { AuthenticationProvider } from './provider.js';
import { githubProvider } from './github.js';

/** All known providers, enabled or not. Order is the login-button order. */
const ALL_PROVIDERS: readonly AuthenticationProvider[] = [githubProvider];

/** Providers that are actually configured (credentials present). */
export function enabledProviders(): AuthenticationProvider[] {
  return ALL_PROVIDERS.filter((p) => p.enabled);
}

/** Look up an enabled provider by id; undefined if unknown or disabled. */
export function getProvider(id: string): AuthenticationProvider | undefined {
  return ALL_PROVIDERS.find((p) => p.id === id && p.enabled);
}

/**
 * Whether any provider is configured. When false the server runs in
 * mock-auth mode (a fake user is injected and `/api/dev/switch-user` is
 * enabled). This is the multi-provider generalisation of the former
 * single-provider `isOAuthConfigured()` check.
 */
export function isAnyProviderConfigured(): boolean {
  return ALL_PROVIDERS.some((p) => p.enabled);
}
