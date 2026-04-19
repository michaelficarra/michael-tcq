import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { UserMenu } from './UserMenu.js';

const mockUser = { ghid: 1, ghUsername: 'admin', name: 'Admin', organisation: 'Test' };
const mockSwitchUser = vi.fn(async () => {});

vi.mock('../contexts/AuthContext.js', () => ({
  useAuth: () => ({
    user: mockUser,
    loading: false,
    mockAuth: true,
    isAdmin: false,
    switchUser: mockSwitchUser,
  }),
}));

describe('UserMenu (dev user-switcher)', () => {
  it('prefills the input with the current username when opened', () => {
    render(<UserMenu />);
    fireEvent.click(screen.getByRole('button', { name: /admin/i }));
    expect(screen.getByRole('textbox')).toHaveValue('admin');
  });

  it('selects the prefilled text so typing replaces it', () => {
    render(<UserMenu />);
    fireEvent.click(screen.getByRole('button', { name: /admin/i }));
    const input = screen.getByRole('textbox') as HTMLInputElement;
    // The callback ref should have selected all text
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe('admin'.length);
  });

  it('pressing Escape closes the switcher', () => {
    render(<UserMenu />);
    fireEvent.click(screen.getByRole('button', { name: /admin/i }));
    expect(screen.getByRole('textbox')).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });

    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /admin/i })).toBeInTheDocument();
  });
});

describe('UserMenu (logout hamburger dropdown)', () => {
  it('does not show the Log Out link until the hamburger is clicked', () => {
    render(<UserMenu />);
    expect(screen.queryByRole('menuitem', { name: 'Log Out' })).not.toBeInTheDocument();
  });

  it('clicking the hamburger reveals the Log Out link with the correct href', () => {
    render(<UserMenu />);
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    const logOut = screen.getByRole('menuitem', { name: 'Log Out' });
    expect(logOut).toHaveAttribute('href', '/auth/logout');
  });

  it('the hamburger button reflects the open state via aria-expanded', () => {
    render(<UserMenu />);
    const button = screen.getByRole('button', { name: 'Open menu' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
  });

  it('clicking the hamburger again while open closes the dropdown', () => {
    render(<UserMenu />);
    const button = screen.getByRole('button', { name: 'Open menu' });
    fireEvent.click(button);
    expect(screen.getByRole('menuitem', { name: 'Log Out' })).toBeInTheDocument();

    fireEvent.click(button);

    expect(screen.queryByRole('menuitem', { name: 'Log Out' })).not.toBeInTheDocument();
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  it('pressing Escape dismisses the dropdown', () => {
    render(<UserMenu />);
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    expect(screen.getByRole('menuitem', { name: 'Log Out' })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('menuitem', { name: 'Log Out' })).not.toBeInTheDocument();
  });

  it('pointerdown outside the dropdown dismisses it', () => {
    render(
      <div>
        <button>other</button>
        <UserMenu />
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    expect(screen.getByRole('menuitem', { name: 'Log Out' })).toBeInTheDocument();

    // Simulate a pointerdown on another element in the document. The menu
    // should dismiss without blocking the underlying target.
    fireEvent.pointerDown(screen.getByRole('button', { name: 'other' }));

    expect(screen.queryByRole('menuitem', { name: 'Log Out' })).not.toBeInTheDocument();
  });
});
