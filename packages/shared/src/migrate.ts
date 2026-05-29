/**
 * Lazy on-read migration from the pre-`AuthenticationProvider` data shape to
 * the provider-prefixed one.
 *
 * Before the provider abstraction, every account was a GitHub account: a
 * `User` was `{ ghid, ghUsername, name, organisation, isPremium? }` and a
 * `UserKey` was the bare lowercased `ghUsername`. The new shape is
 * `{ provider, accountId, handle?, name, organisation, avatarUrl, isPremium? }`
 * with keys `${provider}:${accountId}` (see `types.ts` / `helpers.ts`).
 * For GitHub, `accountId` is the **numeric GitHub user id** — which the
 * legacy data already carries as `ghid`, so the migration is lossless.
 *
 * There is no batch migration. Persisted documents (meetings, logs,
 * sessions) are upgraded the first time they are read, and written back
 * where that is cheap (meetings) — see the call sites in `packages/server`.
 * The premium list is not migrated: it stays a list of bare GitHub handles
 * (its pre-abstraction shape), matched against `user.handle` at runtime.
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
 * the colon test is only ever applied to decide "is this legacy?".
 *
 * ## Re-keying
 *
 * Because the new GitHub key is `github:<ghid>` (not derivable from the old
 * login key alone), re-keying a meeting's cross-references requires a
 * login→new-key map built from its `users` records (which carry `ghid`).
 * `buildKeyRemap` produces that map; `upgradeMeeting` uses it internally and
 * the caller passes it to `upgradeLog` for the separately-stored log.
 */

import type { LogEntry, MeetingState, Reaction, TopicSpeaker, User, UserKey } from './types.js';
import { isAgendaItem, placeholderUser, userKey, asUserKey } from './helpers.js';

/** The pre-abstraction `User` shape. GitHub-only by construction. */
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
 * Synthesise the GitHub avatar URL for a login. `github.com/{login}.png` is
 * a public redirect that works for any valid login, so it's used even though
 * the new accountId is the numeric id.
 */
function githubAvatarUrl(login: string): string {
  return `https://github.com/${encodeURIComponent(login)}.png?size=80`;
}

/**
 * Upgrade a single user record to the provider-neutral shape. Idempotent:
 * an already-migrated `User` is returned unchanged. A real legacy user
 * becomes a GitHub user keyed by its numeric `ghid`; a `ghid: 0` record —
 * the old unresolved-presenter placeholder — becomes a `placeholder` user.
 */
export function upgradeUser(u: User | LegacyUser): User {
  if (!isLegacyUser(u)) return u;
  if (u.ghid === 0) return placeholderUser(u.ghUsername);
  return {
    provider: 'github',
    accountId: String(u.ghid),
    handle: u.ghUsername,
    name: u.name,
    organisation: u.organisation,
    avatarUrl: githubAvatarUrl(u.ghUsername.toLowerCase()),
    ...(u.isPremium ? { isPremium: true } : {}),
  };
}

/**
 * Build the map from each old (login) key in a meeting's `users` to its new
 * `${provider}:${accountId}` key, derived from the record's own `ghid`.
 * Idempotent on already-migrated maps (an already-new key maps to itself).
 */
export function buildKeyRemap(users: Record<string, User | LegacyUser>): Map<string, UserKey> {
  const remap = new Map<string, UserKey>();
  for (const [oldKey, u] of Object.entries(users)) {
    remap.set(oldKey, userKey(upgradeUser(u)));
  }
  return remap;
}

/** Re-key one reference through the remap, leaving unknown keys untouched. */
function remapKey(remap: Map<string, UserKey>, key: string): UserKey {
  return remap.get(key) ?? asUserKey(key);
}

function remapKeys(remap: Map<string, UserKey>, keys: readonly string[]): UserKey[] {
  return keys.map((k) => remapKey(remap, k));
}

/**
 * True when a meeting is still in the pre-migration shape. Sampling one key
 * is sufficient because a meeting is either wholly legacy or wholly migrated.
 */
