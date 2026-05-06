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
  /** Estimated duration in minutes, parsed from the source. */
  duration?: number;
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
 * Parse a duration string into minutes. Accepts formats like:
 * "30m", "30", "90m", "1h", "1h30m"
 */
function parseDuration(text: string): number | undefined {
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
 * Find the trailing balanced `(...)` group in `text`. Walks right-to-left
 * tracking paren depth so a parenthetical's content can itself contain
 * balanced `()` pairs — most often markdown link URLs like `[slides](./x.pdf)`
 * — without the boundary regex tripping on the inner `)`.
 *
 * Returns null when `text` doesn't end with `)` or no matching open paren
 * is found. The returned `name` keeps everything before the open paren
 * (trimmed); `paren` is the inner content, exclusive of the brackets.
 */
function extractTrailingParen(text: string): { name: string; paren: string } | null {
  const trimmed = text.trimEnd();
  if (!trimmed.endsWith(')')) return null;
  let depth = 0;
  for (let i = trimmed.length - 1; i >= 0; i--) {
    const c = trimmed[i];
    if (c === ')') depth++;
    else if (c === '(') {
      depth--;
      if (depth === 0) {
        return {
          name: trimmed.slice(0, i).trim(),
          paren: trimmed.slice(i + 1, trimmed.length - 1),
        };
      }
    }
  }
  return null;
}

/**
 * True iff the entire (trimmed) input is a single balanced markdown link
 * `[text](url)` with nothing else around it. Used to recognise trailing
 * `([slides](./x.pdf))` and slides/notes tokens as supplementary metadata
 * rather than presenter content.
 */
function isPureMarkdownLink(s: string): boolean {
  const t = s.trim();
  if (!t.startsWith('[') || !t.endsWith(')')) return false;
  // Find the matching closing `]` for the opening `[`, accounting for nesting.
  let bracketDepth = 0;
  let closeBracket = -1;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '[') bracketDepth++;
    else if (t[i] === ']') {
      bracketDepth--;
      if (bracketDepth === 0) {
        closeBracket = i;
        break;
      }
    }
  }
  if (closeBracket === -1 || t[closeBracket + 1] !== '(') return false;
  // Verify the `(...)` after the `]` covers the entire remainder of t.
  let parenDepth = 0;
  for (let i = closeBracket + 1; i < t.length; i++) {
    if (t[i] === '(') parenDepth++;
    else if (t[i] === ')') {
      parenDepth--;
      if (parenDepth === 0) return i === t.length - 1;
    }
  }
  return false;
}

/**
 * Like `extractTrailingParen`, but peels off any number of trailing
 * pure-markdown-link parentheticals (slides / notes metadata) before
 * reporting the actual presenter parenthetical. TC39 agendas frequently
 * tack a `([slides](./x.pdf))` group onto the end of an item — sometimes
 * after a separate `(presenter, duration)` group — and we want the
 * presenter info, not the slides link.
 */
function extractPresenterMeta(text: string): { name: string; paren: string } | null {
  let cur = text.trimEnd();
  // Bound the loop defensively; in practice TC39 items never nest more
  // than two trailing parentheticals.
  for (let peel = 0; peel < 5; peel++) {
    const m = extractTrailingParen(cur);
    if (!m || m.name.length === 0) return null;
    if (isPureMarkdownLink(m.paren)) {
      cur = m.name;
      continue;
    }
    return m;
  }
  return null;
}

/**
 * Separator pattern for presenter lists. Matches `,`, `&`, or a
 * whitespace-bounded `and` (case-insensitive). The whitespace bounds on
 * `and` keep names that happen to contain the substring — "Anderson",
 * "Sandstone", "Andrew" — from being split mid-word.
 */
const PRESENTER_SEPARATOR = /\s+and\s+|[,&]/i;

/**
 * Parse a parenthetical suffix like "(Chair, 10m)", "(15m, Alice & Bob)",
 * "(15m, Alice and Bob)", or "(15m, Samina Husain - [slides](./x.pdf))"
 * into a list of presenters and a duration. `,`, `&`, and whitespace-
 * bounded `and` are all accepted as separators (TC39 agendas use them
 * interchangeably, sometimes mixed). Each token has markdown stripped so
 * an inline `[Alice](url)` link doesn't leak into the stored name;
 * tokens that are *only* a markdown link are dropped (they're slides/
 * notes metadata, not presenters).
 */
function parseParenthetical(paren: string): { presenters: string[]; duration?: number } {
  const parts = paren
    .split(PRESENTER_SEPARATOR)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !isPureMarkdownLink(s));

  const presenters: string[] = [];
  let duration: number | undefined;

  for (const raw of parts) {
    const cleaned = stripMarkdown(raw);
    if (cleaned.length === 0) continue;
    const d = parseDuration(cleaned);
    if (d !== undefined) duration = d;
    else presenters.push(cleaned);
  }

  return { presenters, duration };
}

/** Detect table header columns by matching known names. */
function parseTableHeader(headerRow: string): Map<string, number> {
  const cells = headerRow.split('|').map((c) => c.trim().toLowerCase());
  const columns = new Map<string, number>();

  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    if (cell === 'topic' || cell === 'proposal') columns.set('topic', i);
    else if (cell === 'presenter' || cell === 'champion') columns.set('presenter', i);
    // TC39 agendas label this column "timebox"; we store it under the
    // renamed internal key.
    else if (cell === 'timebox') columns.set('duration', i);
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
        const durationIdx = tableColumns.get('duration');

        const name = topicIdx !== undefined ? cleanName(rawCells[topicIdx]) : '';
        // Presenter cell may list multiple names separated by `,`, `&`,
        // or a whitespace-bounded `and` (or a mix). stripMarkdown
        // flattens link syntax first, so "[Alice](url), [Bob](url) &
        // [Carol](url)" splits cleanly.
        const presenters =
          presenterIdx !== undefined
            ? stripMarkdown(rawCells[presenterIdx])
                .split(PRESENTER_SEPARATOR)
                .map((s) => s.trim())
                .filter((s) => s.length > 0)
            : [];
        const rawDuration = durationIdx !== undefined ? stripMarkdown(rawCells[durationIdx]) : '';
        const duration = parseDuration(rawDuration);

        if (name) {
          items.push({ name, presenters, duration });
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

      // Try to extract a trailing balanced "(...)" — works even when the
      // parenthetical contains its own `()` pairs (markdown link URLs).
      // Trailing slides/notes metadata parens are peeled off automatically.
      const parenMatch = extractPresenterMeta(cleanedText);
      if (parenMatch) {
        const { presenters, duration } = parseParenthetical(parenMatch.paren);
        items.push({ name: parenMatch.name, presenters, duration });
      } else {
        // No parenthetical — use the whole text as the name
        items.push({ name: cleanedText, presenters: [], duration: undefined });
      }
    }
  }

  return items;
}
