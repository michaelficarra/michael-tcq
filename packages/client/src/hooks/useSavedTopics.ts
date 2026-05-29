/**
 * Per-user saved topics — short, pre-written queue topics the user can
 * fire into the queue with a single click. Persisted to localStorage,
 * keyed by the canonical user key (`${provider}:${accountId}`) so each
 * authenticated identity has its own list.
 *
 * The list has a hard cap of 5 entries. On first read for a given user
 * (no key in storage), the hook seeds the list with a single default
 * entry, so a new user immediately has a usable option in the dropdown
 * without having to open the editor first.
 *
 * Internally backed by a module-scope store keyed by storage-key, with
 * a tiny pub-sub so `useSyncExternalStore` can drive React updates.
 * This avoids per-instance load effects and gives stable snapshots
 * across multiple consumers (the dropdown and the editor mounted
 * simultaneously see the same array reference).
 */

import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type { QueueEntryType, User } from '@tcq/shared';
import { QueueEntryTypeSchema, userKey } from '@tcq/shared';
import { useAuth } from '../contexts/AuthContext.js';

export interface SavedTopic {
  id: string;
  text: string;
  /**
   * Queue-entry priority this saved topic posts as. Defaults to 'topic'
   * (New Topic) for new and legacy-without-type entries. Used both as the
   * `queue:add` type and to gate the dropdown (e.g. a 'reply' is disabled
   * when there's no active topic).
   */
  type: QueueEntryType;
}

/** Maximum number of saved topics a user may save. */
export const SAVED_TOPICS_MAX = 5;

/** Default priority for a saved topic that has none stored (new or legacy). */
const DEFAULT_SAVED_TOPIC_TYPE: QueueEntryType = 'topic';

/** Default seed used the first time a user opens the dropdown. */
export const DEFAULT_SAVED_TOPICS: ReadonlyArray<Pick<SavedTopic, 'text'>> = [{ text: '👍 I support this. (EOM)' }];

const STORAGE_KEY_PREFIX = 'tcq:saved-topics:';

function storageKey(key: string | null): string | null {
  return key == null ? null : `${STORAGE_KEY_PREFIX}${key}`;
}

// One-time bridge from the pre-multi-provider storage key (which keyed on
// the numeric GitHub id) to the new provider-key form. The legacy numeric id
// is recoverable only from the still-present `tcq:auth:ghid` marker that the
// old AuthContext wrote, so the bridge is best-effort and applies only to
// GitHub users (the only kind that existed before migration). Tracks which
// new keys have been checked so it runs at most once each.
const AUTH_GHID_STORAGE_KEY = 'tcq:auth:ghid';
const bridgedKeys = new Set<string>();
function bridgeLegacySavedTopics(newStorageKey: string, user: User): void {
  if (user.provider !== 'github' || bridgedKeys.has(newStorageKey)) return;
  bridgedKeys.add(newStorageKey);
  try {
    // Don't clobber a list already stored under the new key.
    if (localStorage.getItem(newStorageKey) !== null) return;
    const legacyGhid = localStorage.getItem(AUTH_GHID_STORAGE_KEY);
    if (!legacyGhid) return;
    const legacyValue = localStorage.getItem(`${STORAGE_KEY_PREFIX}${legacyGhid}`);
    if (legacyValue !== null) localStorage.setItem(newStorageKey, legacyValue);
  } catch {
    // localStorage unavailable — nothing to bridge.
  }
}

/** Browser-side ID generator. crypto.randomUUID is widely supported in all
 *  target browsers; the fallback is a non-cryptographic random string used
 *  only if the API is unavailable (e.g. very old browsers or insecure
 *  contexts where randomUUID is unexposed). */
