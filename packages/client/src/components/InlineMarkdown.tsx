/**
 * Render the supported subset of inline markdown as React.
 *
 * The supported subset and its allowlist live in
 * `@tcq/shared/src/markdown.ts`. This component:
 *
 *   1. Pre-passes the input through `stripUnsupportedMarkdown` so that
 *      legacy stored content (predating the validator) renders without
 *      throwing — anything outside the allowlist becomes plain text.
 *   2. Parses the cleaned input into a hast tree (markdown → mdast →
 *      hast, with raw inline HTML resolved into proper element nodes).
 *   3. Walks the resulting tree and emits React elements directly —
 *      no `dangerouslySetInnerHTML`.
 *
 * Rendering decisions (link colours, code-span chips) live here in
 * Tailwind classes — only this component cares about the visual style.
 */

import { Fragment, type ReactNode } from 'react';
import {
  parseInlineToHast,
  stripUnsupportedMarkdown,
  ALLOWED_HTML_TAGS,
  ALLOWED_HTML_ATTRS_BY_TAG,
  ALLOWED_URL_SCHEMES,
} from '@tcq/shared';
import type { Element, Root as HastRoot, RootContent as HastRootContent } from 'hast';

interface InlineMarkdownProps {
  /** The markdown text to render. */
  children: string;
  /** Additional CSS class names. */
  className?: string;
}

const LINK_CLASS = 'text-teal-600 dark:text-teal-400 hover:text-teal-800 dark:hover:text-teal-300 underline';
const CODE_CLASS = 'bg-stone-100 dark:bg-stone-800 text-stone-800 dark:text-stone-200 px-1 rounded text-[0.9em]';

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

// -- GitHub issue/PR shortlink display ---------------------------------

/**
 * Match a "naked" GitHub issue or PR URL — `https://github.com/<org>/
 * <repo>/(issues|pull)/<number>` with an optional trailing `/`, query,
 * or fragment. Deeper paths like `/files` or `/commits/...` are left
 * alone, since they reference a sub-view of the issue/PR rather than
 * the issue/PR itself.
 */
const GITHUB_ISSUE_PR_RE = /^https?:\/\/github\.com\/([^/?#]+)\/([^/?#]+)\/(?:issues|pull)\/(\d+)\/?(?:[?#]|$)/;

function githubIssuePrShortlink(url: string): string | null {
  const m = url.match(GITHUB_ISSUE_PR_RE);
  if (!m) return null;
  return `${m[1]}/${m[2]}#${m[3]}`;
}

/**
 * If the link's only child is a text node whose value matches the href
 * (i.e. the source was an autolink or `[url](url)`) and the URL is a
 * GitHub issue/PR, return the canonical short form; otherwise null
 * (the renderer falls back to the original children).
 */
function rawGithubShortlinkText(href: string, children: ReadonlyArray<HastRootContent>): string | null {
  if (children.length !== 1) return null;
  const child = children[0];
  if (child.type !== 'text') return null;
  if (child.value !== href) return null;
  return githubIssuePrShortlink(href);
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

  // remark-rehype emits `<p>` wrappers around inline content. Flatten
  // them so the rendered span doesn't contain a real <p> (which would
  // break inline layout).
  if (tag === 'p') return <>{renderChildren(el.children)}</>;

  if (!(ALLOWED_HTML_TAGS as readonly string[]).includes(tag)) {
    // Disallowed tag — render its inner text only. Stripping happened
    // up the pipeline; this is a defensive fallback.
    return <>{renderChildren(el.children)}</>;
  }

  // Filter properties to the allow-listed set, validating href on `<a>`.
  const props: Record<string, string> = {};
  const allowed = ALLOWED_HTML_ATTRS_BY_TAG[tag] ?? [];
  for (const [attr, raw] of Object.entries(el.properties ?? {})) {
    if (!(allowed as readonly string[]).includes(attr)) continue;
    if (typeof raw !== 'string') continue;
    if (tag === 'a' && attr === 'href' && !isAllowedUrl(raw)) continue;
    props[attr] = raw;
  }

  if (tag === 'a') {
    if (!props.href) return <>{renderChildren(el.children)}</>;
    // Raw GitHub issue / PR autolinks display as `org/repo#1234` rather
    // than the verbose URL. Links whose author chose explicit text
    // (`[some PR](url)`, `[#123](url)`) keep that text.
    const shortlink = rawGithubShortlinkText(props.href, el.children);
    return (
      <a href={props.href} title={props.title} target="_blank" rel="noopener noreferrer" className={LINK_CLASS}>
        {shortlink ?? renderChildren(el.children)}
      </a>
    );
  }
  if (tag === 'code') {
    return <code className={CODE_CLASS}>{renderChildren(el.children)}</code>;
  }
  // Generic allow-listed inline tag — render with the literal tag name.
  const Tag = tag as 'b' | 'strong' | 'i' | 'em' | 'u' | 's' | 'del' | 'sub' | 'sup';
  return <Tag>{renderChildren(el.children)}</Tag>;
}

// -- Public component ---------------------------------------------------

export function InlineMarkdown({ children, className }: InlineMarkdownProps) {
  // Tolerant: legacy stored content might contain constructs the
  // validator now rejects (e.g. headings, multi-paragraph). Strip them
  // before parsing so the renderer always sees a clean inline tree.
  const safe = stripUnsupportedMarkdown(children);
  if (safe.length === 0) return <span className={className}></span>;
  const tree: HastRoot = parseInlineToHast(safe);
  return <span className={className}>{renderChildren(tree.children)}</span>;
}
