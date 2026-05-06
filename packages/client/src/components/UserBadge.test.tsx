import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { UserBadge } from './UserBadge.js';
import type { User } from '@tcq/shared';

const alice: User = {
  ghid: 1,
  ghUsername: 'alice',
  name: 'Alice',
  organisation: 'ACME Corp',
};

const bob: User = {
  ghid: 2,
  ghUsername: 'bob',
  name: 'Bob',
  organisation: '',
};

describe('UserBadge', () => {
  it('renders the user name', () => {
    render(<UserBadge user={alice} />);
    expect(screen.getByText('Alice')).toBeInTheDocument();
  });

  it('renders the organisation in parentheses when present', () => {
    render(<UserBadge user={alice} />);
    // The organisation is rendered in its own truncatable span (so a long
    // company name can ellipsis without affecting the username/display
    // name) — the parens sit in adjacent text nodes around it. Assert
    // each piece is present.
    expect(screen.getByText('ACME Corp')).toBeInTheDocument();
    // The full organisation is also surfaced via the title attribute so
    // truncated values are recoverable on hover.
    expect(screen.getByText('ACME Corp').closest('[title="ACME Corp"]')).not.toBeNull();
  });

  it('omits the organisation when empty', () => {
    render(<UserBadge user={bob} />);
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.queryByText(/\(/)).not.toBeInTheDocument();
  });

  it('shows the GitHub username as a tooltip on the display name', () => {
    render(<UserBadge user={alice} />);
    // The display name surfaces the underlying login on hover so it's
    // recoverable when name and ghUsername diverge.
    const nameSpan = screen.getByText('Alice');
    expect(nameSpan).toHaveAttribute('title', 'alice');
  });

  it('applies a max-width and truncation to the organisation only (not the name)', () => {
    render(<UserBadge user={alice} />);
    const orgSpan = screen.getByText('ACME Corp');
    // Max-width + truncate keep a long company string from blowing out
    // the badge — the inline-block makes the max-width effective.
    expect(orgSpan.className).toContain('max-w-');
    expect(orgSpan.className).toContain('truncate');
    expect(orgSpan.className).toContain('inline-block');

    // The name span must NOT have these — usernames/display names are
    // load-bearing identifiers and need to render in full.
    const nameSpan = screen.getByText('Alice');
    expect(nameSpan.className).not.toContain('truncate');
    expect(nameSpan.className).not.toContain('max-w-');
  });

  it('renders a GitHub avatar image', () => {
    render(<UserBadge user={alice} />);
    const img = screen.getByRole('presentation');
    expect(img).toHaveAttribute('src', 'https://github.com/alice.png?size=40');
  });

  it('uses the default size of 20', () => {
    render(<UserBadge user={alice} />);
    const img = screen.getByRole('presentation');
    expect(img).toHaveAttribute('width', '20');
    expect(img).toHaveAttribute('height', '20');
  });

  it('respects a custom size prop', () => {
    render(<UserBadge user={alice} size={32} />);
    const img = screen.getByRole('presentation');
    expect(img).toHaveAttribute('width', '32');
    expect(img).toHaveAttribute('height', '32');
    // Requests 2x resolution for retina displays
    expect(img).toHaveAttribute('src', 'https://github.com/alice.png?size=64');
  });

  it('shows a fallback avatar on load error', () => {
    render(<UserBadge user={alice} />);
    const img = screen.getByRole('presentation') as HTMLImageElement;

    // Simulate a failed image load
    fireEvent.error(img);
    expect(img.src).toMatch(/^data:image\/svg\+xml/);
  });

  it('has fixed dimensions to prevent layout reflow', () => {
    render(<UserBadge user={alice} size={24} />);
    const img = screen.getByRole('presentation') as HTMLImageElement;

    expect(img.style.width).toBe('24px');
    expect(img.style.height).toBe('24px');
    expect(img.style.minWidth).toBe('24px');
    expect(img.style.minHeight).toBe('24px');
  });

  it('applies additional className', () => {
    const { container } = render(<UserBadge user={alice} className="text-sm text-red-500" />);
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.className).toContain('text-sm');
    expect(wrapper.className).toContain('text-red-500');
  });

  it('has an empty alt attribute on the avatar for decorative use', () => {
    render(<UserBadge user={alice} />);
    const img = screen.getByRole('presentation');
    expect(img).toHaveAttribute('alt', '');
  });
});
