import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NavBar } from './NavBar.js';

// Mock useAuth so NavBar can render UserMenu without a real AuthProvider
const mockUseAuth = vi.fn();
vi.mock('../contexts/AuthContext.js', () => ({
  useAuth: () => mockUseAuth(),
}));

beforeEach(() => {
  // Default: real OAuth mode (shows Log Out link)
  mockUseAuth.mockReturnValue({
    user: { ghid: 1, ghUsername: 'alice', name: 'Alice', organisation: '' },
    mockAuth: false,
    switchUser: async () => {},
  });
});

describe('NavBar', () => {
  it('renders TCQ branding', () => {
    render(<NavBar activeTab="queue" onTabChange={() => {}} />);
    expect(screen.getByText('TCQ')).toBeInTheDocument();
  });

  it('renders Agenda and Queue tab buttons', () => {
    render(<NavBar activeTab="queue" onTabChange={() => {}} />);
    expect(screen.getByRole('tab', { name: 'Agenda' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Queue' })).toBeInTheDocument();
  });

  it('marks the active tab as selected', () => {
    render(<NavBar activeTab="agenda" onTabChange={() => {}} />);
    expect(screen.getByRole('tab', { name: 'Agenda' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Queue' })).toHaveAttribute('aria-selected', 'false');
  });

  it('calls onTabChange when a tab is clicked', () => {
    const onTabChange = vi.fn();
    render(<NavBar activeTab="queue" onTabChange={onTabChange} />);

    fireEvent.click(screen.getByRole('tab', { name: 'Agenda' }));
    expect(onTabChange).toHaveBeenCalledWith('agenda');
  });

  it('renders a Log Out link in OAuth mode', () => {
    render(<NavBar activeTab="queue" onTabChange={() => {}} />);
    const logOut = screen.getByText('Log Out');
    expect(logOut).toBeInTheDocument();
    expect(logOut.closest('a')).toHaveAttribute('href', '/auth/logout');
  });

  it('renders the username button in mock auth mode', () => {
    mockUseAuth.mockReturnValue({
      user: { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: '' },
      mockAuth: true,
      switchUser: async () => {},
    });

    render(<NavBar activeTab="queue" onTabChange={() => {}} />);
    expect(screen.getByText('testuser')).toBeInTheDocument();
    expect(screen.queryByText('Log Out')).not.toBeInTheDocument();
  });

  it('has an accessible navigation landmark', () => {
    render(<NavBar activeTab="queue" onTabChange={() => {}} />);
    expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeInTheDocument();
  });

  it('has an accessible tablist', () => {
    render(<NavBar activeTab="queue" onTabChange={() => {}} />);
    expect(screen.getByRole('tablist', { name: 'Meeting views' })).toBeInTheDocument();
  });
});
