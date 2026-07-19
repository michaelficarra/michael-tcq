import type { DirectorySuggestion, MeetingState, User } from '@tcq/shared';
import { placeholderUser } from '@tcq/shared';
import { providerById } from './auth/registry.js';
import type { MeetingManager } from './meetings.js';
import type { ParsedAgendaImportEntry } from './parseAgendaImport.js';
import type { SessionUser } from './session.js';

/**
 * Turn resolved directory hits into `User` objects for agenda items. Names
 * missing from `resolvedPresenters` (0 or 2+ directory matches) become
 * placeholder users recording the free-text name.
 */
export function mapImportedPresenters(names: string[], resolvedPresenters: Map<string, DirectorySuggestion>): User[] {
  return names.map((name) => {
    const hit = resolvedPresenters.get(name.trim().toLowerCase());
    return hit ? hit.user : placeholderUser(name);
  });
}

/**
 * Resolve unique presenter names through the importer's provider directory,
 * dispatched via the same `providerById` path as the autocomplete handler
 * so import resolution matches what the dropdown would show for the same
 * searcher (enabled-agnostic, so the GitHub seed directory still answers in
 * mock-auth mode). A provider with no directory resolves nothing and every
 * presenter falls through to a placeholder at {@link mapImportedPresenters}
 * time.
 *
 * Make sure the importer's org directory is in cache before resolving.
 * `warmDirectory` is fire-and-forget at OAuth login, and the org-members
 * cache is in-process only — so a restarted instance, a login from this
 * morning paired with an import this afternoon (cache TTL elapsed), or
 * simply an import seconds after first login can all leave tier 2 empty
 * when resolution runs. Awaiting here guarantees tier 2 is populated and
 * matches what the autocomplete dropdown would see. The helper coalesces
 * concurrent refreshes and is a no-op in mock-auth mode (no access token),
 * so this is cheap when the cache is already warm.
 *
 * Resolution uses the local directory only (tier 1 + tier 2 — meeting users
 * and the importer's org members; global search is intentionally skipped).
 * When a name yields exactly one match, the imported item is bound to that
 * real user; otherwise (0 or 2+ matches) {@link mapImportedPresenters} keeps
 * free-text placeholder behaviour. Resolution is per-name, so presenters
 * within a single item can be a mix of resolved and placeholder entries.
 * Names appearing across multiple entries are resolved once.
 */
export async function resolveImportedPresenters(
  user: SessionUser,
  meeting: MeetingState,
  entries: ParsedAgendaImportEntry[],
): Promise<Map<string, DirectorySuggestion>> {
  const directory = providerById(user.provider)?.directory;
  await directory?.warmDirectory(user);

  const resolved = new Map<string, DirectorySuggestion>();
  const seenKeys = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== 'item') continue;
    for (const raw of entry.presenters) {
      const dedupKey = raw.trim().toLowerCase();
      if (dedupKey.length === 0 || seenKeys.has(dedupKey)) continue;
      seenKeys.add(dedupKey);
      const hit = directory?.resolvePresenterFromDirectory(user, raw, meeting) ?? null;
      if (hit) resolved.set(dedupKey, hit);
    }
  }
  return resolved;
}

/**
 * Append parsed import entries to a meeting's agenda. Sessions and topics
 * are added in document order — the import document is flat, so entries land
 * in exactly the order they appear.
 *
 * Items with no parsed presenters are created with an empty presenter list;
 * the chair can edit one in afterwards if desired.
 */
export function applyImportedAgendaEntries(
  meetingManager: MeetingManager,
  meetingId: string,
  entries: ParsedAgendaImportEntry[],
  resolvedPresenters: Map<string, DirectorySuggestion>,
): { sessions: number; items: number } {
  let sessions = 0;
  let items = 0;

  for (const entry of entries) {
    if (entry.kind === 'session') {
      meetingManager.addSession(meetingId, entry.name, entry.capacity);
      sessions += 1;
      continue;
    }

    const presenters = mapImportedPresenters(entry.presenters, resolvedPresenters);
    meetingManager.addAgendaItem(meetingId, entry.name, presenters, entry.duration);
    items += 1;
  }

  return { sessions, items };
}
