/**
 * Parse a TC39-style markdown agenda into structured agenda items.
 *
 * Handles both numbered list items (e.g. reports, opening) and markdown
 * tables (proposals, discussions). Strips markdown formatting (links,
 * bold, italic) to produce plain text names.
 */

export interface ParsedAgendaItem {
  name: string;
  /** Ordered list of presenter names extracted from the source. May be empty — the caller substitutes a default. */
  presenters: string[];
  timebox?: number; // minutes
}

/**
 * Strip markdown formatting from text, leaving only the readable content.
 *
 * - `[text](url)` → `text`
 * - `**bold**` / `__bold__` → `bold`
 * - `*italic*` / `_italic_` → `italic`
 * - HTML tags → removed
 * - Emoji shortcodes from the agenda key (❄️, 🔒, ⌛️, 🔁) → removed
 */
export function stripMarkdown(text: string): string {
  return (
    text
      // Remove markdown links: [text](url)
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      // Remove inline code
      .replace(/`([^`]*)`/g, '$1')
      // Remove bold: **text** or __text__
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/__(.+?)__/g, '$1')
      // Remove italic: *text* or _text_ (but not mid-word underscores)
      .replace(/(?<!\w)\*(.+?)\*(?!\w)/g, '$1')
      .replace(/(?<!\w)_(.+?)_(?!\w)/g, '$1')
      // Remove HTML tags
      .replace(/<[^>]+>/g, '')
      // Remove agenda key emoji prefixes
      .replace(/(?:❄️|🔒|⌛️|🔁)\s*/gu, '')
      // Collapse whitespace
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * Clean up text for use as an agenda item name. Preserves markdown
 * formatting (links, bold, italic, code, strikethrough) but removes
 * HTML tags and agenda key emoji prefixes.
 */
export function cleanName(text: string): string {
  return (
    text
      // Remove HTML tags
      .replace(/<[^>]+>/g, '')
      // Remove agenda key emoji prefixes
      .replace(/(?:❄️|🔒|⌛️|🔁)\s*/gu, '')
      // Collapse whitespace
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * Parse a timebox string into minutes. Accepts formats like:
 * "30m", "30", "90m", "1h", "1h30m"
 */
function parseTimebox(text: string): number | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  // Match "Xm" or bare number
  const minuteMatch = trimmed.match(/^(\d+)\s*m?$/i);
  if (minuteMatch) {
    const val = parseInt(minuteMatch[1], 10);
    return val > 0 ? val : undefined;
  }

  return undefined;
}

/**
 * Parse a parenthetical suffix like "(Chair, 10m)" or "(15m, Alice, Bob)"
 * into a list of presenters and a timebox. Each non-timebox comma-separated
 * token becomes its own presenter entry.
 */
function parseParenthetical(paren: string): { presenters: string[]; timebox?: number } {
  // Split on commas and classify each part
  const parts = paren
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const presenters: string[] = [];
  let timebox: number | undefined;

  for (const part of parts) {
    const tb = parseTimebox(part);
    if (tb !== undefined) {
      timebox = tb;
    } else {
      presenters.push(part);
    }
  }

  return { presenters, timebox };
}

/** Detect table header columns by matching known names. */
function parseTableHeader(headerRow: string): Map<string, number> {
  const cells = headerRow.split('|').map((c) => c.trim().toLowerCase());
  const columns = new Map<string, number>();

  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    if (cell === 'topic' || cell === 'proposal') columns.set('topic', i);
    else if (cell === 'presenter' || cell === 'champion') columns.set('presenter', i);
    else if (cell === 'timebox') columns.set('timebox', i);
    else if (cell === 'stage') columns.set('stage', i);
  }

  return columns;
}

/** Check if a line is a table separator row (e.g. |---|---|). */
function isSeparatorRow(line: string): boolean {
  return /^\|[\s:|-]+\|$/.test(line.trim());
}

/**
 * Parse a TC39-style markdown agenda document and return the extracted
 * agenda items. Looks for a "## Agenda" section, then parses both
 * numbered list items and markdown tables within it.
 */
export function parseAgendaMarkdown(markdown: string): ParsedAgendaItem[] {
  const lines = markdown.split('\n');
  const items: ParsedAgendaItem[] = [];

  // Find the start of the agenda items section
  let agendaStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+agenda\s+items?\b/i.test(lines[i].trim())) {
      agendaStart = i + 1;
      break;
    }
  }

  if (agendaStart === -1) return items;

  // Find the end: next ## heading or end of file
  let agendaEnd = lines.length;
  for (let i = agendaStart; i < lines.length; i++) {
    if (/^##\s/.test(lines[i].trim()) && i > agendaStart) {
      agendaEnd = i;
      break;
    }
  }

  const agendaLines = lines.slice(agendaStart, agendaEnd);

  // Track current table header columns
  let tableColumns: Map<string, number> | null = null;
  let inTable = false;

  /** Look ahead from index i to check if a table follows (after blank/indented lines). */
  function hasTableAhead(from: number): boolean {
    for (let j = from + 1; j < agendaLines.length; j++) {
      const t = agendaLines[j].trim();
      if (!t || t.startsWith('<!--')) continue;
      // If next non-blank content is a table header or indented table, it's a section label
      if (t.startsWith('|')) return true;
      // If it's a new top-level list item, stop looking
      if (/^\d+\.\s/.test(t) && !agendaLines[j].match(/^\s{2,}/)) return false;
      // Indented sub-items — keep looking
      if (agendaLines[j].match(/^\s{2,}/)) continue;
      return false;
    }
    return false;
  }

  for (let i = 0; i < agendaLines.length; i++) {
    const line = agendaLines[i];
    const trimmed = line.trim();

    // Skip empty lines, comments
    if (!trimmed || trimmed.startsWith('<!--')) continue;

    // Detect table header (may be indented)
    if (trimmed.startsWith('|') && !isSeparatorRow(trimmed)) {
      const nextLine = agendaLines[i + 1]?.trim() ?? '';
      if (isSeparatorRow(nextLine)) {
        // This is a header row
        tableColumns = parseTableHeader(trimmed);
        inTable = true;
        i++; // skip the separator row
        continue;
      }
    }

    // Parse table data rows
    if (inTable && trimmed.startsWith('|')) {
      if (isSeparatorRow(trimmed)) continue;

      const rawCells = trimmed.split('|');

      if (tableColumns) {
        const topicIdx = tableColumns.get('topic');
        const presenterIdx = tableColumns.get('presenter');
        const timeboxIdx = tableColumns.get('timebox');

        const name = topicIdx !== undefined ? cleanName(rawCells[topicIdx]) : '';
        // Presenter cell may list multiple comma-separated names. stripMarkdown
        // flattens link syntax first, so "[Alice](url), [Bob](url)" splits cleanly.
        const presenters =
          presenterIdx !== undefined
            ? stripMarkdown(rawCells[presenterIdx])
                .split(',')
                .map((s) => s.trim())
                .filter((s) => s.length > 0)
            : [];
        const rawTimebox = timeboxIdx !== undefined ? stripMarkdown(rawCells[timeboxIdx]) : '';
        const timebox = parseTimebox(rawTimebox);

        if (name) {
          items.push({ name, presenters, timebox });
        }
      }
      continue;
    }

    // End of table
    if (inTable && !trimmed.startsWith('|')) {
      inTable = false;
      tableColumns = null;
    }

    // Parse top-level numbered list items (1. Item text)
    // Skip indented sub-items (they start with spaces/tabs before the number)
    const listMatch = trimmed.match(/^\d+\.\s+(.+)$/);
    if (listMatch && !line.match(/^\s{2,}/)) {
      const plainText = stripMarkdown(listMatch[1]);

      // Skip purely structural items
      if (
        /^(find volunteers|adoption of the agenda|approval of the minutes|next meeting|overflow from|other business|adjournment)/i.test(
          plainText,
        )
      ) {
        continue;
      }

      // Skip section headings that are followed by a table
      if (hasTableAhead(i)) {
        continue;
      }

      // Use cleaned (markdown-preserving) text for the name
      const cleanedText = cleanName(listMatch[1]);

      // Try to extract parenthetical at end: "Name (presenter, Xm)"
      const parenMatch = cleanedText.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
      if (parenMatch) {
        const name = parenMatch[1].trim();
        const { presenters, timebox } = parseParenthetical(parenMatch[2]);
        items.push({ name, presenters, timebox });
      } else {
        // No parenthetical — use the whole text as the name
        items.push({ name: cleanedText, presenters: [], timebox: undefined });
      }
    }
  }

  return items;
}
