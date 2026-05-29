/**
 * Application-wide runtime-mutable settings, persisted as a single
 * document. Distinct from per-meeting state (`MeetingState`): these
 * values are global and managed at runtime by admins via the admin
 * panel.
 *
 * Wrapped in an interface (rather than represented as a bare
 * `string[]`) so additional settings can be added in the future
 * without a backwards-incompatible doc-shape change.
 */
export interface AppSettings {
  /**
   * Canonical (deduped, sorted) references to the users who belong to the
   * premium tier — each a bare GitHub handle or a provider-qualified
   * `provider:id` (see `canonicalUserRef`). Replaces the former
   * `PREMIUM_USERNAMES` environment variable; managed at runtime via the
   * admin panel. (Field name kept for store-shape back-compat.)
   */
  premiumUsernames: string[];
}

/**
 * Defaults applied when no settings document has been persisted yet
 * (fresh deploy, missing file, missing Firestore doc). Consumers
 * MUST deep-clone before mutating.
 */
export const DEFAULT_APP_SETTINGS: AppSettings = { premiumUsernames: [] };
