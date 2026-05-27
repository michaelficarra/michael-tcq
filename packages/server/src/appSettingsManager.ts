/**
 * In-memory cache and runtime API for the global `AppSettings`
 * document. Sibling to `MeetingManager`: kept separate because
 * `MeetingManager`'s dirty/sync machinery is per-meeting-id, which
 * doesn't map cleanly onto a singleton.
 *
 * Reads are synchronous — every state broadcast goes through
 * `isPremium` and we don't want to block that path on an awaitable
 * store lookup. Writes are eager: each `add…`/`remove…` awaits the
 * underlying store before returning, so a 200 from the admin REST
 * handler implies the change is durable.
 */

import type { User } from '@tcq/shared';
import { userKey, migrateKey, isLegacyAppSettings } from '@tcq/shared';
import type { AppSettingsStore } from './appSettingsStore.js';

export class AppSettingsManager {
  /** Canonical list — trimmed, lowercased, deduped, sorted. */
  private usernames: string[] = [];

  /**
   * Derived from `usernames`; rebuilt on every mutation. Kept as a
   * `Set` so `isPremium` is O(1).
   */
  private premiumSet = new Set<string>();

  /**
   * Tail of the in-flight write chain. Each `addPremiumUsername` /
   * `removePremiumUsername` queues onto this promise so that concurrent
   * callers don't interleave the read-modify-write cycle and lose
   * mutations (e.g. two adds both reading an empty list and persisting
   * a one-element list).
   */
  private writeTail: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: AppSettingsStore) {}

  /**
   * Load the persisted settings into memory. Call once during server
   * startup. Idempotent: re-running replaces the in-memory cache.
   */
  async restore(): Promise<void> {
    const settings = await this.store.load();
    this.usernames = canonicalise(settings.premiumUsernames);
    this.rebuildSet();
    // Lazy migration: if any persisted entry was still a bare (pre-prefix)
    // username, `canonicalise` has upgraded it to a `github:` key — persist
    // the upgraded list once so the on-disk form catches up.
    if (isLegacyAppSettings(settings)) {
      await this.store.save({ premiumUsernames: this.usernames });
    }
  }

  /**
   * Snapshot of the canonical premium-user list. The returned array
   * is a fresh copy — callers can mutate it without affecting the
   * manager. Sorted lexicographically so REST responses are stable.
   */
  getPremiumUsernames(): string[] {
    return [...this.usernames];
  }

  /**
   * Synchronous premium-membership check, used by every state
   * broadcast and every /api/me response. Membership is checked
   * against the canonical `${provider}:${accountId}` key.
   */
  isPremium(user: User): boolean {
    return this.premiumSet.has(userKey(user));
  }

  /**
   * Add `rawUsername` to the premium list. The admin panel passes a bare
   * GitHub username, which is expanded to a `github:` key. Returns the
   * canonical key that was added, or `null` if it was already present
   * (idempotent — admins double-clicking shouldn't see an error) or the
   * input was empty. Persists eagerly before resolving.
   */
  async addPremiumUsername(rawUsername: string): Promise<string | null> {
    const trimmed = rawUsername.trim().toLowerCase();
    if (trimmed === '') return null;
    const canonical = migrateKey(trimmed) as string;
    return this.enqueue(async () => {
      if (this.premiumSet.has(canonical)) return null;
      const next = canonicalise([...this.usernames, canonical]);
      await this.store.save({ premiumUsernames: next });
      this.usernames = next;
      this.rebuildSet();
      return canonical;
    });
  }

  /**
   * Remove `rawUsername` from the premium list. Returns `true` when
   * a row was removed, `false` when the username wasn't present
   * (idempotent). Persists eagerly before resolving.
   */
  async removePremiumUsername(rawUsername: string): Promise<boolean> {
    const trimmed = rawUsername.trim().toLowerCase();
    if (trimmed === '') return false;
    const canonical = migrateKey(trimmed) as string;
    return this.enqueue(async () => {
      if (!this.premiumSet.has(canonical)) return false;
      const next = this.usernames.filter((u) => u !== canonical);
      await this.store.save({ premiumUsernames: next });
      this.usernames = next;
      this.rebuildSet();
      return true;
    });
  }

  /**
   * Run `task` after any in-flight mutation finishes, so the read of
   * `this.usernames` / `this.premiumSet` inside `task` sees the result
   * of all prior writes rather than a pre-write snapshot. The chain
   * uses `.catch(noop)` for the wait so an earlier failure doesn't
   * poison subsequent writes — each task surfaces its own error.
   */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writeTail.then(
      () => task(),
      () => task(),
    );
    this.writeTail = run.catch(() => {});
    return run;
  }

  private rebuildSet(): void {
    this.premiumSet = new Set(this.usernames);
  }
}

/**
 * Trim, lowercase, expand bare usernames to `github:` keys, dedupe, and
 * sort to the canonical persisted shape. The `migrateKey` step is what
 * upgrades a pre-multi-provider premium list (bare usernames) to keys.
 */
function canonicalise(usernames: readonly string[]): string[] {
  const out = new Set<string>();
  for (const u of usernames) {
    const c = u.trim().toLowerCase();
    if (c !== '') out.add(migrateKey(c) as string);
  }
  return [...out].sort();
}
