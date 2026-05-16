import type { AppSettings } from '@tcq/shared';
import { DEFAULT_APP_SETTINGS } from '@tcq/shared';
import type { AppSettingsStore } from '../appSettingsStore.js';

/**
 * In-memory `AppSettingsStore` for unit tests. Deep-clones on
 * load/save so tests that mutate the returned object can't leak
 * state into the harness.
 */
export class InMemoryAppSettingsStore implements AppSettingsStore {
  private settings: AppSettings = structuredClone(DEFAULT_APP_SETTINGS);

  async load(): Promise<AppSettings> {
    return structuredClone(this.settings);
  }

  async save(settings: AppSettings): Promise<void> {
    this.settings = structuredClone(settings);
  }
}
