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
    expect(screen.getByText('(ACME Corp)')).toBeInTheDocument();
  });

  it('omits the organisation when empty', () => {
    render(<UserBadge user={bob} />);
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.queryByText(/\(/)).not.toBeInTheDocument();
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

  it('hides the avatar on load error', () => {
    render(<UserBadge user={alice} />);
    const img = screen.getByRole('presentation');

    // Simulate a failed image load
    fireEvent.error(img);
    expect(img).toHaveStyle({ display: 'none' });
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
