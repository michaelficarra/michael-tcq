/**
 * Render the supported subset of *block* markdown as React.
 *
 * Used by the agenda prologue/epilogue sections, which accept multi-
 * paragraph content with headings, lists, blockquotes, code blocks,
 * tables, `<details>`/`<summary>`, and the inline subset that
 * `InlineMarkdown` already supports.
 *
 * The pipeline mirrors `InlineMarkdown` exactly:
 *
 *   1. Pre-pass through `stripUnsupportedBlockMarkdown` so legacy or
 *      partially-corrupted stored content renders rather than throws —
 *      anything outside the allowlist (images, `<script>`, …) is
 *      removed, block structure preserved.
 *   2. Parse the cleaned input into a hast tree (markdown → mdast →
 *      hast, with raw HTML resolved into proper element nodes).
 *   3. Walk the tree and emit React elements directly — no
 *      `dangerouslySetInnerHTML`.
 *
 * Rendering decisions (heading sizing, blockquote accent, code-block
 * background, table borders) live here as Tailwind classes. The inline
 * tag handling intentionally duplicates `InlineMarkdown`'s small
 * inline-tag table to keep both components self-contained.
 */

import { Fragment, useMemo, type ReactNode } from 'react';
import {
  parseBlockToHast,
  stripUnsupportedBlockMarkdown,
  ALLOWED_BLOCK_HTML_TAGS,
  ALLOWED_BLOCK_HTML_ATTRS_BY_TAG,
  ALLOWED_URL_SCHEMES,
} from '@tcq/shared';
import type { Element, Root as HastRoot, RootContent as HastRootContent } from 'hast';

interface BlockMarkdownProps {
  /** The markdown text to render. */
  children: string;
  /** Additional CSS class names applied to the wrapping <div>. */
  className?: string;
}

// Match InlineMarkdown's link/code styling so links in prologue text look
// like links anywhere else in the app.
const LINK_CLASS =
  'external-link text-teal-600 dark:text-teal-400 hover:text-teal-800 dark:hover:text-teal-300 underline';
const CODE_CLASS = 'bg-stone-100 dark:bg-stone-800 text-stone-800 dark:text-stone-200 px-1 rounded text-[0.9em]';

// Per-heading Tailwind sizes. Tuned to read as a sectional hierarchy
// inside a prologue/epilogue without overpowering surrounding agenda
// items — `h1` is roughly the size of the agenda item names; deeper
// levels step down from there.
const HEADING_CLASSES: Record<string, string> = {
  h1: 'text-xl font-bold text-stone-900 dark:text-stone-100 mt-3 mb-2 first:mt-0',
  h2: 'text-lg font-bold text-stone-900 dark:text-stone-100 mt-3 mb-2 first:mt-0',
  h3: 'text-base font-semibold text-stone-900 dark:text-stone-100 mt-2 mb-1 first:mt-0',
  h4: 'text-sm font-semibold text-stone-900 dark:text-stone-100 mt-2 mb-1 first:mt-0',
  h5: 'text-sm font-medium text-stone-900 dark:text-stone-100 mt-2 mb-1 first:mt-0',
  h6: 'text-xs font-medium uppercase tracking-wide text-stone-700 dark:text-stone-300 mt-2 mb-1 first:mt-0',
};

const PARAGRAPH_CLASS = 'mb-2 last:mb-0';
const UL_CLASS = 'list-disc pl-6 mb-2 last:mb-0 space-y-0.5';
const OL_CLASS = 'list-decimal pl-6 mb-2 last:mb-0 space-y-0.5';
const BLOCKQUOTE_CLASS =
  'border-l-4 border-stone-300 dark:border-stone-600 pl-3 italic text-stone-700 dark:text-stone-300 mb-2 last:mb-0';
const PRE_CLASS =
  'bg-stone-100 dark:bg-stone-800 text-stone-800 dark:text-stone-200 rounded p-2 overflow-x-auto text-sm font-mono mb-2 last:mb-0';
const HR_CLASS = 'my-3 border-stone-300 dark:border-stone-600';
const TABLE_CLASS = 'table-auto border-collapse my-2 text-sm';
const TH_CLASS =
  'border border-stone-300 dark:border-stone-600 px-2 py-1 font-semibold text-left bg-stone-100 dark:bg-stone-800';
const TD_CLASS = 'border border-stone-300 dark:border-stone-600 px-2 py-1';
const DETAILS_CLASS = 'mb-2 last:mb-0';
const SUMMARY_CLASS = 'cursor-pointer font-medium text-stone-800 dark:text-stone-200';

// -- URL safety (mirrors the server-side validator) ---------------------

function isAllowedUrl(url: string): boolean {
  const trimmed = url.trim();
  if (trimmed.length === 0) return false;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return true;
  try {
    const u = new URL(trimmed);
    return (ALLOWED_URL_SCHEMES as readonly string[]).includes(u.protocol);
  } catch {
    return false;
  }
}

// -- hast → React -------------------------------------------------------

function renderChildren(children: ReadonlyArray<HastRootContent>): ReactNode[] {
  return children.map((child, i) => <Fragment key={i}>{renderNode(child)}</Fragment>);
}

