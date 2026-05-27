/**
 * Resolve a GitHub login into a mock-mode `User`, with display name and
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
import { githubUser } from './auth/githubUser.js';

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

export function mockUserFromLogin(login: string): User {
  const seed = getSeedByLogin().get(login.toLowerCase());
  // `githubUser` produces the canonical GitHub `User` shape (provider,
  // accountId = lowercased login, synthesised avatar) and applies the
  // name-falls-back-to-login rule.
  return githubUser({ login, name: seed?.name, organisation: seed?.organisation });
}
