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

  it('escapes HTML to prevent XSS', () => {
    const { container } = render(<InlineMarkdown>{'<script>alert("xss")</script>'}</InlineMarkdown>);
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>');
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
});
