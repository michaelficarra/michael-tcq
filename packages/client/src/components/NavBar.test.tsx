import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { NavBar } from './NavBar.js';
import { PreferencesProvider } from '../contexts/PreferencesContext.js';

// Mock useAuth so NavBar can render UserMenu without a real AuthProvider
const mockUseAuth = vi.fn();
vi.mock('../contexts/AuthContext.js', () => ({
  useAuth: () => mockUseAuth(),
}));

/** Render NavBar with the providers it depends on transitively (UserMenu reads from PreferencesContext). */
function renderNav(ui: ReactElement) {
  return render(
    <PreferencesProvider>
      <MemoryRouter>{ui}</MemoryRouter>
    </PreferencesProvider>,
  );
}

beforeEach(() => {
  // Default: real OAuth mode (shows Log out link)
  mockUseAuth.mockReturnValue({
    user: {
      provider: 'github',
      accountId: 'alice',
      handle: 'alice',
      name: 'Alice',
      organisation: '',
      avatarUrl: 'https://github.com/alice.png?size=80',
    },
    mockAuth: false,
    switchUser: async () => {},
  });
});

describe('NavBar', () => {
  it('renders TCQ branding', () => {
    renderNav(<NavBar activeTab="queue" onTabChange={() => {}} />);
    expect(screen.getByText('TCQ')).toBeInTheDocument();
  });

  it('renders Agenda, Queue, and Help tab buttons', () => {
    renderNav(<NavBar activeTab="queue" onTabChange={() => {}} />);
    expect(screen.getByRole('tab', { name: 'Agenda' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Queue' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Help' })).toBeInTheDocument();
  });

  it('marks the active tab as selected', () => {
    renderNav(<NavBar activeTab="agenda" onTabChange={() => {}} />);
    expect(screen.getByRole('tab', { name: 'Agenda' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Queue' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tab', { name: 'Help' })).toHaveAttribute('aria-selected', 'false');
  });

  it('calls onTabChange when a tab is clicked', () => {
    const onTabChange = vi.fn();
    renderNav(<NavBar activeTab="queue" onTabChange={onTabChange} />);

    fireEvent.click(screen.getByRole('tab', { name: 'Agenda' }));
    expect(onTabChange).toHaveBeenCalledWith('agenda');
  });

  it('exposes a Log out link via the hamburger menu in OAuth mode', () => {
    renderNav(<NavBar activeTab="queue" onTabChange={() => {}} />);
    // The Log out link lives behind a hamburger dropdown; open it first.
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    const logOut = screen.getByRole('menuitem', { name: 'Log out' });
    expect(logOut).toHaveAttribute('href', '/auth/logout');
  });

  it('renders the username button and hamburger menu in mock auth mode', () => {
    mockUseAuth.mockReturnValue({
      user: {
        provider: 'github',
        accountId: 'testuser',
        handle: 'testuser',
        name: 'Test User',
        organisation: '',
        avatarUrl: 'https://github.com/testuser.png?size=80',
      },
      mockAuth: true,
      switchUser: async () => {},
    });

    renderNav(<NavBar activeTab="queue" onTabChange={() => {}} />);
    // UserBadge displays user.name, not ghUsername
    expect(screen.getByText('Test User')).toBeInTheDocument();
    // The hamburger is rendered alongside the user-switcher button; Log out appears once it's clicked.
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    expect(screen.getByRole('menuitem', { name: 'Log out' })).toHaveAttribute('href', '/auth/logout');
  });

  it('has an accessible navigation landmark', () => {
    renderNav(<NavBar activeTab="queue" onTabChange={() => {}} />);
    expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeInTheDocument();
  });

  it('links the TCQ logo to the home page', () => {
    renderNav(<NavBar activeTab="queue" onTabChange={() => {}} />);
    const logo = screen.getByText('TCQ');
    expect(logo.closest('a')).toHaveAttribute('href', '/');
  });

  it('has an accessible tablist', () => {
    renderNav(<NavBar activeTab="queue" onTabChange={() => {}} />);
    expect(screen.getByRole('tablist', { name: 'Meeting views' })).toBeInTheDocument();
  });

  it('renders the sliding underline as a decorative, aria-hidden element', () => {
    renderNav(<NavBar activeTab="queue" onTabChange={() => {}} />);
    // The underline is purely visual; aria-selected on the tabs is the real cue, so the
    // indicator must be hidden from assistive tech.
    const tablist = screen.getByRole('tablist', { name: 'Meeting views' });
    const indicator = tablist.querySelector('[aria-hidden="true"]');
    expect(indicator).toBeInTheDocument();
  });
});
