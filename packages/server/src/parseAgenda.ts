/**
 * Parse a TC39-style markdown agenda into structured agenda items.
 *
 * Structural scanning is done over an mdast tree (`unified` +
 * `remark-parse` + `remark-gfm`) — the parser handles tables, ordered
 * lists, table-cell HTML, link URLs that contain `()`, etc., none of
 * which a line-based regex pass could do reliably. Once each item's
 * "name + parenthetical metadata" string is in hand, the existing
 * text-level helpers (`extractPresenterMeta`, `parseParenthetical`,
 * `PRESENTER_SEPARATOR`, ...) extract the presenter list and duration.
 */

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkStringify from 'remark-stringify';
import { toString as mdastToString } from 'mdast-util-to-string';
import type { Root, RootContent, Table, List, PhrasingContent, Paragraph } from 'mdast';
import { extractPlainText, stripUnsupportedMarkdown } from '@tcq/shared';

export interface ParsedAgendaItem {
  name: string;
  /** Ordered list of presenter names extracted from the source. May be empty — the caller substitutes a default. */
  presenters: string[];
  /** Estimated duration in minutes, parsed from the source. */
  duration?: number;
}

// -- Local parser / stringifier ------------------------------------------

const documentParser = unified().use(remarkParse).use(remarkGfm);
// GFM-on stringifier so `delete`/table/autolink nodes parsed out of the
// source can be round-tripped back to markdown.
const inlineStringifier = unified().use(remarkGfm).use(remarkStringify, {
  bullet: '-',
  emphasis: '*',
  strong: '*',
  fence: '`',
  fences: true,
});

/**
 * Re-serialise a phrasing-content array (e.g. a table cell's inline
 * children) back to markdown source. Used as the input to the
 * parenthetical extractor and to `stripUnsupportedMarkdown`.
 */
function serializeInline(children: ReadonlyArray<PhrasingContent>): string {
  if (children.length === 0) return '';
  const fakeRoot: Root = { type: 'root', children: [{ type: 'paragraph', children: [...children] }] };
  return inlineStringifier.stringify(fakeRoot).trim();
}

// -- TC39-specific item-name post-processing -----------------------------

/**
 * The agenda key emoji (❄️ hard constraint, 🔒 locked, ⌛️ late
 * addition, 🔁 returning) prefix item names in TC39 agendas. They're
 * presentational hints, not part of the topic, so we strip them before
 * storing the name.
 */
const AGENDA_KEY_EMOJI = /(?:❄️|🔒|⌛️|🔁)\s*/gu;

function cleanItemName(rawSource: string): string {
  return stripUnsupportedMarkdown(rawSource).replace(AGENDA_KEY_EMOJI, '').replace(/\s+/g, ' ').trim();
}

// -- Parenthetical extraction (text-level, unchanged) --------------------

/**
 * Parse a duration string into minutes. Accepts formats like:
 * "30m", "30", "90m"
 */
function parseDuration(text: string): number | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
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
 * `([slides](./x.pdf))` and slides/notes tokens as supplementary
 * metadata rather than presenter content.
 */
