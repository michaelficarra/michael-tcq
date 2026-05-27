import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ReactElement } from 'react';
import { UserMenu } from './UserMenu.js';
import { PreferencesProvider } from '../contexts/PreferencesContext.js';

/** UserMenu reads from PreferencesContext (hamburger's Preferences entry). */
function renderWithPrefs(ui: ReactElement) {
  return render(<PreferencesProvider>{ui}</PreferencesProvider>);
}

const mockUser = {
  provider: 'github',
  accountId: 'admin',
  handle: 'admin',
  name: 'Admin',
  organisation: 'Test',
  avatarUrl: 'https://github.com/admin.png?size=80',
};
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
    renderWithPrefs(<UserMenu />);
    fireEvent.click(screen.getByRole('button', { name: /admin/i }));
    expect(screen.getByRole('combobox')).toHaveValue('admin');
  });

  it('selects the prefilled text so typing replaces it', () => {
    renderWithPrefs(<UserMenu />);
    fireEvent.click(screen.getByRole('button', { name: /admin/i }));
    const input = screen.getByRole('combobox') as HTMLInputElement;
    // The callback ref should have selected all text
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe('admin'.length);
  });

  it('pressing Escape closes the switcher', () => {
    renderWithPrefs(<UserMenu />);
    fireEvent.click(screen.getByRole('button', { name: /admin/i }));
    expect(screen.getByRole('combobox')).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });

    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /admin/i })).toBeInTheDocument();
  });
});

describe('UserMenu (logout hamburger dropdown)', () => {
  it('does not show the Log out link until the hamburger is clicked', () => {
    renderWithPrefs(<UserMenu />);
    expect(screen.queryByRole('menuitem', { name: 'Log out' })).not.toBeInTheDocument();
  });

  it('clicking the hamburger reveals the Log out link with the correct href', () => {
    renderWithPrefs(<UserMenu />);
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    const logOut = screen.getByRole('menuitem', { name: 'Log out' });
    expect(logOut).toHaveAttribute('href', '/auth/logout');
  });

  it('the hamburger button reflects the open state via aria-expanded', () => {
    renderWithPrefs(<UserMenu />);
    const button = screen.getByRole('button', { name: 'Open menu' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
  });

  it('clicking the hamburger again while open closes the dropdown', () => {
    renderWithPrefs(<UserMenu />);
    const button = screen.getByRole('button', { name: 'Open menu' });
    fireEvent.click(button);
    expect(screen.getByRole('menuitem', { name: 'Log out' })).toBeInTheDocument();

    fireEvent.click(button);

    expect(screen.queryByRole('menuitem', { name: 'Log out' })).not.toBeInTheDocument();
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  // Esc and outside-click dismissal now come from the native `popover="auto"`
  // element, which jsdom doesn't implement — that coverage lives in the
  // Playwright e2e suite (auth-and-home.spec.ts) where a real browser drives
  // the platform light dismiss.

  it('shows Preferences, Report an issue, and Log out in order when the hamburger is opened', () => {
    renderWithPrefs(<UserMenu />);
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    const items = screen.getAllByRole('menuitem');
    expect(items.map((el) => el.textContent?.trim())).toEqual(['Preferences', 'Report an issue', 'Log out']);
  });

  it('Report an issue links to the GitHub repo and opens in a new tab', () => {
    renderWithPrefs(<UserMenu />);
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    const reportLink = screen.getByRole('menuitem', { name: 'Report an issue' });
    expect(reportLink).toHaveAttribute('href', 'https://github.com/michaelficarra/michael-tcq');
    expect(reportLink).toHaveAttribute('target', '_blank');
    // rel must include noopener to prevent the opened tab from controlling
    // window.opener on this page.
    expect(reportLink.getAttribute('rel')).toMatch(/noopener/);
  });

  it('clicking Preferences opens the Preferences modal and closes the dropdown', () => {
    renderWithPrefs(<UserMenu />);
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));

    fireEvent.click(screen.getByRole('menuitem', { name: 'Preferences' }));

    // The dropdown closes (both menuitems gone)...
    expect(screen.queryByRole('menuitem', { name: 'Preferences' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Log out' })).not.toBeInTheDocument();
    // ...and the preferences modal is not rendered by UserMenu itself — it's
    // mounted at App level. We only assert the dropdown closed here; the
    // modal's own tests cover its open behaviour.
  });
});
