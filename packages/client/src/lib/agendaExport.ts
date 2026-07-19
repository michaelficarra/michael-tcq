import type { AgendaEntry, User, UserKey } from '@tcq/shared';
import { isSession } from '@tcq/shared';

/**
 * One entry in an exported agenda document. Mirrors the flat format the
 * server's file import accepts (see `packages/server/src/parseAgendaImport.ts`),
 * so an exported file round-trips back through "Import from File".
 */
export type AgendaExportEntry =
  | { type: 'session'; name: string; capacity?: number }
  | { type: 'topic'; name: string; presenters?: string[]; duration?: number };

/** Resolve a presenter key to the display name the export should record. */
function presenterName(users: Record<UserKey, User>, id: UserKey): string {
  const user = users[id];
  return user?.name?.trim() || user?.handle || '';
}

/**
 * Serialise a meeting's agenda into the flat import/export document format:
 * a top-level array of session and topic entries in agenda order. Optional
 * fields (`capacity`, `presenters`, `duration`) are omitted when empty so the
 * output stays minimal and re-imports cleanly.
 *
 * Presenter names come from `meeting.users`: free-text (placeholder) presenters
 * export verbatim via their `name`; resolved directory users export their
 * display name (the same value the import directory matched on).
 */
export function serializeAgenda(agenda: AgendaEntry[], users: Record<UserKey, User>): AgendaExportEntry[] {
  return agenda.map((entry): AgendaExportEntry => {
    if (isSession(entry)) {
      return { type: 'session', name: entry.name, ...(entry.capacity != null ? { capacity: entry.capacity } : {}) };
    }

    const presenters = entry.presenterIds.map((id) => presenterName(users, id)).filter((name) => name.length > 0);
    return {
      type: 'topic',
      name: entry.name,
      ...(presenters.length > 0 ? { presenters } : {}),
      ...(entry.duration != null ? { duration: entry.duration } : {}),
    };
  });
}
