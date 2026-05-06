/**
 * Resolve a GitHub login into a mock-mode `User` by combining a
 * deterministic ghid (a hash of the login) with display name and
 * organisation looked up from the static dev seed list
 * (`packages/shared/src/devUsers.ts`).
 *
 * The seed list is generated from the membership of the tc39 GitHub
 * organisation via GraphQL (see `scripts/refresh-dev-users.mjs`), so
 * when a developer switches to a real TC39 member's login the resulting
 * mock user gets that member's real name and company — the same data
 * the real OAuth flow would produce — with no network access at runtime.
 *
 * Logins not present in the seed (e.g. the default `admin`, or arbitrary
 * names a developer types into the user-switcher) fall back to using the
 * raw login as the display name and an empty organisation.
 */

import type { User } from '@tcq/shared';
import { DEV_USERS } from '@tcq/shared';

interface SeedEntry {
  name: string;
  organisation: string;
}

let seedByLogin: Map<string, SeedEntry> | null = null;
function getSeedByLogin(): Map<string, SeedEntry> {
  if (seedByLogin) return seedByLogin;
  seedByLogin = new Map();
  for (const u of DEV_USERS) {
    seedByLogin.set(u.login.toLowerCase(), {
      name: u.name,
      organisation: u.organisation ?? '',
    });
  }
  return seedByLogin;
}

/**
 * Stable hash of the login so the same username always resolves to the
 * same numeric ghid across requests and across server restarts. Same
 * algorithm as the original inline implementation in `routes.ts` so the
 * ids the dev switcher used to produce continue to round-trip.
 */
function deterministicGhid(login: string): number {
  let hash = 0;
  for (const ch of login) {
    hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
  }
  return Math.abs(hash);
}

export function mockUserFromLogin(login: string): User {
  const seed = getSeedByLogin().get(login.toLowerCase());
  return {
    ghid: deterministicGhid(login),
    ghUsername: login,
    name: seed?.name ?? login,
    organisation: seed?.organisation ?? '',
  };
}
