import { describe, it, expect } from 'vitest';
import {
  validateInlineMarkdown,
  stripUnsupportedMarkdown,
  extractPlainText,
  ALLOWED_HTML_TAGS,
  ALLOWED_URL_SCHEMES,
  AgendaAddPayloadSchema,
  AgendaEditPayloadSchema,
  QueueAddPayloadSchema,
  NextAgendaItemPayloadSchema,
} from '@tcq/shared';

/**
 * The shared markdown module is consumed by both packages, but only the
 * server workspace runs vitest in this repo, so the unit tests live here.
 */

describe('validateInlineMarkdown', () => {
  describe('accepts every supported inline construct', () => {
    const cases: Array<[string, string]> = [
      ['plain text', 'just words'],
      ['bold (asterisk)', '**bold**'],
      ['bold (underscore)', '__bold__'],
      ['italic (asterisk)', '*italic*'],
      ['italic (underscore)', '_italic_'],
      ['strikethrough (GFM)', '~~strike~~'],
      ['inline code', '`code`'],
      ['markdown link with https', '[ok](https://example.com)'],
      ['markdown link with http', '[ok](http://example.com)'],
      ['markdown link with mailto', '[ok](mailto:a@example.com)'],
      ['markdown link with relative URL', '[ok](./page.html)'],
      ['autolink (GFM)', 'https://example.com'],
      ['mixed inline formatting', '**bold** and *italic* and `code` with [a link](https://x.example)'],
      ['empty input', ''],
    ];
    it.each(cases)('%s', (_label, input) => {
      expect(validateInlineMarkdown(input)).toEqual({ ok: true });
    });
  });

  describe('accepts every allow-listed HTML tag', () => {
    it.each(ALLOWED_HTML_TAGS.map((t) => [t]))('<%s>', (tag) => {
      const input = tag === 'a' ? `<a href="https://x.example">x</a>` : `<${tag}>x</${tag}>`;
      expect(validateInlineMarkdown(input)).toEqual({ ok: true });
    });
  });

  describe('rejects every block-level construct with a specific reason', () => {
    const cases: Array<[string, string, RegExp]> = [
      ['heading', '# heading', /Headings/],
      ['list (ordered)', '1. one\n2. two', /Lists/],
      ['list (unordered)', '- one\n- two', /Lists/],
      ['table (GFM)', '| a | b |\n|---|---|\n| 1 | 2 |', /Tables/],
      ['blockquote', '> quote', /Blockquotes/],
      ['thematic break', '---', /Horizontal rules/],
      ['fenced code block', '```\ncode\n```', /Code blocks/],
      ['indented code block', '    code', /Code blocks/],
      ['multiple paragraphs', 'first\n\nsecond', /Multiple paragraphs/],
      ['image (markdown)', '![alt](x.png)', /Images/],
    ];
    it.each(cases)('%s', (_label, input, expected) => {
      const r = validateInlineMarkdown(input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(expected);
    });
  });

  describe('rejects disallowed HTML tags', () => {
    const cases = [
      ['script', '<script>alert(1)</script>'],
      ['iframe', '<iframe src="x"></iframe>'],
      ['style', '<style>body{}</style>'],
      ['div', '<div>x</div>'],
      ['img', '<img src="x" />'],
    ];
    it.each(cases)('rejects <%s>', (tag, input) => {
      const r = validateInlineMarkdown(input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(new RegExp(`<${tag}>`));
    });
  });

  describe('rejects disallowed HTML attributes', () => {
    const cases: Array<[string, string, RegExp]> = [
      ['onclick handler', '<a href="https://x.example" onclick="x">x</a>', /onclick/i],
      ['style attribute', '<b style="color: red">x</b>', /style/],
      ['class attribute', '<b class="big">x</b>', /class/i],
      ['target on link', '<a href="https://x.example" target="_blank">x</a>', /target/],
    ];
    it.each(cases)('%s', (_label, input, expected) => {
      const r = validateInlineMarkdown(input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(expected);
    });
  });

  describe('rejects disallowed URL schemes', () => {
    const cases = [
      ['javascript: in markdown link', '[click](javascript:alert(1))'],
      ['data: in markdown link', '[click](data:text/html,<script>1</script>)'],
      ['javascript: in <a href>', '<a href="javascript:alert(1)">x</a>'],
      ['JAVASCRIPT: case-insensitive', '<a href="JAVASCRIPT:alert(1)">x</a>'],
      ['file: scheme', '<a href="file:///etc/passwd">x</a>'],
    ];
    it.each(cases)('%s', (_label, input) => {
      const r = validateInlineMarkdown(input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain(ALLOWED_URL_SCHEMES.join(', '));
    });
  });
});

describe('stripUnsupportedMarkdown', () => {
  it('preserves a plain inline document verbatim', () => {
    const input = '**bold** and *italic*';
    expect(stripUnsupportedMarkdown(input)).toBe(input);
  });

  it('flattens a heading to its text content', () => {
    expect(stripUnsupportedMarkdown('# A heading')).toBe('A heading');
  });

  it('flattens a list to a single line of text', () => {
    expect(stripUnsupportedMarkdown('- one\n- two\n- three')).toContain('one');
  });

  it('strips a disallowed HTML tag but keeps its inner text', () => {
    // mdast emits `<script>` `alert(1)` `</script>` as separate inline
    // tokens. The html tags are dropped; the text inside survives.
    const out = stripUnsupportedMarkdown('hi <script>x</script>');
    expect(out).not.toMatch(/<script>/);
    expect(out).toContain('hi');
  });

  it('keeps an allow-listed HTML tag', () => {
    const out = stripUnsupportedMarkdown('hi <sub>2</sub>');
    expect(out).toContain('<sub>');
    expect(out).toContain('</sub>');
  });

  it('drops a link with a disallowed URL scheme but keeps the link text', () => {
    const out = stripUnsupportedMarkdown('[ok](javascript:alert(1))');
    expect(out).not.toMatch(/javascript:/);
    expect(out).toContain('ok');
  });

  it('returns an empty string for input that becomes empty after stripping', () => {
    expect(stripUnsupportedMarkdown('![alt](x.png)')).toBe('');
  });
});

describe('Zod schema integration', () => {
  it('AgendaAddPayloadSchema accepts inline markdown in `name`', () => {
    const r = AgendaAddPayloadSchema.safeParse({
      name: '**Temporal** for [Stage 4](https://github.com/tc39/proposal-temporal)',
      presenterUsernames: ['alice'],
    });
    expect(r.success).toBe(true);
  });

  it('AgendaAddPayloadSchema rejects a heading in `name` with the validator reason', () => {
    const r = AgendaAddPayloadSchema.safeParse({
      name: '# heading',
      presenterUsernames: ['alice'],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].message).toMatch(/Headings/);
      // The label prefix from `markdownString('Agenda item name')` is included.
      expect(r.error.issues[0].message).toMatch(/Agenda item name/);
    }
  });

  it('AgendaAddPayloadSchema rejects a javascript: link', () => {
    const r = AgendaAddPayloadSchema.safeParse({
      name: '[click](javascript:alert(1))',
      presenterUsernames: ['alice'],
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toContain(ALLOWED_URL_SCHEMES.join(', '));
  });

  it('AgendaEditPayloadSchema (optional name) rejects a heading when provided', () => {
    const r = AgendaEditPayloadSchema.safeParse({ id: 'x', name: '# heading' });
    expect(r.success).toBe(false);
  });

  it('AgendaEditPayloadSchema (optional name) accepts an omitted name', () => {
    const r = AgendaEditPayloadSchema.safeParse({ id: 'x' });
    expect(r.success).toBe(true);
  });

  it('QueueAddPayloadSchema rejects a list in `topic`', () => {
    const r = QueueAddPayloadSchema.safeParse({ type: 'topic', topic: '- one\n- two' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toMatch(/Lists/);
  });

  it('NextAgendaItemPayloadSchema accepts an empty conclusion (used to clear)', () => {
    const r = NextAgendaItemPayloadSchema.safeParse({ currentAgendaItemId: 'x', conclusion: '' });
    expect(r.success).toBe(true);
  });

  it('NextAgendaItemPayloadSchema rejects an invalid conclusion when provided', () => {
    const r = NextAgendaItemPayloadSchema.safeParse({
      currentAgendaItemId: 'x',
      conclusion: '<script>x</script>',
    });
    expect(r.success).toBe(false);
  });
});

describe('extractPlainText', () => {
  it('strips markdown links to their text', () => {
    expect(extractPlainText('[text](https://example.com)')).toBe('text');
  });

  it('strips bold formatting', () => {
    expect(extractPlainText('**bold text**')).toBe('bold text');
  });

  it('strips italic formatting', () => {
    expect(extractPlainText('*italic text*')).toBe('italic text');
  });

  it('strips inline code formatting', () => {
    expect(extractPlainText('`code`')).toBe('code');
  });

  it('strips combined formatting', () => {
    expect(extractPlainText('[**bold link**](url) and *italic*')).toBe('bold link and italic');
  });

  it('collapses whitespace', () => {
    expect(extractPlainText('foo   bar\n\nbaz')).toBe('foo bar baz');
  });
});