function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `st-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

function seedDefaults(): SavedTopic[] {
  return DEFAULT_SAVED_TOPICS.map((d) => ({ id: newId(), text: d.text, type: DEFAULT_SAVED_TOPIC_TYPE }));
}

/** Coerce a possibly-missing/invalid stored type to a valid QueueEntryType,
 *  defaulting to 'topic'. Keeps stale local data from corrupting the list. */
function coerceType(value: unknown): QueueEntryType {
  const parsed = QueueEntryTypeSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_SAVED_TOPIC_TYPE;
}

/** Read and parse the stored list. Returns null when nothing is stored,
 *  so callers can distinguish "never seeded" from "user emptied the list". */
function readFromStorage(key: string): SavedTopic[] | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Defensive filter: ignore anything that doesn't look like a SavedTopic,
    // then coerce a missing/invalid `type` to the default so a garbled or
    // legacy storage value doesn't crash the dropdown.
    return parsed
      .filter(
        (x): x is { id: string; text: string; type?: unknown } =>
          x != null && typeof x === 'object' && typeof x.id === 'string' && typeof x.text === 'string',
      )
      .map((x) => ({ id: x.id, text: x.text, type: coerceType(x.type) }))
      .slice(0, SAVED_TOPICS_MAX);
  } catch {
    return [];
  }
}

function writeToStorage(key: string, value: SavedTopic[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Silently fail if localStorage is unavailable. Same pattern used by
    // PreferencesContext.
  }
}

// Module-level cache: storage-key → list. Holding the array here keeps
// useSyncExternalStore's snapshot stable across renders until a mutation
// replaces the reference.
const cache = new Map<string, SavedTopic[]>();
const listeners = new Set<() => void>();
// Stable empty array so the "no user signed in" snapshot stays referentially
// equal across renders.
const EMPTY: SavedTopic[] = Object.freeze([]) as unknown as SavedTopic[];

function notify(): void {
  for (const listener of listeners) listener();
}

/** Return the cached list for a key, loading (and seeding if needed) on
 *  first access. Always returns the same array reference until a mutation
 *  replaces it. */
function getOrLoad(key: string): SavedTopic[] {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const stored = readFromStorage(key);
  if (stored === null) {
    const seeded = seedDefaults();
    writeToStorage(key, seeded);
    cache.set(key, seeded);
    return seeded;
  }
  cache.set(key, stored);
  return stored;
}

function setAndPersist(key: string, next: SavedTopic[]): void {
  cache.set(key, next);
  writeToStorage(key, next);
  notify();
}

/** Exposed for tests: drop all in-memory cache so the next read re-loads
 *  from localStorage. Not used in production code. */
export function __resetSavedTopicsCacheForTests(): void {
  cache.clear();
}

export interface UseSavedTopicsResult {
  /** The current list. Empty array when no user is signed in or the user
   *  has explicitly deleted every entry. */
  topics: SavedTopic[];
  /** Add a new entry at the end. No-op when already at the cap. Returns
   *  the new entry's id, or null if the cap was hit / no user signed in.
   *  `type` defaults to 'topic' (New Topic). */
  add: (text?: string, type?: QueueEntryType) => string | null;
  /** Update an entry's text. Trims and ignores empty values — empty edits
   *  do not persist, so the row reverts. */
  update: (id: string, text: string) => void;
  /** Set an entry's queue-entry priority (type). No-op for unknown ids. */
  setType: (id: string, type: QueueEntryType) => void;
  /** Remove an entry by id. */
  remove: (id: string) => void;
  /** Reorder by id pair (active dragged onto over). Compatible with
   *  @dnd-kit's `onDragEnd`. No-op when ids are equal or unknown. */
  reorder: (activeId: string, overId: string) => void;
  /** Hard cap so the UI can disable the Add button. */
  max: number;
}

const subscribe = (callback: () => void): (() => void) => {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
};

/**
 * Hook for reading and mutating the current user's saved topics.
 *
 * Returns an empty list when no user is signed in (the dropdown still
 * renders, but mutation is a no-op until a user is present).
 */
export function useSavedTopics(): UseSavedTopicsResult {
  const { user } = useAuth();
  const key = storageKey(user ? userKey(user) : null);
  // Migrate a pre-multi-provider list to the new key before the first read.
  if (key !== null && user) bridgeLegacySavedTopics(key, user);

  // Snapshot getter is recomputed when key changes (new user) so React
  // resubscribes with a getter pointing at the new cache slot.
  const getSnapshot = useCallback((): SavedTopic[] => {
    if (key == null) return EMPTY;
    return getOrLoad(key);
  }, [key]);

  const topics = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return useMemo<UseSavedTopicsResult>(
    () => ({
      topics,
      add(text: string = '', type: QueueEntryType = DEFAULT_SAVED_TOPIC_TYPE) {
        if (key == null) return null;
        const current = getOrLoad(key);
        if (current.length >= SAVED_TOPICS_MAX) return null;
        const entry: SavedTopic = { id: newId(), text, type };
        setAndPersist(key, [...current, entry]);
        return entry.id;
      },
      update(id, text) {
        if (key == null) return;
        const trimmed = text.trim();
        if (!trimmed) return;
        const current = getOrLoad(key);
        if (!current.some((r) => r.id === id)) return;
        setAndPersist(
          key,
          current.map((r) => (r.id === id ? { ...r, text: trimmed } : r)),
        );
      },
      setType(id, type) {
        if (key == null) return;
        const current = getOrLoad(key);
        if (!current.some((r) => r.id === id)) return;
        setAndPersist(
          key,
          current.map((r) => (r.id === id ? { ...r, type } : r)),
        );
      },
      remove(id) {
        if (key == null) return;
        const current = getOrLoad(key);
        if (!current.some((r) => r.id === id)) return;
        setAndPersist(
          key,
          current.filter((r) => r.id !== id),
        );
      },
      reorder(activeId, overId) {
        if (key == null) return;
        if (activeId === overId) return;
        const current = getOrLoad(key);
        const fromIndex = current.findIndex((r) => r.id === activeId);
        const toIndex = current.findIndex((r) => r.id === overId);
        if (fromIndex === -1 || toIndex === -1) return;
        const next = current.slice();
        const [moved] = next.splice(fromIndex, 1);
        next.splice(toIndex, 0, moved);
        setAndPersist(key, next);
      },
      max: SAVED_TOPICS_MAX,
    }),
    [topics, key],
  );
}
