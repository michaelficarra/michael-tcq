import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { PreferencesModal } from './PreferencesModal.js';
import { PreferencesProvider, usePreferences } from '../contexts/PreferencesContext.js';

/** Shim to trigger the modal open from inside the provider, mirroring how the
 *  hamburger or the `,` shortcut would open it in the real app. */
function Opener() {
  const { openPreferences } = usePreferences();
  return <button onClick={openPreferences}>open</button>;
}

function renderWithModal() {
  return render(
    <PreferencesProvider>
      <Opener />
      <PreferencesModal />
    </PreferencesProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove('dark');
});

describe('PreferencesModal', () => {
  it('does not render until opened', () => {
    renderWithModal();
    expect(screen.queryByRole('dialog', { name: 'Preferences' })).not.toBeInTheDocument();
  });

  it('renders when opened', () => {
    renderWithModal();
    fireEvent.click(screen.getByText('open'));
    expect(screen.getByRole('dialog', { name: 'Preferences' })).toBeInTheDocument();
  });

  it('toggling the shortcuts checkbox persists to localStorage', () => {
    renderWithModal();
    fireEvent.click(screen.getByText('open'));
    const checkbox = screen.getByRole('checkbox', { name: /Keyboard shortcuts/ });
    expect(checkbox).toBeChecked();

    fireEvent.click(checkbox);

    expect(checkbox).not.toBeChecked();
    expect(localStorage.getItem('tcq-keyboard-shortcuts-enabled')).toBe('false');
  });

  it('selecting Dark theme persists and adds the dark class to <html>', () => {
    renderWithModal();
    fireEvent.click(screen.getByText('open'));

    fireEvent.change(screen.getByRole('combobox', { name: /Colour scheme/ }), { target: { value: 'dark' } });

    expect(localStorage.getItem('tcq-theme-preference')).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('selecting Light theme persists and removes the dark class from <html>', () => {
    document.documentElement.classList.add('dark');
    renderWithModal();
    fireEvent.click(screen.getByText('open'));

    fireEvent.change(screen.getByRole('combobox', { name: /Colour scheme/ }), { target: { value: 'light' } });

    expect(localStorage.getItem('tcq-theme-preference')).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('Escape dismisses the modal', () => {
    renderWithModal();
    fireEvent.click(screen.getByText('open'));
    expect(screen.getByRole('dialog', { name: 'Preferences' })).toBeInTheDocument();

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });

    expect(screen.queryByRole('dialog', { name: 'Preferences' })).not.toBeInTheDocument();
  });

  it('clicking the backdrop dismisses the modal', () => {
    renderWithModal();
    fireEvent.click(screen.getByText('open'));
    const dialog = screen.getByRole('dialog', { name: 'Preferences' });

    fireEvent.click(dialog);

    expect(screen.queryByRole('dialog', { name: 'Preferences' })).not.toBeInTheDocument();
  });

  it('clicking inside the dialog box does not dismiss it', () => {
    renderWithModal();
    fireEvent.click(screen.getByText('open'));

    // Click on the heading (inside the inner box) — propagation is stopped.
    fireEvent.click(screen.getByRole('heading', { name: 'Preferences' }));

    expect(screen.getByRole('dialog', { name: 'Preferences' })).toBeInTheDocument();
  });

  it('clicking the close X button dismisses the modal', () => {
    renderWithModal();
    fireEvent.click(screen.getByText('open'));

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(screen.queryByRole('dialog', { name: 'Preferences' })).not.toBeInTheDocument();
  });
});
