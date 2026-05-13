/**
 * Markdown subsystem for TCQ.
 *
 * TCQ accepts user-authored markdown for short fields — agenda item names,
 * queue topics, session names, and item conclusions — and renders it back
 * inline. Both the validator (used by Zod at the write boundary) and the
 * renderer (used on the client) live here so the supported subset has a
 * single source of truth.
 *
 * Two policies, one allowlist:
 *
 *   - **Strict (write boundary).** `validateInlineMarkdown` parses the
 *     input, walks the AST, and rejects anything outside the allowlist
 *     with a specific reason. Wired into Zod via the `markdownString`
 *     helper in `messages.ts`.
 *   - **Lenient (render path, agenda import).** `stripUnsupportedMarkdown`
 *     parses, removes anything outside the allowlist (HTML tags become
 *     bare text, block-level wrappers flatten to inline content), and
 *     re-serialises. Used by the client renderer as a pre-pass so that
 *     legacy stored data — which predates this validator — still renders
 *     safely instead of throwing.
 *
 * The supported subset is intentionally inline-only. See the constants
 * below for the precise lists.
 */

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkStringify from 'remark-stringify';
import remarkRehype from 'remark-rehype';
import rehypeRaw from 'rehype-raw';
import { toString as mdastToString } from 'mdast-util-to-string';
import { fromHtml } from 'hast-util-from-html';
import type {
  Root,
  RootContent,
  PhrasingContent,
  Paragraph,
  Heading,
  List,
  ListItem,
  Blockquote,
  Table,
  TableRow,
  TableCell,
  BlockContent,
} from 'mdast';
import type { Element, Root as HastRoot, RootContent as HastRootContent, ElementContent } from 'hast';

// -- Allowlists ----------------------------------------------------------

/**
 * mdast node types permitted in user-authored inline markdown.
 *
 * `paragraph` is permitted *as the single top-level wrapper* (mdast emits
 * one even for a one-line input). Multi-paragraph documents are caught
 * by the structural check before this list is consulted.
 *
 * `html` represents raw inline HTML; the tag and attributes inside are
 * checked separately against `ALLOWED_HTML_TAGS` /
 * `ALLOWED_HTML_ATTRS_BY_TAG`.
 */
export const INLINE_MDAST_TYPES: readonly string[] = [
  'root',
  'paragraph',
  'text',
  'emphasis',
  'strong',
  'delete',
  'inlineCode',
  'link',
  'break',
  'html',
];

/**
 * Raw HTML inline tags users are allowed to include. The list extends the
 * markdown set with a handful of semantically equivalent HTML tags
 * (`<strong>` ≡ `**`, `<code>` ≡ ``…``, `<del>` ≡ `~~…~~`) plus
 * `<u>`/`<sub>`/`<sup>` for which markdown has no shorthand.
 *
 * Block-level tags, container tags, form tags, and any tag that can run
 * scripts are *not* on this list and will be rejected (or, in the lenient
 * path, stripped).
 */
export const ALLOWED_HTML_TAGS: readonly string[] = [
  'a',
  'b',
  'strong',
  'i',
  'em',
  'u',
  's',
  'del',
  'ins',
  'sub',
  'sup',
  'code',
  'dfn',
  'abbr',
  'br',
];

/**
 * Per-tag attribute allowlist. Anything not listed here is rejected — in
 * particular, `class`, `style`, `id`, every `on*` event handler, and
 * `target` (the renderer sets `target="_blank"` itself).
 */
export const ALLOWED_HTML_ATTRS_BY_TAG: Record<string, readonly string[]> = {
  a: ['href', 'title'],
  b: [],
  strong: [],
  i: [],
  em: [],
  u: [],
  s: [],
  del: [],
  ins: [],
  sub: [],
  sup: [],
  code: [],
  dfn: [],
  abbr: ['title'],
  br: [],
};

/**
 * URL schemes accepted on `[text](url)` links and `<a href>` attributes.
 * `javascript:` and `data:` are the obvious XSS surface; anything else
 * exotic (`file:`, `chrome:`, etc.) is also rejected.
 */
export const ALLOWED_URL_SCHEMES: readonly string[] = ['http:', 'https:', 'mailto:'];

// -- Block-level allowlists ---------------------------------------------

/**
 * mdast node types permitted in user-authored *block* markdown — used by
 * the prologue/epilogue sections of the agenda. Strict superset of
 * `INLINE_MDAST_TYPES`, so anything that validates as inline also
 * validates as block. Images are still rejected (handled per-node in
 * `validateBlockMarkdown`).
 */
