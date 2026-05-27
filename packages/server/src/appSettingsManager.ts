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

import type { User, UserRefIndex } from '@tcq/shared';
import { canonicalUserRef, buildUserRefIndex, userMatchesIndex } from '@tcq/shared';
import type { AppSettingsStore } from './appSettingsStore.js';

export class AppSettingsManager {
  /** Canonical reference list — bare GitHub handles or `provider:id`,
   *  canonicalised, deduped, sorted. */
  private usernames: string[] = [];

  /**
   * Index derived from `usernames`; rebuilt on every mutation. Keeps
   * `isPremium` O(1) (key-set + GitHub-handle-set membership).
   */
  private premiumIndex: UserRefIndex = buildUserRefIndex([]);

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
    this.rebuildIndex();
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
   * Synchronous premium-membership check, used by every state broadcast and
   * every /api/me response. Matches the user against the canonical reference
   * list — a bare GitHub handle, or a `provider:id` key — via the O(1) index.
   */
  isPremium(user: User): boolean {
    return userMatchesIndex(user, this.premiumIndex);
  }

  /**
   * Add a reference (a GitHub handle or a `provider:id`) to the premium list.
   * Returns the canonical form that was added, or `null` if it was already
   * present (idempotent — admins double-clicking shouldn't see an error) or
   * the input was empty/invalid. Persists eagerly before resolving.
   */
  async addPremiumUsername(rawUsername: string): Promise<string | null> {
    const canonical = canonicalUserRef(rawUsername);
    if (canonical === null) return null;
    return this.enqueue(async () => {
      if (this.usernames.includes(canonical)) return null;
      const next = canonicalise([...this.usernames, canonical]);
      await this.store.save({ premiumUsernames: next });
      this.usernames = next;
      this.rebuildIndex();
      return canonical;
    });
  }

  /**
   * Remove a reference from the premium list. Returns the canonical form
   * when a row was removed, `null` when it wasn't present (idempotent).
   * Persists eagerly before resolving.
   */
  async removePremiumUsername(rawUsername: string): Promise<string | null> {
    const canonical = canonicalUserRef(rawUsername);
    if (canonical === null) return null;
    return this.enqueue(async () => {
      if (!this.usernames.includes(canonical)) return null;
      const next = this.usernames.filter((u) => u !== canonical);
      await this.store.save({ premiumUsernames: next });
      this.usernames = next;
      this.rebuildIndex();
      return canonical;
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

  private rebuildIndex(): void {
    this.premiumIndex = buildUserRefIndex(this.usernames);
  }
}

/** Canonicalise each reference (bare GitHub handle or `provider:id`), drop
 *  invalid/empty entries, dedupe, and sort to the canonical persisted shape. */
function canonicalise(usernames: readonly string[]): string[] {
  const out = new Set<string>();
  for (const u of usernames) {
    const c = canonicalUserRef(u);
    if (c !== null) out.add(c);
  }
  return [...out].sort();
}