export function isLegacyMeeting(m: MeetingState): boolean {
  if (m.chairIds.length > 0) return isLegacyKey(m.chairIds[0]);
  const firstUser = Object.values(m.users)[0];
  if (firstUser) return isLegacyUser(firstUser);
  return false;
}

/**
 * Deep-upgrade a meeting: re-key the `users` map (and upgrade each value)
 * plus every `UserKey`-typed cross-reference, via a login→new-key remap
 * built from the meeting's own user records. Idempotent.
 */
export function upgradeMeeting(m: MeetingState): MeetingState {
  const remap = buildKeyRemap(m.users);

  const users: Record<UserKey, User> = {};
  for (const [key, user] of Object.entries(m.users)) {
    users[remapKey(remap, key)] = upgradeUser(user);
  }

  const agenda = m.agenda.map((entry) =>
    isAgendaItem(entry) ? { ...entry, presenterIds: remapKeys(remap, entry.presenterIds) } : entry,
  );

  const entries: Record<string, MeetingState['queue']['entries'][string]> = {};
  for (const [id, entry] of Object.entries(m.queue.entries)) {
    entries[id] = { ...entry, userId: remapKey(remap, entry.userId) };
  }

  const current: MeetingState['current'] = {
    ...m.current,
    ...(m.current.speaker
      ? { speaker: { ...m.current.speaker, userId: remapKey(remap, m.current.speaker.userId) } }
      : {}),
    ...(m.current.topic ? { topic: { ...m.current.topic, userId: remapKey(remap, m.current.topic.userId) } } : {}),
    topicSpeakers: m.current.topicSpeakers.map((s) => remapTopicSpeaker(remap, s)),
  };

  const poll: MeetingState['poll'] = m.poll
    ? {
        ...m.poll,
        startChairId: remapKey(remap, m.poll.startChairId),
        reactions: m.poll.reactions.map((r): Reaction => ({ ...r, userId: remapKey(remap, r.userId) })),
      }
    : undefined;

  return {
    ...m,
    participantIds: remapKeys(remap, m.participantIds),
    users,
    chairIds: remapKeys(remap, m.chairIds),
    agenda,
    queue: { ...m.queue, entries },
    current,
    poll,
    operational: {
      ...m.operational,
      ...(m.operational.lastAdvancementBy
        ? { lastAdvancementBy: remapKey(remap, m.operational.lastAdvancementBy) }
        : {}),
    },
  };
}

function remapTopicSpeaker(remap: Map<string, UserKey>, s: TopicSpeaker): TopicSpeaker {
  return { ...s, userId: remapKey(remap, s.userId) };
}

/**
 * Upgrade log entries in place (by value), re-keying every `UserKey`-typed
 * field through the same `remap` the meeting used (build it with
 * `buildKeyRemap(meeting.users)`). Idempotent. Deliberately leaves
 * `AgendaItemFinishedLog.remainingQueue` untouched — its `(username)` is
 * pre-rendered display text (a handle), not a key.
 */
export function upgradeLog(entries: LogEntry[], remap: Map<string, UserKey>): LogEntry[] {
  return entries.map((entry): LogEntry => {
    switch (entry.type) {
      case 'meeting-started':
        return { ...entry, chairId: remapKey(remap, entry.chairId) };
      case 'agenda-item-started':
        return {
          ...entry,
          chairId: remapKey(remap, entry.chairId),
          itemPresenterIds: remapKeys(remap, entry.itemPresenterIds),
        };
      case 'agenda-item-finished':
        return {
          ...entry,
          chairId: remapKey(remap, entry.chairId),
          participantIds: remapKeys(remap, entry.participantIds),
        };
      case 'topic-discussed':
        return {
          ...entry,
          chairId: remapKey(remap, entry.chairId),
          speakers: entry.speakers.map((s) => remapTopicSpeaker(remap, s)),
        };
      case 'poll-ran':
        return {
          ...entry,
          startChairId: remapKey(remap, entry.startChairId),
          endChairId: remapKey(remap, entry.endChairId),
        };
    }
  });
}
