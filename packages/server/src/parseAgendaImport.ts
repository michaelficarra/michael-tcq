import { z } from 'zod';

/** Positive integer duration/capacity in minutes. */
const durationMinutes = z.number().int().positive();

// The import document mirrors the flat agenda data model: a top-level array of
// entries, each discriminated by `type` as either a session header or a topic.
// There is no nesting and no field aliasing — sessions carry a required
// `capacity`, topics carry `presenters` and an optional `duration`. `.strict()`
// rejects unknown fields.

const importSessionSchema = z
  .object({
    type: z.literal('session'),
    name: z.string().trim().min(1, 'Session name is required'),
    capacity: durationMinutes,
  })
  .strict();

const importTopicSchema = z
  .object({
    type: z.literal('topic'),
    name: z.string().trim().min(1, 'Topic name is required'),
    presenters: z.array(z.string().trim().min(1)).optional(),
    duration: durationMinutes.optional(),
  })
  .strict();

const importEntrySchema = z.discriminatedUnion('type', [importSessionSchema, importTopicSchema]);

const importDocumentSchema = z.array(importEntrySchema).min(1, 'At least one entry is required');

export type ParsedAgendaImportEntry =
  | { kind: 'session'; name: string; capacity: number }
  | { kind: 'item'; name: string; presenters: string[]; duration?: number };

export interface ParseAgendaImportResult {
  entries: ParsedAgendaImportEntry[];
}

/** Map one validated document entry to its internal agenda representation. */
function mapEntry(entry: z.infer<typeof importEntrySchema>): ParsedAgendaImportEntry {
  if (entry.type === 'session') {
    return { kind: 'session', name: entry.name, capacity: entry.capacity };
  }

  return {
    kind: 'item',
    name: entry.name,
    presenters: entry.presenters ?? [],
    ...(entry.duration !== undefined ? { duration: entry.duration } : {}),
  };
}

/**
 * Parse and validate an agenda import document: a top-level array of entries,
 * each a session (`type: "session"`) or a topic (`type: "topic"`). The array is
 * flat — sessions and topics appear at the same level, matching the flat agenda
 * data model.
 */
export function parseAgendaDocument(
  document: unknown,
): { ok: true; data: ParseAgendaImportResult } | { ok: false; error: string } {
  const parsed = importDocumentSchema.safeParse(document);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid agenda file' };
  }

  const entries = parsed.data.map(mapEntry);
  if (entries.length === 0) {
    return { ok: false, error: 'No agenda entries found in the document' };
  }

  return { ok: true, data: { entries } };
}

/**
 * Load an agenda JSON document from source text. The file must contain a
 * top-level array of session/topic entries.
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
