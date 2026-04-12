import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NavBar } from './NavBar.js';

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

  it('renders a Log Out link', () => {
    render(<NavBar activeTab="queue" onTabChange={() => {}} />);
    const logOut = screen.getByText('Log Out');
    expect(logOut).toBeInTheDocument();
    expect(logOut.closest('a')).toHaveAttribute('href', '/auth/logout');
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
