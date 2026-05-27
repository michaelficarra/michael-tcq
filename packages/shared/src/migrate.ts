/**
 * Lazy on-read migration from the pre-multi-provider data shape to the
 * provider-prefixed one.
 *
 * Before multi-provider support, every account was a GitHub account: a
 * `User` was `{ ghid, ghUsername, name, organisation, isPremium? }` and a
 * `UserKey` was the bare lowercased `ghUsername`. The new shape is
 * `{ provider, accountId, handle?, name, organisation, avatarUrl, isPremium? }`
 * with keys `${provider}:${accountId}` (see `types.ts` / `helpers.ts`).
 *
 * There is no batch migration. Persisted documents (meetings, logs,
 * app-settings, sessions) are upgraded the first time they are read, and
 * written back where that is cheap (meetings, app-settings) — see the call
 * sites in `packages/server`.
 *
 * ## Shape detection, not a version marker
 *
 * Legacy detection is structural rather than a stored version field:
 *   - a legacy `User` has no `provider` property (`isLegacyUser`);
 *   - a legacy `UserKey` contains no colon (`isLegacyKey`).
 *
 * The colon test is sound because a legacy key is a bare GitHub login, and
 * GitHub logins are alphanumerics-and-hyphens only (never a colon — see
 * the `strictGithubUsername` regex in `messages.ts`). Legacy is therefore
 * *always* GitHub. New documents are always written in the new shape, so
 * the colon test is only ever applied to decide "is this legacy?" — it is
 * never used to parse an already-migrated key (whose opaque accountId
 * could, for a future provider, contain a colon).
 */

import type { AppSettings } from './appSettings.js';
import type { AgendaItem, LogEntry, MeetingState, Reaction, TopicSpeaker, User, UserKey } from './types.js';
import { isAgendaItem } from './helpers.js';

/** The pre-multi-provider `User` shape. GitHub-only by construction. */
export interface LegacyUser {
  ghid: number;
  ghUsername: string;
  name: string;
  organisation: string;
  isPremium?: boolean;
}

/** True when `u` is a pre-migration (GitHub-only) user record. */
export function isLegacyUser(u: User | LegacyUser): u is LegacyUser {
  return !('provider' in u);
}

/** True when `k` is a pre-migration (bare, unprefixed GitHub login) key. */
export function isLegacyKey(k: string): boolean {
  return !k.includes(':');
}

/**
 * Synthesise the GitHub avatar URL for a login. Kept in lockstep with
 * `GitHubProvider.avatarUrl` (server) and the directory's
 * `avatarUrlForLogin`: `github.com/{login}.png` is a public redirect that
 * works for any valid login, including the hashed-ghid mock-auth users a
 * numeric `avatars.githubusercontent.com/u/{id}` URL would 404 on.
 */
function githubAvatarUrl(login: string): string {
  return `https://github.com/${encodeURIComponent(login)}.png?size=80`;
}

/**
 * Upgrade a single user record to the provider-neutral shape. Idempotent:
 * an already-migrated `User` is returned unchanged. Legacy records become
 * GitHub users whose `accountId` and `handle` are the lowercased login —
 * the same value the old key was built from, which is what makes the key
 * migration a pure prefix.
 */
export function upgradeUser(u: User | LegacyUser): User {
  if (!isLegacyUser(u)) return u;
  // accountId is the lowercased login (matching the old key); handle keeps
  // the original casing for display. A `ghid: 0` record is an unresolved
  // free-text presenter placeholder — preserve its empty-avatar marker so
  // the directory keeps skipping it (a resolved user always has an avatar).
  const accountId = u.ghUsername.toLowerCase();
  const placeholder = u.ghid === 0;
  return {
    provider: 'github',
    accountId,
    handle: u.ghUsername,
    name: u.name,
    organisation: u.organisation,
    avatarUrl: placeholder ? '' : githubAvatarUrl(accountId),
    ...(u.isPremium ? { isPremium: true } : {}),
  };
}

/** Prefix a bare legacy key with the `github:` provider; pass through already-migrated keys. */
export function migrateKey(key: string): UserKey {
  return (isLegacyKey(key) ? `github:${key}` : key) as UserKey;
}

function migrateKeys(keys: readonly string[]): UserKey[] {
  return keys.map(migrateKey);
}

