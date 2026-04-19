import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
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

afterEach(() => {
  vi.unstubAllGlobals();
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

describe('PreferencesModal — notifications section', () => {
  function stubNotification(permission: NotificationPermission, requested: NotificationPermission = permission) {
    const ctor = vi.fn();
    vi.stubGlobal(
      'Notification',
      Object.assign(ctor, {
        permission,
        requestPermission: vi.fn(async () => requested),
      }),
    );
    return ctor;
  }

  it('shows the Notifications checkbox unchecked by default', () => {
    stubNotification('default');
    renderWithModal();
    fireEvent.click(screen.getByText('open'));
    const checkbox = screen.getByRole('checkbox', { name: /^Notifications$/ });
    expect(checkbox).not.toBeChecked();
  });

  it('shows sub-toggles as disabled when Notifications is off', () => {
    stubNotification('default');
    renderWithModal();
    fireEvent.click(screen.getByText('open'));
    const subToggle = screen.getByRole('checkbox', { name: 'When your queue entry is next' });
    expect(subToggle).toBeInTheDocument();
    expect(subToggle).toBeDisabled();
  });

  it('enabling Notifications when permission is granted persists and activates sub-toggles', async () => {
    stubNotification('default', 'granted');
    renderWithModal();
    fireEvent.click(screen.getByText('open'));

    const checkbox = screen.getByRole('checkbox', { name: /^Notifications$/ });
    fireEvent.click(checkbox);

    await waitFor(() => expect(checkbox).toBeChecked());
    expect(localStorage.getItem('tcq-notifications-enabled')).toBe('true');
    const subToggle = screen.getByRole('checkbox', { name: 'When your queue entry is next' });
    expect(subToggle).not.toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'When a point of order is raised' })).not.toBeDisabled();
  });

  it('enabling Notifications when permission is denied leaves the toggle off', async () => {
    stubNotification('default', 'denied');
    renderWithModal();
    fireEvent.click(screen.getByText('open'));

    const checkbox = screen.getByRole('checkbox', { name: /^Notifications$/ });
    fireEvent.click(checkbox);

    // Wait a tick for the async permission flow to resolve.
    await waitFor(() => expect(checkbox).not.toBeChecked());
    expect(localStorage.getItem('tcq-notifications-enabled')).toBe('false');
  });

  it('toggling a sub-pref persists to tcq-notification-prefs', async () => {
    stubNotification('granted');
    localStorage.setItem('tcq-notifications-enabled', 'true');
    renderWithModal();
    fireEvent.click(screen.getByText('open'));

    // Point of order defaults to off; check that toggling it on persists.
    const pooCheckbox = screen.getByRole('checkbox', { name: 'When a point of order is raised' });
    expect(pooCheckbox).not.toBeChecked();
    fireEvent.click(pooCheckbox);

    expect(pooCheckbox).toBeChecked();
    const persisted = JSON.parse(localStorage.getItem('tcq-notification-prefs') ?? '{}');
    expect(persisted.onPointOfOrder).toBe(true);
  });

  it('reconciles the top-level preference to off on load when permission was revoked', () => {
    // Previous session: notifications were enabled.
    localStorage.setItem('tcq-notifications-enabled', 'true');
    // Since then, the user revoked permission in browser settings.
    stubNotification('denied');

    renderWithModal();
    fireEvent.click(screen.getByText('open'));

    const checkbox = screen.getByRole('checkbox', { name: /^Notifications$/ });
    expect(checkbox).not.toBeChecked();
    expect(localStorage.getItem('tcq-notifications-enabled')).toBe('false');
  });

  it('leaves the toggle off when permission is already denied and no hint is shown', async () => {
    stubNotification('denied');
    renderWithModal();
    fireEvent.click(screen.getByText('open'));

    const checkbox = screen.getByRole('checkbox', { name: /^Notifications$/ });
    expect(checkbox).not.toBeDisabled();
    // Clicking tries to enable, but permission is already denied, so it stays off.
    fireEvent.click(checkbox);
    await waitFor(() => expect(checkbox).not.toBeChecked());
    expect(screen.queryByText(/Permission blocked/)).not.toBeInTheDocument();
  });
});