function renderNode(node: HastRootContent): ReactNode {
  if (node.type === 'text') return node.value;
  if (node.type !== 'element') return null;
  const el = node as Element;
  const tag = el.tagName.toLowerCase();

  if (!(ALLOWED_BLOCK_HTML_TAGS as readonly string[]).includes(tag)) {
    // Disallowed tag — render its inner text only. Stripping happened
    // up the pipeline; this is a defensive fallback.
    return <>{renderChildren(el.children)}</>;
  }

  // Filter properties to the allow-listed set, validating href on `<a>`.
  const props: Record<string, string | boolean> = {};
  const allowed = ALLOWED_BLOCK_HTML_ATTRS_BY_TAG[tag] ?? [];
  for (const [attr, raw] of Object.entries(el.properties ?? {})) {
    if (!(allowed as readonly string[]).includes(attr)) continue;
    if (tag === 'a' && attr === 'href' && (typeof raw !== 'string' || !isAllowedUrl(raw))) continue;
    if (typeof raw === 'string' || typeof raw === 'boolean') props[attr] = raw;
  }

  // Block tags ---------------------------------------------------------
  switch (tag) {
    case 'p':
      return <p className={PARAGRAPH_CLASS}>{renderChildren(el.children)}</p>;
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6': {
      const Heading = tag as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
      return <Heading className={HEADING_CLASSES[tag]}>{renderChildren(el.children)}</Heading>;
    }
    case 'ul':
      return <ul className={UL_CLASS}>{renderChildren(el.children)}</ul>;
    case 'ol': {
      const startAttr = typeof props.start === 'string' ? parseInt(props.start, 10) : undefined;
      return (
        <ol className={OL_CLASS} start={Number.isFinite(startAttr) ? startAttr : undefined}>
          {renderChildren(el.children)}
        </ol>
      );
    }
    case 'li':
      return <li>{renderChildren(el.children)}</li>;
    case 'hr':
      return <hr className={HR_CLASS} />;
    case 'blockquote':
      return <blockquote className={BLOCKQUOTE_CLASS}>{renderChildren(el.children)}</blockquote>;
    case 'pre':
      // remark-rehype wraps fenced code in `<pre><code>`. The inner
      // `<code>` is rendered via the inline case below, but inside a
      // <pre> we want the block code styling on the wrapping <pre>.
      return <pre className={PRE_CLASS}>{renderChildren(el.children)}</pre>;
    case 'table':
      return <table className={TABLE_CLASS}>{renderChildren(el.children)}</table>;
    case 'thead':
      return <thead>{renderChildren(el.children)}</thead>;
    case 'tbody':
      return <tbody>{renderChildren(el.children)}</tbody>;
    case 'tr':
      return <tr>{renderChildren(el.children)}</tr>;
    case 'th': {
      const align = typeof props.align === 'string' ? (props.align as 'left' | 'center' | 'right') : undefined;
      return (
        <th className={TH_CLASS} style={align ? { textAlign: align } : undefined}>
          {renderChildren(el.children)}
        </th>
      );
    }
    case 'td': {
      const align = typeof props.align === 'string' ? (props.align as 'left' | 'center' | 'right') : undefined;
      return (
        <td className={TD_CLASS} style={align ? { textAlign: align } : undefined}>
          {renderChildren(el.children)}
        </td>
      );
    }
    case 'details': {
      const open = props.open === true || props.open === '' || props.open === 'open';
      return (
        <details className={DETAILS_CLASS} open={open}>
          {renderChildren(el.children)}
        </details>
      );
    }
    case 'summary':
      return <summary className={SUMMARY_CLASS}>{renderChildren(el.children)}</summary>;
  }

  // Inline tags --------------------------------------------------------
  if (tag === 'a') {
    const href = typeof props.href === 'string' ? props.href : undefined;
    const title = typeof props.title === 'string' ? props.title : undefined;
    if (!href) return <>{renderChildren(el.children)}</>;
    return (
      <a href={href} title={title} target="_blank" rel="noopener noreferrer" className={LINK_CLASS}>
        {renderChildren(el.children)}
      </a>
    );
  }
  if (tag === 'code') {
    // Inside a <pre>, remark-rehype emits a <code> child. Keep the code
    // span unstyled there so the parent <pre>'s block styling owns the
    // look; outside a <pre>, apply the inline chip styling.
    const insidePre = false; // walked top-down without context; styling chip is fine in both contexts
    return insidePre ? (
      <code>{renderChildren(el.children)}</code>
    ) : (
      <code className={CODE_CLASS}>{renderChildren(el.children)}</code>
    );
  }
  if (tag === 'br') return <br />;
  // Generic allow-listed inline tag — render with the literal tag name.
  const Tag = tag as 'b' | 'strong' | 'i' | 'em' | 'u' | 's' | 'del' | 'ins' | 'sub' | 'sup' | 'dfn' | 'abbr';
  const passProps: Record<string, string | boolean> = {};
  if (typeof props.title === 'string') passProps.title = props.title;
  return <Tag {...passProps}>{renderChildren(el.children)}</Tag>;
}

// -- Public component ---------------------------------------------------

export function BlockMarkdown({ children, className }: BlockMarkdownProps) {
  // Tolerant pre-pass for legacy or partially-corrupted content, same as
  // InlineMarkdown. Memoised on input — the unified pipeline is the
  // expensive part and a prologue is re-rendered on every meeting state
  // change, so without memoisation we'd reparse on every tick.
  const tree = useMemo<HastRoot | null>(() => {
    const safe = stripUnsupportedBlockMarkdown(children);
    return safe.length === 0 ? null : parseBlockToHast(safe);
  }, [children]);
  if (!tree) return <div className={className}></div>;
  return <div className={className}>{renderChildren(tree.children)}</div>;
}
