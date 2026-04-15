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