/**
 * True when a meeting is still in the pre-migration shape. Sampling one
 * key is sufficient because a meeting is either wholly legacy or wholly
 * migrated. Chairs are always present at creation; fall back to the users
 * map, then to "nothing to migrate".
 */
export function isLegacyMeeting(m: MeetingState): boolean {
  if (m.chairIds.length > 0) return isLegacyKey(m.chairIds[0]);
  const firstUser = Object.values(m.users)[0];
  if (firstUser) return isLegacyUser(firstUser);
  return false;
}

/**
 * Deep-upgrade a meeting: re-key the `users` map (and upgrade each value)
 * plus every `UserKey`-typed cross-reference. Idempotent. Callers should
 * gate on `isLegacyMeeting` so an already-migrated meeting isn't needlessly
 * re-persisted.
 */
export function upgradeMeeting(m: MeetingState): MeetingState {
  const users: Record<UserKey, User> = {};
  for (const [key, user] of Object.entries(m.users)) {
    users[migrateKey(key)] = upgradeUser(user);
  }

  const agenda = m.agenda.map((entry) =>
    isAgendaItem(entry) ? ({ ...entry, presenterIds: migrateKeys(entry.presenterIds) } satisfies AgendaItem) : entry,
  );

  const entries: Record<string, MeetingState['queue']['entries'][string]> = {};
  for (const [id, entry] of Object.entries(m.queue.entries)) {
    entries[id] = { ...entry, userId: migrateKey(entry.userId) };
  }

  const current: MeetingState['current'] = {
    ...m.current,
    ...(m.current.speaker ? { speaker: { ...m.current.speaker, userId: migrateKey(m.current.speaker.userId) } } : {}),
    ...(m.current.topic ? { topic: { ...m.current.topic, userId: migrateKey(m.current.topic.userId) } } : {}),
    topicSpeakers: m.current.topicSpeakers.map(migrateTopicSpeaker),
  };

  const poll: MeetingState['poll'] = m.poll
    ? {
        ...m.poll,
        startChairId: migrateKey(m.poll.startChairId),
        reactions: m.poll.reactions.map((r): Reaction => ({ ...r, userId: migrateKey(r.userId) })),
      }
    : undefined;

  return {
    ...m,
    participantIds: migrateKeys(m.participantIds),
    users,
    chairIds: migrateKeys(m.chairIds),
    agenda,
    queue: { ...m.queue, entries },
    current,
    poll,
    operational: {
      ...m.operational,
      ...(m.operational.lastAdvancementBy ? { lastAdvancementBy: migrateKey(m.operational.lastAdvancementBy) } : {}),
    },
  };
}

function migrateTopicSpeaker(s: TopicSpeaker): TopicSpeaker {
  return { ...s, userId: migrateKey(s.userId) };
}

/**
 * Upgrade log entries in place (by value). Idempotent. Re-keys every
 * `UserKey`-typed field; deliberately leaves `AgendaItemFinishedLog.
 * remainingQueue` untouched — its `(username)` is pre-rendered display
 * text (a handle), not a key.
 */
export function upgradeLog(entries: LogEntry[]): LogEntry[] {
  return entries.map((entry): LogEntry => {
    switch (entry.type) {
      case 'meeting-started':
        return { ...entry, chairId: migrateKey(entry.chairId) };
      case 'agenda-item-started':
        return { ...entry, chairId: migrateKey(entry.chairId), itemPresenterIds: migrateKeys(entry.itemPresenterIds) };
      case 'agenda-item-finished':
        return { ...entry, chairId: migrateKey(entry.chairId), participantIds: migrateKeys(entry.participantIds) };
      case 'topic-discussed':
        return { ...entry, chairId: migrateKey(entry.chairId), speakers: entry.speakers.map(migrateTopicSpeaker) };
      case 'poll-ran':
        return { ...entry, startChairId: migrateKey(entry.startChairId), endChairId: migrateKey(entry.endChairId) };
    }
  });
}

/** True when any premium entry is still a bare (unprefixed) GitHub username. */
export function isLegacyAppSettings(s: AppSettings): boolean {
  return s.premiumUsernames.some(isLegacyKey);
}

/**
 * Expand bare legacy premium usernames to `github:` keys. Idempotent;
 * already-prefixed entries pass through.
 */
export function upgradeAppSettings(s: AppSettings): AppSettings {
  return { ...s, premiumUsernames: s.premiumUsernames.map((u) => migrateKey(u) as string) };
}
