/**
 * Persistence for the singleton `AppSettings` document.
 *
 * Distinct from `MeetingStore` because:
 * - There is exactly one settings document (not a collection), so the
 *   load/save/loadAll/remove vocabulary of `MeetingStore` doesn't fit.
 * - The lifecycle and broadcast semantics differ — `MeetingStore` is
 *   driven by `MeetingManager`'s dirty/sync machinery, whereas settings
 *   are persisted eagerly on every mutation.
 *
 * Two implementations mirror the meeting store split: `File…` for local
 * development (single JSON file alongside the meetings directory), and
 * `Firestore…` for production (single document `app-settings/singleton`).
 */

import { Firestore } from '@google-cloud/firestore';
import { randomBytes } from 'node:crypto';
import { readFile, rename, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DEFAULT_APP_SETTINGS, type AppSettings } from '@tcq/shared';

export interface AppSettingsStore {
  /**
   * Load the persisted settings. Implementations MUST return a deep
   * clone of `DEFAULT_APP_SETTINGS` (never the constant itself) on
   * first-ever read so callers can safely mutate the result.
   */
  load(): Promise<AppSettings>;

  /** Persist the settings document, atomically when feasible. */
  save(settings: AppSettings): Promise<void>;
}

function cloneDefaults(): AppSettings {
  return structuredClone(DEFAULT_APP_SETTINGS);
}

/**
 * Filesystem-backed app-settings store. Writes go to a temporary
 * sibling file and then `rename` into place — `rename` is atomic on
 * a single filesystem, so a concurrent reader either sees the prior
 * complete document or the new one, never a torn write. Only one
 * document on disk, so we don't bother with batching.
 */
export class FileAppSettingsStore implements AppSettingsStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<AppSettings> {
    try {
      const data = await readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(data) as Partial<AppSettings>;
      return normalise(parsed);
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        return cloneDefaults();
      }
      throw err;
    }
  }

  async save(settings: AppSettings): Promise<void> {
    // Ensure the parent directory exists — on a fresh deploy with a
    // never-used dataDir, the meetings/ subdir's parent may not have
    // been created yet by the file meeting store's init().
    await mkdir(dirname(this.filePath), { recursive: true });
    // Per-write random suffix on the tmp filename so concurrent saves
    // (e.g. parallel e2e workers sharing the same dataDir, or two
    // requests racing) don't clobber each other's tmp file between
    // writeFile and rename. Rename is itself atomic on a single
    // filesystem, so the last successful rename wins cleanly.
    const tmpPath = `${this.filePath}.${randomBytes(8).toString('hex')}.tmp`;
    await writeFile(tmpPath, JSON.stringify(settings, null, 2), 'utf-8');
    await rename(tmpPath, this.filePath);
  }
}

/** Firestore collection holding the singleton settings document. */
const APP_SETTINGS_COLLECTION = 'app-settings';
/** Singleton document id within the collection. */
const APP_SETTINGS_DOC_ID = 'singleton';

/**
 * Firestore-backed app-settings store. A single document at
 * `app-settings/singleton`. The Firestore client is shared via the
 * constructor option bag — the caller wires the same options used for
 * `FirestoreMeetingStore`, including the optional `databaseId`.
 */
export class FirestoreAppSettingsStore implements AppSettingsStore {
  private readonly db: Firestore;

  constructor(options?: ConstructorParameters<typeof Firestore>[0]) {
    // Match FirestoreMeetingStore: tolerate undefined optional fields
    // on write, and let the caller override credentials/database-id.
    this.db = new Firestore({ ignoreUndefinedProperties: true, ...options });
  }

  async load(): Promise<AppSettings> {
    const docRef = this.db.collection(APP_SETTINGS_COLLECTION).doc(APP_SETTINGS_DOC_ID);
    const doc = await docRef.get();
    if (!doc.exists) return cloneDefaults();
    return normalise((doc.data() ?? {}) as Partial<AppSettings>);
  }

  async save(settings: AppSettings): Promise<void> {
    const docRef = this.db.collection(APP_SETTINGS_COLLECTION).doc(APP_SETTINGS_DOC_ID);
    await docRef.set(settings);
  }
}

/**
 * Defensive normalisation applied to whatever shape comes back from
 * disk/Firestore — a missing field, a corrupted value, or a value of
 * the wrong type all collapse to the default. Keeps the manager free
 * of `?? []` defaults at every read site.
 */
function normalise(raw: Partial<AppSettings>): AppSettings {
  const usernames = Array.isArray(raw.premiumUsernames)
    ? raw.premiumUsernames.filter((u): u is string => typeof u === 'string' && u.length > 0)
    : [];
  return { premiumUsernames: usernames };
}