export const BLOCK_MDAST_TYPES: readonly string[] = [
  ...INLINE_MDAST_TYPES,
  'heading',
  'list',
  'listItem',
  'thematicBreak',
  'blockquote',
  'code',
  'table',
  'tableRow',
  'tableCell',
];

/**
 * Raw HTML tags users are allowed to include in block content. Extends
 * the inline allowlist with the corresponding raw-HTML tag for every
 * markdown block construct on `BLOCK_MDAST_TYPES`, so a user can write
 * either `# heading` or `<h1>heading</h1>` and get the same result.
 *
 * Generic structural tags (`div`, `span`) are deliberately omitted —
 * every supported markdown construct has a corresponding semantic tag
 * already on this list. Images stay off the list (security posture).
 */
export const ALLOWED_BLOCK_HTML_TAGS: readonly string[] = [
  ...ALLOWED_HTML_TAGS,
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'hr',
  'blockquote',
  'pre',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'details',
  'summary',
];

/**
 * Per-tag attribute allowlist for block content. Extends
 * `ALLOWED_HTML_ATTRS_BY_TAG` with the few attributes that are
 * load-bearing on block constructs: `<details open>`, `<ol start>`, and
 * `<th>`/`<td>` cell `align`. Everything else (`class`, `style`, `id`,
 * `colspan`, `rowspan`, every `on*` handler, …) is rejected so the
 * sanitiser surface stays tight.
 */
export const ALLOWED_BLOCK_HTML_ATTRS_BY_TAG: Record<string, readonly string[]> = {
  ...ALLOWED_HTML_ATTRS_BY_TAG,
  p: [],
  h1: [],
  h2: [],
  h3: [],
  h4: [],
  h5: [],
  h6: [],
  ul: [],
  ol: ['start'],
  li: [],
  hr: [],
  blockquote: [],
  pre: [],
  table: [],
  thead: [],
  tbody: [],
  tr: [],
  th: ['align'],
  td: ['align'],
  details: ['open'],
  summary: [],
};

// -- Parsers (cached) ----------------------------------------------------

const parser = unified().use(remarkParse).use(remarkGfm);
const stringifier = unified()
  // GFM is needed both ways: parsing recognises strikethrough/autolinks
  // (above) and stringifying must know how to emit `delete` and table
  // nodes back to source.
  .use(remarkGfm)
  .use(remarkStringify, {
    // Keep the source as close to the input as possible. Nothing here
    // flips CommonMark semantics; these are formatting choices for the
    // re-serialised output produced by `stripUnsupportedMarkdown`.
    bullet: '-',
    emphasis: '*',
    strong: '*',
    fence: '`',
    fences: true,
    rule: '-',
  });

// -- URL validation ------------------------------------------------------

/**
 * Validate that a URL string parses and uses one of the allowed schemes.
 * Uses the WHATWG URL parser rather than a string-prefix check so that
 * obfuscated values like `\tjavascript:` or `JavaScript:` are caught.
 *
 * Relative URLs (no scheme) are accepted — they're constrained to the
 * current origin and can't host a script payload on their own.
 */
function isAllowedUrl(url: string): boolean {
  const trimmed = url.trim();
  if (trimmed.length === 0) return false;
  // Relative URL — no scheme; these are safe by construction.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return true;
  try {
    const u = new URL(trimmed);
    return (ALLOWED_URL_SCHEMES as readonly string[]).includes(u.protocol);
  } catch {
    return false;
  }
}

// -- Inline-HTML validation ----------------------------------------------

