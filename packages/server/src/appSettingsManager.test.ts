import { describe, it, expect, beforeEach } from 'vitest';
import type { User } from '@tcq/shared';
import { AppSettingsManager } from './appSettingsManager.js';
import { InMemoryAppSettingsStore } from './test/inMemoryAppSettingsStore.js';

function user(ghUsername: string): User {
  return { ghid: 0, ghUsername, name: ghUsername, organisation: '' };
}

describe('AppSettingsManager', () => {
  let store: InMemoryAppSettingsStore;
  let manager: AppSettingsManager;

  beforeEach(async () => {
    store = new InMemoryAppSettingsStore();
    manager = new AppSettingsManager(store);
    await manager.restore();
  });

  describe('restore', () => {
    it('starts with an empty list when nothing is persisted', () => {
      expect(manager.getPremiumUsernames()).toEqual([]);
    });

    it('hydrates from the store on construction', async () => {
      await store.save({ premiumUsernames: ['alice', 'bob'] });
      const fresh = new AppSettingsManager(store);
      await fresh.restore();
      expect(fresh.getPremiumUsernames()).toEqual(['alice', 'bob']);
    });

    it('canonicalises whatever the store returns (trim, lowercase, dedupe, sort)', async () => {
      // Defensive: a hand-edited app-settings.json could contain values
      // in non-canonical shapes. The manager should clean them up on load.
      await store.save({ premiumUsernames: ['  Alice ', 'BOB', 'alice', 'charlie'] });
      const fresh = new AppSettingsManager(store);
      await fresh.restore();
      expect(fresh.getPremiumUsernames()).toEqual(['alice', 'bob', 'charlie']);
    });
  });

  describe('isPremium', () => {
    it('returns true for a user whose lowercased ghUsername is in the list', async () => {
      await manager.addPremiumUsername('Alice');
      expect(manager.isPremium(user('Alice'))).toBe(true);
      // Case-insensitive: the on-wire ghUsername might preserve case.
      expect(manager.isPremium(user('alice'))).toBe(true);
      expect(manager.isPremium(user('ALICE'))).toBe(true);
    });

    it('returns false for unknown users', () => {
      expect(manager.isPremium(user('bob'))).toBe(false);
    });
  });

  describe('addPremiumUsername', () => {
    it('returns the canonical form of a newly-added username', async () => {
      expect(await manager.addPremiumUsername('Alice')).toBe('alice');
      expect(manager.getPremiumUsernames()).toEqual(['alice']);
    });

    it('returns null when the username is already present (idempotent)', async () => {
      await manager.addPremiumUsername('alice');
      expect(await manager.addPremiumUsername('Alice')).toBeNull();
      expect(manager.getPremiumUsernames()).toEqual(['alice']);
    });

    it('returns null and persists nothing for an empty/whitespace input', async () => {
      expect(await manager.addPremiumUsername('   ')).toBeNull();
      expect(manager.getPremiumUsernames()).toEqual([]);
    });

    it('keeps the list sorted lexicographically', async () => {
      await manager.addPremiumUsername('charlie');
      await manager.addPremiumUsername('alice');
      await manager.addPremiumUsername('bob');
      expect(manager.getPremiumUsernames()).toEqual(['alice', 'bob', 'charlie']);
    });

    it('persists each mutation to the store', async () => {
      await manager.addPremiumUsername('alice');
      // Hydrate a parallel manager from the same store and confirm it
      // sees the change — proves the write actually went through, not
      // just the in-memory cache.
      const witness = new AppSettingsManager(store);
      await witness.restore();
      expect(witness.getPremiumUsernames()).toEqual(['alice']);
    });
  });

  describe('removePremiumUsername', () => {
    it('returns true and removes the username', async () => {
      await manager.addPremiumUsername('alice');
      expect(await manager.removePremiumUsername('alice')).toBe(true);
      expect(manager.getPremiumUsernames()).toEqual([]);
    });

    it('matches case-insensitively', async () => {
      await manager.addPremiumUsername('alice');
      expect(await manager.removePremiumUsername('ALICE')).toBe(true);
      expect(manager.getPremiumUsernames()).toEqual([]);
    });

    it('returns false when the username is not present (idempotent)', async () => {
      expect(await manager.removePremiumUsername('never-was-here')).toBe(false);
    });

    it('returns false for empty/whitespace input', async () => {
      expect(await manager.removePremiumUsername('   ')).toBe(false);
    });
  });

  describe('getPremiumUsernames', () => {
    it('returns a fresh copy on every call so callers cannot mutate the manager', async () => {
      await manager.addPremiumUsername('alice');
      const snap = manager.getPremiumUsernames();
      snap.push('mallory');
      expect(manager.getPremiumUsernames()).toEqual(['alice']);
    });
  });
});
