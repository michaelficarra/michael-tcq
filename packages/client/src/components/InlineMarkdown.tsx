/**
 * Renders a limited subset of inline markdown as HTML.
 *
 * Supported syntax:
 * - `[text](url)` — links (open in new tab)
 * - `**bold**` — bold
 * - `*italic*` — italic
 * - `~~strikethrough~~` — strikethrough
 * - `` `code` `` — inline code
 *
 * All other content is rendered as plain text. HTML in the input is
 * escaped to prevent XSS.
 */

interface InlineMarkdownProps {
  /** The markdown text to render. */
  children: string;
  /** Additional CSS class names. */
  className?: string;
}

/** Escape HTML special characters to prevent XSS. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Convert a limited subset of inline markdown to HTML.
 * Processes in a specific order to handle nesting correctly.
 */
function markdownToHtml(text: string): string {
  // First, extract code spans to protect them from further processing.
  // Replace each code span with a placeholder, process the rest, then restore.
  const codeSpans: string[] = [];
  let processed = text.replace(/`([^`]+)`/g, (_match, code: string) => {
    const idx = codeSpans.length;
    codeSpans.push(`<code class="bg-stone-100 dark:bg-stone-800 text-stone-800 dark:text-stone-200 px-1 rounded text-[0.9em]">${escapeHtml(code)}</code>`);
    return `\x00CODE${idx}\x00`;
  });

  // Escape HTML in the remaining text
  processed = escapeHtml(processed);

  // Links: [text](url)
  processed = processed.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer" class="text-teal-600 dark:text-teal-400 hover:text-teal-800 dark:hover:text-teal-300 underline">$1</a>',
  );

  // Bold: **text**
  processed = processed.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // Strikethrough: ~~text~~
  processed = processed.replace(/~~(.+?)~~/g, '<del>$1</del>');

  // Italic: *text* (after bold to avoid conflicts)
  processed = processed.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Restore code spans
  processed = processed.replace(/\x00CODE(\d+)\x00/g, (_match, idx: string) => {
    return codeSpans[parseInt(idx, 10)];
  });

  return processed;
}

export function InlineMarkdown({ children, className }: InlineMarkdownProps) {
  const html = markdownToHtml(children);

  // If the output is identical to escaped input (no markdown was applied),
  // render as plain text to avoid unnecessary dangerouslySetInnerHTML.
  if (html === escapeHtml(children)) {
    return <span className={className}>{children}</span>;
  }

  return (
    <span
      className={className}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
