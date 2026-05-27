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

import type { User, DevUser } from '@tcq/shared';
import { DEV_USERS } from '@tcq/shared';
import { githubUser } from './auth/githubUser.js';

interface SeedEntry {
  ghid: number;
  name: string;
  organisation: string;
}

let seedByLogin: Map<string, SeedEntry> | null = null;
function getSeedByLogin(): Map<string, SeedEntry> {
  if (seedByLogin) return seedByLogin;
  seedByLogin = new Map();
  for (const u of DEV_USERS) {
    seedByLogin.set(u.login.toLowerCase(), {
      ghid: u.ghid,
      name: u.name,
      organisation: u.organisation ?? '',
    });
  }
  return seedByLogin;
}

/**
 * Stable numeric id for a mock user. A seeded TC39 login uses that member's
 * real GitHub id (so mock and OAuth agree); any other login gets a
 * deterministic hash so the same login resolves to the same `github:<id>`
 * key across requests and restarts.
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
  // `githubUser` produces the canonical GitHub `User` shape (provider,
  // accountId = numeric id, synthesised avatar) and applies the
  // name-falls-back-to-login rule.
  return githubUser({
    id: seed?.ghid ?? deterministicGhid(login),
    login,
    name: seed?.name,
    organisation: seed?.organisation,
  });
}

let seedById: Map<number, DevUser> | null = null;
function getSeedById(): Map<number, DevUser> {
  if (seedById) return seedById;
  seedById = new Map();
  for (const u of DEV_USERS) seedById.set(u.ghid, u);
  return seedById;
}

/**
 * Resolve a numeric GitHub id back to a mock `User` via the dev seed (the
 * mock-mode analogue of `GET /user/{id}`). Returns null for an id that
 * isn't a seed member — in mock mode the only resolvable accounts are seed
 * members and those already present in a meeting (handled by the caller).
 */
export function mockUserFromId(accountId: string): User | null {
  const seed = getSeedById().get(Number(accountId));
  if (!seed) return null;
  return githubUser({ id: seed.ghid, login: seed.login, name: seed.name, organisation: seed.organisation });
}
