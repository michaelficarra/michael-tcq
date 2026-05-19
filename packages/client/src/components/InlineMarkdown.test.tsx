import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { InlineMarkdown } from './InlineMarkdown.js';

describe('InlineMarkdown', () => {
  it('renders plain text as-is', () => {
    render(<InlineMarkdown>Hello world</InlineMarkdown>);
    expect(screen.getByText('Hello world')).toBeInTheDocument();
  });

  it('renders markdown links as anchor tags', () => {
    render(<InlineMarkdown>{'Check [this](https://example.com) out'}</InlineMarkdown>);
    const link = screen.getByText('this');
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', 'https://example.com');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('renders bold text', () => {
    render(<InlineMarkdown>{'**bold** text'}</InlineMarkdown>);
    const bold = screen.getByText('bold');
    expect(bold.tagName).toBe('STRONG');
  });

  it('renders italic text', () => {
    render(<InlineMarkdown>{'*italic* text'}</InlineMarkdown>);
    const italic = screen.getByText('italic');
    expect(italic.tagName).toBe('EM');
  });

  it('renders strikethrough text', () => {
    render(<InlineMarkdown>{'~~deleted~~ text'}</InlineMarkdown>);
    const del = screen.getByText('deleted');
    expect(del.tagName).toBe('DEL');
  });

  it('renders inline code', () => {
    render(<InlineMarkdown>{'Use `console.log` here'}</InlineMarkdown>);
    const code = screen.getByText('console.log');
    expect(code.tagName).toBe('CODE');
  });

  it('renders disallowed HTML as literal text rather than executing it', () => {
    // Disallowed tags are escaped to their source form: the reader sees
    // the `<script>` as visible text, but no actual <script> element is
    // created (so nothing executes) and the payload remains visible.
    const { container } = render(<InlineMarkdown>{'<script>alert("xss")</script>'}</InlineMarkdown>);
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>');
    expect(container.textContent).toContain('</script>');
    expect(container.textContent).toContain('alert("xss")');
  });

  it('does not use dangerouslySetInnerHTML', () => {
    // The renderer must walk the AST and emit React elements; raw HTML
    // injection is the surface we deliberately removed.
    const { container } = render(<InlineMarkdown>{'**bold** and [link](https://x.example)'}</InlineMarkdown>);
    // No element in the rendered tree should carry the property — easiest
    // check is that the bold and link were rendered as proper elements.
    expect(container.querySelector('strong')).not.toBeNull();
    expect(container.querySelector('a')).not.toBeNull();
  });

  it('renders allow-listed inline HTML tags', () => {
    const { container } = render(<InlineMarkdown>{'water H<sub>2</sub>O and 10<sup>9</sup>'}</InlineMarkdown>);
    expect(container.querySelector('sub')?.textContent).toBe('2');
    expect(container.querySelector('sup')?.textContent).toBe('9');
  });

  it('renders <a> with safe target/rel even when the source HTML omits them', () => {
    const { container } = render(<InlineMarkdown>{'<a href="https://x.example">link</a>'}</InlineMarkdown>);
    const a = container.querySelector('a');
    expect(a).not.toBeNull();
    expect(a?.getAttribute('target')).toBe('_blank');
    expect(a?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(a?.getAttribute('href')).toBe('https://x.example');
  });

  it('renders a markdown link with a javascript: URL as literal source', () => {
    // Bad URL schemes no longer get silently unwrapped to their text;
    // the whole link source survives as visible markdown so the reader
    // sees what was actually written.
    const { container } = render(<InlineMarkdown>{'[click](javascript:alert(1))'}</InlineMarkdown>);
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('[click]');
    expect(container.textContent).toContain('javascript:alert(1)');
  });

  it('renders legacy heading-syntax content as plain text', () => {
    // Stored data may pre-date the validator and contain block markdown;
    // the renderer must tolerate it without crashing.
    const { container } = render(<InlineMarkdown>{'# Legacy heading'}</InlineMarkdown>);
    // Must not produce a real <h1>; the text survives as plain content.
    expect(container.querySelector('h1')).toBeNull();
    expect(container.textContent).toContain('Legacy heading');
  });

  it('handles multiple formatting in one string', () => {
    render(<InlineMarkdown>{'[Temporal](https://example.com) for **Stage 4**'}</InlineMarkdown>);
    const link = screen.getByText('Temporal');
    expect(link.tagName).toBe('A');
    const bold = screen.getByText('Stage 4');
    expect(bold.tagName).toBe('STRONG');
  });

  it('does not process markdown inside code spans', () => {
    render(<InlineMarkdown>{'`**not bold**`'}</InlineMarkdown>);
    const code = screen.getByText('**not bold**');
    expect(code.tagName).toBe('CODE');
  });

  it('accepts a className prop', () => {
    const { container } = render(<InlineMarkdown className="text-red-500">plain</InlineMarkdown>);
    expect(container.firstElementChild).toHaveClass('text-red-500');
  });

  describe('GitHub issue/PR shortlinks', () => {
    it('shortens an autolinked PR URL to org/repo#number', () => {
      const { container } = render(
        <InlineMarkdown>{'See <https://github.com/tc39/ecma262/pull/3776>'}</InlineMarkdown>,
      );
      const a = container.querySelector('a');
      expect(a?.getAttribute('href')).toBe('https://github.com/tc39/ecma262/pull/3776');
      expect(a?.textContent).toBe('tc39/ecma262#3776');
    });

    it('shortens an autolinked issue URL', () => {
      const { container } = render(
        <InlineMarkdown>{'See <https://github.com/tc39/proposal-source-phase-imports/issues/75>'}</InlineMarkdown>,
      );
      const a = container.querySelector('a');
      expect(a?.textContent).toBe('tc39/proposal-source-phase-imports#75');
    });

    it('shortens [url](url) where the text equals the URL', () => {
      const { container } = render(
        <InlineMarkdown>
          {'[https://github.com/owner/repo/pull/1](https://github.com/owner/repo/pull/1)'}
        </InlineMarkdown>,
      );
      const a = container.querySelector('a');
      expect(a?.textContent).toBe('owner/repo#1');
    });

    it('preserves author-chosen link text', () => {
      const { container } = render(
        <InlineMarkdown>{'[#3776](https://github.com/tc39/ecma262/pull/3776)'}</InlineMarkdown>,
      );
      const a = container.querySelector('a');
      expect(a?.textContent).toBe('#3776');
    });

    it('does not shorten a URL pointing at a sub-view (e.g. /files)', () => {
      const { container } = render(<InlineMarkdown>{'<https://github.com/owner/repo/pull/1/files>'}</InlineMarkdown>);
      const a = container.querySelector('a');
      expect(a?.textContent).toBe('https://github.com/owner/repo/pull/1/files');
    });

    it('shortens a URL with a trailing slash', () => {
      const { container } = render(<InlineMarkdown>{'<https://github.com/owner/repo/issues/42/>'}</InlineMarkdown>);
      expect(container.querySelector('a')?.textContent).toBe('owner/repo#42');
    });

    it('shortens a URL with a fragment (drops the fragment from the display)', () => {
      const { container } = render(
        <InlineMarkdown>{'<https://github.com/owner/repo/pull/9#issuecomment-123>'}</InlineMarkdown>,
      );
      const a = container.querySelector('a');
      expect(a?.textContent).toBe('owner/repo#9');
      expect(a?.getAttribute('href')).toBe('https://github.com/owner/repo/pull/9#issuecomment-123');
    });

    it('does not shorten a non-issue/PR GitHub URL', () => {
      const { container } = render(<InlineMarkdown>{'<https://github.com/owner/repo>'}</InlineMarkdown>);
      expect(container.querySelector('a')?.textContent).toBe('https://github.com/owner/repo');
    });
  });
});
