import { z } from 'zod';

/** Positive integer duration/capacity in minutes. */
const timeboxMinutes = z.number().int().positive();

const importTopicSchema = z
  .object({
    name: z.string().trim().min(1, 'Topic name is required'),
    presenter: z.string().trim().min(1).optional(),
    presenters: z.array(z.string().trim().min(1)).optional(),
    timebox: timeboxMinutes.optional(),
    duration: timeboxMinutes.optional(),
  })
  .strict();

const importSessionSchema = z
  .object({
    type: z.literal('session'),
    name: z.string().trim().min(1, 'Session name is required'),
    timebox: timeboxMinutes.optional(),
    duration: timeboxMinutes.optional(),
    topics: z.array(importTopicSchema).optional(),
  })
  .strict();

const importTopicEntrySchema = z
  .object({
    type: z.literal('topic'),
    name: z.string().trim().min(1, 'Topic name is required'),
    presenter: z.string().trim().min(1).optional(),
    presenters: z.array(z.string().trim().min(1)).optional(),
    timebox: timeboxMinutes.optional(),
    duration: timeboxMinutes.optional(),
  })
  .strict();

const importEntrySchema = z.discriminatedUnion('type', [importSessionSchema, importTopicEntrySchema]);

const importDocumentSchema = z.union([
  z.object({ entries: z.array(importEntrySchema).min(1, 'At least one entry is required') }).strict(),
  z.array(importEntrySchema).min(1, 'At least one entry is required'),
]);

export type ParsedAgendaImportEntry =
  | { kind: 'session'; name: string; capacity?: number }
  | { kind: 'item'; name: string; presenters: string[]; duration?: number };

export interface ParseAgendaImportResult {
  entries: ParsedAgendaImportEntry[];
}

function topicPresenters(topic: z.infer<typeof importTopicSchema>): string[] {
  const names: string[] = [];
  if (topic.presenter) names.push(topic.presenter);
  if (topic.presenters) names.push(...topic.presenters);
  return names;
}

function topicDuration(topic: z.infer<typeof importTopicSchema>): number | undefined {
  return topic.timebox ?? topic.duration;
}

function sessionCapacity(session: z.infer<typeof importSessionSchema>): number | undefined {
  return session.timebox ?? session.duration;
}

function flattenEntry(entry: z.infer<typeof importEntrySchema>): ParsedAgendaImportEntry[] {
  if (entry.type === 'topic') {
    return [
      {
        kind: 'item',
        name: entry.name,
        presenters: topicPresenters(entry),
        duration: topicDuration(entry),
      },
    ];
  }

  const result: ParsedAgendaImportEntry[] = [{ kind: 'session', name: entry.name, capacity: sessionCapacity(entry) }];
  for (const topic of entry.topics ?? []) {
    result.push({
      kind: 'item',
      name: topic.name,
      presenters: topicPresenters(topic),
      duration: topicDuration(topic),
    });
  }
  return result;
}

/**
 * Parse and validate an agenda import document. Accepts either a top-level
 * array of entries or an object with an `entries` array. Each entry is a
 * session (optionally containing nested topics) or a standalone topic.
 */
export function parseAgendaDocument(
  document: unknown,
): { ok: true; data: ParseAgendaImportResult } | { ok: false; error: string } {
  const parsed = importDocumentSchema.safeParse(document);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid agenda file' };
  }

  const rawEntries = Array.isArray(parsed.data) ? parsed.data : parsed.data.entries;
  const entries = rawEntries.flatMap(flattenEntry);
  if (entries.length === 0) {
    return { ok: false, error: 'No agenda entries found in the document' };
  }

  return { ok: true, data: { entries } };
}

/**
 * Load an agenda JSON document from source text. The file must contain either
 * a top-level entry array or an `{ entries }` object.
 */
export function loadAgendaJson(
  source: string,
): { ok: true; data: ParseAgendaImportResult } | { ok: false; error: string } {
  const trimmed = source.trim();
  if (!trimmed) {
    return { ok: false, error: 'File is empty' };
  }

  let document: unknown;
  try {
    document = JSON.parse(trimmed);
  } catch (err) {
    return { ok: false, error: `Invalid JSON: ${(err as Error).message}` };
  }

  return parseAgendaDocument(document);
}