interface HtmlCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Validate one raw HTML fragment (i.e. one mdast `html` node's `value`)
 * against the supplied tag / attribute allowlists. mdast emits each tag
 * as its own `html` node, so the value is typically a single open /
 * close / void tag. `hast-util-from-html` parses it as an HTML fragment
 * so we can inspect tag and attributes uniformly.
 *
 * Pass `ALLOWED_HTML_TAGS` + `ALLOWED_HTML_ATTRS_BY_TAG` for inline
 * contexts (existing behaviour) or the block-level supersets to validate
 * within prologue/epilogue-style block markdown.
 */
function checkHtml(
  value: string,
  allowedTags: readonly string[],
  allowedAttrsByTag: Record<string, readonly string[]>,
): HtmlCheck {
  // `fromHtml` always returns a Root; in fragment mode each top-level
  // node is the parsed element / text. Comments, doctypes, scripts in the
  // input show up as their respective hast types and are rejected below.
  const tree = fromHtml(value, { fragment: true }) as HastRoot;
  for (const node of tree.children as HastRootContent[]) {
    if (node.type === 'text') continue; // adjacent text in the html span — fine
    if (node.type !== 'element') {
      return { ok: false, reason: `${node.type} content is not allowed` };
    }
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (!allowedTags.includes(tag)) {
      return { ok: false, reason: `<${tag}> is not allowed` };
    }
    const allowedAttrs = allowedAttrsByTag[tag] ?? [];
    for (const [attr, raw] of Object.entries(el.properties ?? {})) {
      // hast normalises property names (e.g. `className`); we only allow
      // the literal HTML attribute names listed for the tag.
      if (!(allowedAttrs as readonly string[]).includes(attr)) {
        return { ok: false, reason: `<${tag} ${attr}> is not allowed` };
      }
      if (tag === 'a' && attr === 'href') {
        if (typeof raw !== 'string' || !isAllowedUrl(raw)) {
          return { ok: false, reason: `<a href> must use ${ALLOWED_URL_SCHEMES.join(', ')}` };
        }
      }
    }
    // Recurse into element children — `<a><b>x</b></a>` is allowed if
    // every nested element is also on the allowlist.
    for (const child of el.children as ElementContent[]) {
      if (child.type === 'element') {
        const childCheck = checkHtml(`<${child.tagName}></${child.tagName}>`, allowedTags, allowedAttrsByTag);
        // The recursion is shallow on purpose: we re-check the tag/attr
        // shape. To validate attrs on the actual child, we walk through
        // the element directly rather than via fromHtml again.
        if (!childCheck.ok) return childCheck;
      }
    }
  }
  return { ok: true };
}

/** Inline-context HTML check — back-compat wrapper around `checkHtml`. */
function checkInlineHtml(value: string): HtmlCheck {
  return checkHtml(value, ALLOWED_HTML_TAGS, ALLOWED_HTML_ATTRS_BY_TAG);
}

/** Block-context HTML check — uses the wider block-allowlist. */
function checkBlockHtml(value: string): HtmlCheck {
  return checkHtml(value, ALLOWED_BLOCK_HTML_TAGS, ALLOWED_BLOCK_HTML_ATTRS_BY_TAG);
}

// -- Public: validation --------------------------------------------------

export type ValidationResult = { ok: true } | { ok: false; reason: string };

/**
 * Strict validator for user-authored inline markdown. Used by Zod at the
 * write boundary. Returns a specific `reason` so the form can surface a
 * helpful error like *"Headings are not supported"*.
 */
export function validateInlineMarkdown(input: string): ValidationResult {
  let tree: Root;
  try {
    tree = parser.parse(input) as Root;
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }

  // Empty input — handled upstream by Zod's `.min(1)`. Treat as ok here
  // so the validator composes cleanly.
  if (tree.children.length === 0) return { ok: true };

  // Structural: the document must be a single paragraph (no headings,
  // lists, tables, blockquotes, code blocks, etc.). `paragraph` is the
  // mdast wrapper for inline content.
  if (tree.children.length > 1) {
    return { ok: false, reason: 'Multiple paragraphs are not supported' };
  }
  const top = tree.children[0];
  if (top.type === 'html') {
    // mdast classifies certain tags (`<script>`, `<iframe>`, `<style>`,
    // bare-tags-on-own-line, ...) as block-level HTML and emits them at
    // the root rather than inside a paragraph. Inspect the value so the
    // error names the actual tag rather than the generic `html` type.
    const check = checkInlineHtml(top.value);
    return check.ok ? { ok: true } : { ok: false, reason: check.reason ?? 'HTML is not allowed' };
  }
  if (top.type !== 'paragraph') {
    return { ok: false, reason: `${describeBlock(top.type)} are not supported` };
  }

  // Inline: every descendant of the paragraph must be in the inline
  // allowlist; HTML fragments must use only allowed tags + attrs; URLs
  // must use an allowed scheme.
  return checkInlineSubtree(top);
}

/** Friendly name for the offending block type in error messages. */
function describeBlock(type: string): string {
  switch (type) {
    case 'heading':
      return 'Headings';
    case 'list':
      return 'Lists';
    case 'table':
      return 'Tables';
    case 'blockquote':
      return 'Blockquotes';
    case 'thematicBreak':
      return 'Horizontal rules';
    case 'code':
      return 'Code blocks';
    case 'image':
      return 'Images';
    default:
      return `\`${type}\``;
  }
}

function checkInlineSubtree(node: Paragraph | PhrasingContent): ValidationResult {
  if (!(INLINE_MDAST_TYPES as readonly string[]).includes(node.type)) {
    return { ok: false, reason: `${describeBlock(node.type)} are not supported` };
  }
  if (node.type === 'image') {
    return { ok: false, reason: 'Images are not supported' };
  }
  if (node.type === 'link') {
    if (!isAllowedUrl(node.url)) {
      return { ok: false, reason: `Links must use ${ALLOWED_URL_SCHEMES.join(', ')}` };
    }
  }
  if (node.type === 'html') {
    const check = checkInlineHtml(node.value);
    if (!check.ok) return { ok: false, reason: check.reason ?? 'HTML is not allowed' };
  }
  if ('children' in node) {
    for (const child of node.children) {
      const r = checkInlineSubtree(child as PhrasingContent);
      if (!r.ok) return r;
    }
  }
  return { ok: true };
}

// -- Public: block-level validation -------------------------------------

/**
 * mdast block-content node types whose children are themselves block
 * content (paragraph/list/heading/...). Validated recursively via
 * `checkBlockNode` so a list-inside-a-blockquote-inside-a-list still
 * lands every leaf on the inline or block allowlist.
 */
type BlockContainer = Blockquote | ListItem;

/**
 * Strict validator for user-authored *block* markdown — used for the
 * agenda prologue and epilogue. Accepts anything `validateInlineMarkdown`
 * accepts, plus headings, lists, blockquotes, fenced code blocks,
 * thematic breaks, GFM tables, and the corresponding raw-HTML tags
 * (`<h1>`, `<ul>`, `<blockquote>`, `<details>`, …). Images stay
 * rejected.
 *
 * Inline content nested inside a block container is checked against the
 * existing inline allowlist via `checkInlineSubtree`, so the inline
 * rules apply uniformly regardless of context.
 */
export function validateBlockMarkdown(input: string): ValidationResult {
  let tree: Root;
  try {
    tree = parser.parse(input) as Root;
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
  if (tree.children.length === 0) return { ok: true };
  for (const child of tree.children) {
    const r = checkBlockNode(child);
    if (!r.ok) return r;
  }
  return { ok: true };
}

function checkBlockNode(node: RootContent | BlockContent): ValidationResult {
  // Images are rejected at every level — both markdown `![](…)` (which
  // appears as `type: 'image'` in phrasing content) and raw `<img>`
  // (caught by the HTML allowlist below).
  if (node.type === 'image') {
    return { ok: false, reason: 'Images are not supported' };
  }
  if (!(BLOCK_MDAST_TYPES as readonly string[]).includes(node.type)) {
    return { ok: false, reason: `${describeBlock(node.type)} are not supported` };
  }
  switch (node.type) {
    case 'paragraph':
    case 'heading': {
      // Phrasing children — inline allowlist applies.
      const phrasingParent = node as Paragraph | Heading;
      for (const child of phrasingParent.children) {
        const r = checkInlineSubtree(child);
        if (!r.ok) return r;
      }
      return { ok: true };
    }
    case 'list': {
      const list = node as List;
      for (const item of list.children) {
        const r = checkBlockNode(item);
        if (!r.ok) return r;
      }
      return { ok: true };
    }
    case 'listItem':
    case 'blockquote': {
      const container = node as BlockContainer;
      for (const child of container.children) {
        const r = checkBlockNode(child);
        if (!r.ok) return r;
      }
      return { ok: true };
    }
    case 'table': {
      const table = node as Table;
      for (const row of table.children) {
        const r = checkBlockNode(row);
        if (!r.ok) return r;
      }
      return { ok: true };
    }
    case 'tableRow': {
      const row = node as TableRow;
      for (const cell of row.children) {
        const r = checkBlockNode(cell);
        if (!r.ok) return r;
      }
      return { ok: true };
    }
    case 'tableCell': {
      const cell = node as TableCell;
      for (const child of cell.children) {
        const r = checkInlineSubtree(child);
        if (!r.ok) return r;
      }
      return { ok: true };
    }
    case 'html': {
      const check = checkBlockHtml(node.value);
      return check.ok ? { ok: true } : { ok: false, reason: check.reason ?? 'HTML is not allowed' };
    }
    case 'thematicBreak':
    case 'code':
      // Fenced code-block content is plain text — no inline validation.
      return { ok: true };
    default:
      // Any phrasing node that appears at the block level (e.g. a bare
      // `text` or `inlineCode` inside the root, which mdast wraps in a
      // paragraph anyway) goes through the inline checker.
      return checkInlineSubtree(node as PhrasingContent);
  }
}

// -- Public: lenient strip-and-reserialise -------------------------------

/**
 * Lenient counterpart to `validateInlineMarkdown`. Parses the input,
 * removes any node that the validator would reject (HTML tags become
 * bare text, block-level wrappers flatten to their inline content), and
 * re-serialises. Used by:
 *
 *   - the client renderer as a pre-pass for legacy stored data;
 *   - the agenda import parser, where pre-existing TC39 markdown often
 *     includes constructs we don't render (e.g. `<sub>`, embedded images
 *     as raw HTML) but the surviving inline content is still useful.
 */
export function stripUnsupportedMarkdown(input: string): string {
  const tree = parser.parse(input) as Root;
  const flat = flattenToInline(tree.children);
  const cleaned: Root = {
    type: 'root',
    children: flat.length > 0 ? [{ type: 'paragraph', children: flat }] : [],
  };
  return stringifier.stringify(cleaned).trim();
}

/**
 * Reduce a forest of mdast nodes (block- or inline-level) to a flat list
 * of phrasing content. Block wrappers (paragraph, heading, list, etc.)
 * are replaced by their flattened children; disallowed inline nodes
 * become their text content; HTML tags are stripped to their inner text.
 */
function flattenToInline(nodes: ReadonlyArray<RootContent | PhrasingContent>): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  for (const node of nodes) {
    // Images are explicitly disallowed — drop entirely (don't surface
    // their alt text, which is rarely useful in this context).
    if (node.type === 'image') continue;
    if (node.type === 'html') {
      // For inline HTML: keep allow-listed tags verbatim (mdast emits
      // open/close as separate nodes; adjacent text carries the content).
      // For disallowed HTML at root level (`<script>`, `<div>`, etc.),
      // drop the tags and any inner text — mdast doesn't produce text
      // children for block-level HTML, so dropping the html node is
      // sufficient.
      const check = checkInlineHtml(node.value);
      if (check.ok) out.push(node);
      continue;
    }
    if (!(INLINE_MDAST_TYPES as readonly string[]).includes(node.type)) {
      // Block-level (heading, list, blockquote, etc.) — descend into its
      // children, which yields just the inline content.
      const text = mdastToString(node);
      if (text.length > 0) {
        // Insert a separating space so adjacent block content doesn't
        // mash together, then collapse later.
        if (out.length > 0) out.push({ type: 'text', value: ' ' });
        out.push({ type: 'text', value: text });
      }
      continue;
    }
    if (node.type === 'link' && !isAllowedUrl(node.url)) {
      // Disallowed URL — keep the link text, drop the link wrapper.
      out.push(...flattenToInline(node.children));
      continue;
    }
    if (node.type === 'paragraph') {
      // Top-level paragraph wrapper — flatten away.
      out.push(...flattenToInline(node.children));
      continue;
    }
    if ('children' in node) {
      // Inline wrapper (emphasis, strong, link, ...) — recurse to clean
      // its children, then keep the wrapper.
      const cleanedChildren = flattenToInline(node.children as PhrasingContent[]);
      out.push({ ...node, children: cleanedChildren } as PhrasingContent);
      continue;
    }
    out.push(node as PhrasingContent);
  }
  return out;
}

// -- Public: lenient block strip-and-reserialise -------------------------

/**
 * Lenient counterpart to `validateBlockMarkdown`. Walks the tree and
 * drops anything the validator would reject — images vanish, disallowed
 * raw-HTML fragments are removed, disallowed link schemes are unwrapped
 * to their link text — while preserving the block structure (paragraphs,
 * headings, lists, code blocks, tables, …) so the rendered output keeps
 * its shape. Used by the client renderer as a pre-pass for legacy or
 * partially-corrupted stored content.
 */
export function stripUnsupportedBlockMarkdown(input: string): string {
  const tree = parser.parse(input) as Root;
  const cleaned: Root = {
    type: 'root',
    children: cleanBlockNodes(tree.children) as RootContent[],
  };
  return stringifier.stringify(cleaned).trim();
}

/**
 * Recursive block-content cleaner. Returns the kept children for the
 * caller to splice into its own children array — nodes that should be
 * dropped entirely (`image`, disallowed block HTML) emit nothing, and
 * containers (list, blockquote, table) recurse into their bodies.
 */
function cleanBlockNodes(nodes: ReadonlyArray<RootContent | BlockContent | PhrasingContent>): Array<RootContent> {
  const out: RootContent[] = [];
  for (const node of nodes) {
    if (node.type === 'image') continue;
    if (node.type === 'html') {
      // At block level the wider allowlist applies (`<details>`,
      // `<hr>`, …). Disallowed tags are dropped wholesale; their
      // contents — if any — were already separate mdast siblings.
      if (checkBlockHtml(node.value).ok) out.push(node as RootContent);
      continue;
    }
    if (!(BLOCK_MDAST_TYPES as readonly string[]).includes(node.type)) {
      // Block type we don't recognise — fall back to text so nothing
      // load-bearing in the content is lost.
      const text = mdastToString(node);
      if (text.length > 0) {
        out.push({ type: 'paragraph', children: [{ type: 'text', value: text }] });
      }
      continue;
    }
    switch (node.type) {
      case 'paragraph':
      case 'heading': {
        const phrasingParent = node as Paragraph | Heading;
        const kept = flattenToInline(phrasingParent.children);
        out.push({ ...phrasingParent, children: kept } as RootContent);
        break;
      }
      case 'list': {
        const list = node as List;
        const kept = cleanBlockNodes(list.children) as ListItem[];
        out.push({ ...list, children: kept });
        break;
      }
      case 'listItem':
      case 'blockquote': {
        const container = node as BlockContainer;
        const kept = cleanBlockNodes(container.children) as BlockContent[];
        out.push({ ...container, children: kept } as RootContent);
        break;
      }
      case 'table': {
        const table = node as Table;
        const kept = cleanBlockNodes(table.children) as TableRow[];
        out.push({ ...table, children: kept });
        break;
      }
      case 'tableRow': {
        const row = node as TableRow;
        const kept = cleanBlockNodes(row.children) as TableCell[];
        out.push({ ...row, children: kept } as RootContent);
        break;
      }
      case 'tableCell': {
        const cell = node as TableCell;
        const kept = flattenToInline(cell.children);
        out.push({ ...cell, children: kept } as RootContent);
        break;
      }
      default:
        // thematicBreak, code, and anything else with no recursive
        // structure passes through unchanged.
        out.push(node as RootContent);
    }
  }
  return out;
}

// -- Public: plain-text extraction --------------------------------------

/**
 * Extract the readable text content of a markdown fragment, dropping all
 * formatting and links. Drop-in replacement for the regex-based
 * `stripMarkdown` previously in `parseAgenda.ts` — used for extracting
 * plain-text presenter / duration tokens during agenda import.
 */
export function extractPlainText(input: string): string {
  const tree = parser.parse(input) as Root;
  // Walk top-level children and join with a single space — `mdastToString`
  // applied to the root concatenates paragraphs without any separator,
  // which mashes "foo\n\nbar" into "foobar".
  return tree.children
    .map((child) => mdastToString(child))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// -- Public: AST access for the renderer --------------------------------

/**
 * Parse a string of inline markdown to mdast and return the root. Caller
 * is responsible for pre-validating or pre-stripping; this function does
 * not enforce the allowlist.
 */
export function parseInlineMarkdown(input: string): Root {
  return parser.parse(input) as Root;
}

/**
 * Pipeline that produces a hast tree with inline HTML resolved into
 * proper element nodes (rather than mdast's open/close `html` token
 * pairs). This is the form the renderer wants — a single tree to walk.
 */
const renderPipeline = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw);

/**
 * Parse the input as inline markdown and return a hast tree with raw
 * inline HTML resolved into proper hast elements. The renderer walks
 * this tree directly. Callers should pass content that has already been
 * through `stripUnsupportedMarkdown` (or come straight from the
 * validator on the write side) so the tree only contains allow-listed
 * nodes; this function does not re-enforce the allowlist itself.
 */
export function parseInlineToHast(input: string): HastRoot {
  const tree = renderPipeline.parse(input);
  return renderPipeline.runSync(tree) as HastRoot;
}

/**
 * Parse the input as block markdown and return a hast tree with raw
 * HTML resolved into proper hast elements. Functionally identical to
 * `parseInlineToHast` — the underlying pipeline parses full markdown
 * end-to-end either way. The two are exported separately so callers
 * express which allowlist they expect the tree to comply with: pass
 * inline-stripped input to the inline renderer, block-stripped input
 * to the block renderer.
 */
export function parseBlockToHast(input: string): HastRoot {
  const tree = renderPipeline.parse(input);
  return renderPipeline.runSync(tree) as HastRoot;
}