function isPureMarkdownLink(s: string): boolean {
  const t = s.trim();
  if (!t.startsWith('[') || !t.endsWith(')')) return false;
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
 * reporting the actual presenter parenthetical.
 */
function extractPresenterMeta(text: string): { name: string; paren: string } | null {
  let cur = text.trimEnd();
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
 * into a list of presenters and a duration.
 */
function parseParenthetical(paren: string): { presenters: string[]; duration?: number } {
  const parts = paren
    .split(PRESENTER_SEPARATOR)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !isPureMarkdownLink(s));

  const presenters: string[] = [];
  let duration: number | undefined;

  for (const raw of parts) {
    const cleaned = extractPlainText(raw);
    if (cleaned.length === 0) continue;
    const d = parseDuration(cleaned);
    if (d !== undefined) duration = d;
    else presenters.push(cleaned);
  }

  return { presenters, duration };
}

// -- Table column header recognition ------------------------------------

type ColumnKind = 'topic' | 'presenter' | 'duration' | 'stage';

/**
 * Map each header cell to a known column kind. Returns a column-index →
 * kind map; missing kinds mean the column is absent or unrecognised.
 */
function classifyTableHeader(headerRow: {
  children: ReadonlyArray<{ children: ReadonlyArray<PhrasingContent> }>;
}): Map<number, ColumnKind> {
  const out = new Map<number, ColumnKind>();
  headerRow.children.forEach((cell, i) => {
    const text = mdastToString(cell as never)
      .trim()
      .toLowerCase();
    if (text === 'topic' || text === 'proposal') out.set(i, 'topic');
    else if (text === 'presenter' || text === 'champion') out.set(i, 'presenter');
    // TC39 agendas label this column "timebox"; we store it under the
    // renamed internal key.
    else if (text === 'timebox') out.set(i, 'duration');
    else if (text === 'stage') out.set(i, 'stage');
  });
  return out;
}

// -- mdast walk ---------------------------------------------------------

/**
 * Recognise list items whose only purpose is to introduce a nested
 * table — the listItem's first paragraph is the table's section label,
 * the actual rows live inside the listItem. The label is not an agenda
 * item and must not be added to the output.
 */
function listItemContainsTable(item: { children: ReadonlyArray<RootContent> }): boolean {
  return item.children.some((c) => c.type === 'table');
}

/**
 * Process every `list` and `table` reachable from `nodes`, in source
 * order, emitting one `ParsedAgendaItem` per qualifying row / list item
 * to `out`. Doesn't recurse into unordered lists (those are sub-content,
 * not agenda items) or non-list/table containers.
 */
function processNodes(nodes: ReadonlyArray<RootContent>, out: ParsedAgendaItem[]): void {
  for (const node of nodes) {
    if (node.type === 'list') {
      processList(node, '', out);
    } else if (node.type === 'table') {
      processTable(node, out);
    }
    // Other top-level nodes (paragraphs, blockquotes, etc.) carry no
    // agenda content — skip them.
  }
}

/**
 * Walk an ordered list, emitting any item whose trailing parenthetical
 * conveys a time. `prefix` carries the chain of ancestor item names —
 * e.g. for `1. Foo / 1. Bar (5m)` the emitted name is `Foo: Bar`.
 */
function processList(list: List, prefix: string, out: ParsedAgendaItem[]): void {
  // Sub-content lives in unordered lists; skip them.
  if (!list.ordered) return;
  for (const item of list.children) {
    if (listItemContainsTable(item)) {
      // Section-label item — descend to process the nested table. Tables
      // are emitted verbatim (no prefix is threaded through) since the
      // colon-prepending rule applies only to nested ordered lists.
      processNodes(item.children, out);
      continue;
    }
    processListItem(item, prefix, out);
  }
}

function processListItem(
  item: { children: ReadonlyArray<RootContent> },
  prefix: string,
  out: ParsedAgendaItem[],
): void {
  const firstPara = item.children.find((c): c is Paragraph => c.type === 'paragraph');
  if (!firstPara) return;

  // Re-serialise to markdown source so the parenthetical extractor (which
  // is text-level) sees the same content shape it has been tested
  // against — markdown links preserved, etc.
  const source = serializeInline(firstPara.children);
  const cleanedSource = source.replace(AGENDA_KEY_EMOJI, '').trim();
  if (cleanedSource.length === 0) return;

  const presenterMeta = extractPresenterMeta(cleanedSource);
  // The "core name" is the topic without any trailing parenthetical, used
  // both for emission (qualified with the prefix) and as the prefix for
  // any nested children.
  const coreName = cleanItemName(presenterMeta ? presenterMeta.name : cleanedSource);

  // Emit only when the trailing parenthetical conveys a time. Other
  // parentheticals — bare presenters like "(Jordan Harband)" or
  // decorative remarks like "(in insertion order)" — are treated as
  // non-agenda metadata and the item is not added.
  if (presenterMeta && coreName.length > 0) {
    const { presenters, duration } = parseParenthetical(presenterMeta.paren);
    if (duration !== undefined) {
      const fullName = prefix.length > 0 ? `${prefix}: ${coreName}` : coreName;
      out.push({ name: fullName, presenters, duration });
    }
  }

  // Always recurse into a nested ordered list — children may carry their
  // own timed parentheticals (e.g. TC39 agendas' "Project Editors'
  // Reports" → "ECMA262 Status Updates (10m)"). Children are surfaced as
  // "Parent: Child", with deeper nesting accumulating "A: B: C".
  const nestedList = item.children.find((c): c is List => c.type === 'list' && c.ordered === true);
  if (nestedList) {
    let nextPrefix: string;
    if (coreName.length === 0) {
      nextPrefix = prefix;
    } else if (prefix.length > 0) {
      nextPrefix = `${prefix}: ${coreName}`;
    } else {
      nextPrefix = coreName;
    }
    processList(nestedList, nextPrefix, out);
  }
}

function processTable(table: Table, out: ParsedAgendaItem[]): void {
  if (table.children.length < 2) return; // header only, no data rows
  const [headerRow, ...dataRows] = table.children;
  const columns = classifyTableHeader(headerRow);

  // Inverse map: kind → cell-index. Multiple columns of the same kind
  // shouldn't occur; if they do the last one wins.
  const colIndex = new Map<ColumnKind, number>();
  for (const [i, kind] of columns) colIndex.set(kind, i);

  const topicCol = colIndex.get('topic');
  if (topicCol === undefined) return; // no name column → nothing to import

  for (const row of dataRows) {
    const cells = row.children;

    const topicSrc = serializeInline(cells[topicCol]?.children ?? []);
    const name = cleanItemName(topicSrc);
    if (!name) continue;

    let presenters: string[] = [];
    const presenterCol = colIndex.get('presenter');
    if (presenterCol !== undefined) {
      const presenterText = extractPlainText(serializeInline(cells[presenterCol]?.children ?? []));
      presenters = presenterText
        .split(PRESENTER_SEPARATOR)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }

    let duration: number | undefined;
    const durationCol = colIndex.get('duration');
    if (durationCol !== undefined) {
      const durText = extractPlainText(serializeInline(cells[durationCol]?.children ?? []));
      duration = parseDuration(durText);
    }

    out.push({ name, presenters, duration });
  }
}

// -- Public entry point -------------------------------------------------

/**
 * Parse a TC39-style markdown agenda document and return the extracted
 * agenda items. Looks for the `## Agenda items` heading, then walks the
 * lists and tables in that section.
 */
export function parseAgendaMarkdown(markdown: string): ParsedAgendaItem[] {
  const tree = documentParser.parse(markdown) as Root;
  const out: ParsedAgendaItem[] = [];

  // Find the heading that opens the agenda section.
  let start = -1;
  for (let i = 0; i < tree.children.length; i++) {
    const node = tree.children[i];
    if (node.type === 'heading' && node.depth === 2 && /^agenda items?$/i.test(mdastToString(node).trim())) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return out;

  // End at the next H2.
  let end = tree.children.length;
  for (let i = start; i < tree.children.length; i++) {
    const node = tree.children[i];
    if (node.type === 'heading' && node.depth === 2) {
      end = i;
      break;
    }
  }

  processNodes(tree.children.slice(start, end), out);
  return out;
}
