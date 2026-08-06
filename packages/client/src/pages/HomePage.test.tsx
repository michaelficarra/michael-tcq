import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { User } from '@tcq/shared';
import { HomePage } from './HomePage.js';
import { PreferencesProvider } from '../contexts/PreferencesContext.js';
import { ToastProvider } from '../contexts/ToastContext.js';

// -- Mocks --

const adminUser: User = {
  provider: 'github',
  accountId: 'admin',
  handle: 'admin',
  name: 'Admin',
  organisation: 'ACME',
  avatarUrl: 'https://github.com/admin.png?size=80',
};

// Mutable mock auth state so tests can toggle isAdmin per case.
const mockAuthState = {
  user: adminUser as User | null,
  isAdmin: true,
  loading: false,
  mockAuth: false,
  switchUser: async () => {},
};

vi.mock('../contexts/AuthContext.js', () => ({
  useAuth: () => mockAuthState,
}));

// AdminPanel and DiagnosticsPanel both poll real endpoints — stub them out so
// the tests stay focused on tab/hash behaviour rather than fetch plumbing.
vi.mock('../components/AdminPanel.js', () => ({
  AdminPanel: () => <h2>Active Meetings</h2>,
}));
vi.mock('../components/DiagnosticsPanel.js', () => ({
  DiagnosticsPanel: () => <h2>Diagnostics</h2>,
}));

// -- Render helper --

function renderHomePage(hash = '') {
  window.location.hash = hash;
  return render(
    <PreferencesProvider>
      <ToastProvider>
        <MemoryRouter>
          <HomePage />
        </MemoryRouter>
      </ToastProvider>
    </PreferencesProvider>,
  );
}

// -- Tests --

let savedHash: string;

beforeEach(() => {
  savedHash = window.location.hash;
  // Default: admin user. Individual tests override as needed.
  mockAuthState.user = adminUser;
  mockAuthState.isAdmin = true;
});

afterEach(() => {
  window.location.hash = savedHash;
});

describe('HomePage tab–hash sync', () => {
  describe('initial tab from hash', () => {
    it('defaults to the Join Meeting tab when there is no hash', () => {
      renderHomePage();
      expect(screen.getByRole('tab', { name: 'Join Meeting' })).toHaveAttribute('aria-selected', 'true');
    });

    it('selects the Join Meeting tab when hash is #join', () => {
      renderHomePage('#join');
      expect(screen.getByRole('tab', { name: 'Join Meeting' })).toHaveAttribute('aria-selected', 'true');
    });

    it('selects the Admin tab when hash is #admin (admin user)', () => {
      renderHomePage('#admin');
      expect(screen.getByRole('tab', { name: 'Admin' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByRole('tab', { name: 'Join Meeting' })).toHaveAttribute('aria-selected', 'false');
    });

    it('selects the Help tab when hash is #help', () => {
      renderHomePage('#help');
      expect(screen.getByRole('tab', { name: 'Help' })).toHaveAttribute('aria-selected', 'true');
    });

    it('falls back to Join Meeting for an invalid hash', () => {
      renderHomePage('#nonsense');
      expect(screen.getByRole('tab', { name: 'Join Meeting' })).toHaveAttribute('aria-selected', 'true');
    });
  });

  describe('sliding underline', () => {
    it('renders the active-tab underline as a decorative, aria-hidden element', () => {
      renderHomePage();
      // The underline is purely visual; aria-selected on the tabs is the real cue, so the
      // indicator must be hidden from assistive tech.
      const tablist = screen.getByRole('tablist', { name: 'Home views' });
      expect(tablist.querySelector('[aria-hidden="true"]')).toBeInTheDocument();
    });
  });

  describe('tab change updates hash', () => {
    it('updates the hash when the Help tab is clicked', () => {
      renderHomePage();
      fireEvent.click(screen.getByRole('tab', { name: 'Help' }));
      expect(window.location.hash).toBe('#help');
    });

    it('updates the hash when the Admin tab is clicked', () => {
      renderHomePage();
      fireEvent.click(screen.getByRole('tab', { name: 'Admin' }));
      expect(window.location.hash).toBe('#admin');
    });

    it('updates the hash for each successive tab click', () => {
      renderHomePage();
      fireEvent.click(screen.getByRole('tab', { name: 'Admin' }));
      expect(window.location.hash).toBe('#admin');

      fireEvent.click(screen.getByRole('tab', { name: 'Help' }));
      expect(window.location.hash).toBe('#help');

      fireEvent.click(screen.getByRole('tab', { name: 'Join Meeting' }));
      expect(window.location.hash).toBe('#join');
    });
  });

  describe('hashchange updates the active tab', () => {
    it('switches tab when the hash changes externally', () => {
      renderHomePage('#join');
      expect(screen.getByRole('tab', { name: 'Join Meeting' })).toHaveAttribute('aria-selected', 'true');

      act(() => {
        window.location.hash = '#help';
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      });

      expect(screen.getByRole('tab', { name: 'Help' })).toHaveAttribute('aria-selected', 'true');
    });

    it('ignores invalid hash values', () => {
      renderHomePage('#join');

      act(() => {
        window.location.hash = '#invalid';
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      });

      expect(screen.getByRole('tab', { name: 'Join Meeting' })).toHaveAttribute('aria-selected', 'true');
    });
  });

  describe('admin gating', () => {
    it('hides the Admin tab button for non-admin users', () => {
      mockAuthState.isAdmin = false;
      renderHomePage();
      expect(screen.queryByRole('tab', { name: 'Admin' })).toBeNull();
      expect(screen.getByRole('tab', { name: 'Join Meeting' })).toBeVisible();
      expect(screen.getByRole('tab', { name: 'Help' })).toBeVisible();
    });

    it('falls back to Join Meeting when a non-admin loads /#admin', () => {
      mockAuthState.isAdmin = false;
      renderHomePage('#admin');
      // The Admin tab button isn't even in the DOM, and Join Meeting is selected.
      expect(screen.queryByRole('tab', { name: 'Admin' })).toBeNull();
      expect(screen.getByRole('tab', { name: 'Join Meeting' })).toHaveAttribute('aria-selected', 'true');
      // The hash is left as-is on initial mount — the visible view falls back
      // to Join, but the URL is not rewritten until a tab change actually
      // happens.
      expect(window.location.hash).toBe('#admin');
    });

    it('rewrites the hash to #join when a non-admin triggers an in-session #admin hashchange', () => {
      // Regression: visibleTab stays 'join' across the change, so depending on
      // visibleTab alone wouldn't re-run the sync effect — activeTab dep covers it.
      mockAuthState.isAdmin = false;
      renderHomePage('#join');
      // Initial mount doesn't write the hash, but the inbound `#join` is
      // already correct.
      expect(window.location.hash).toBe('#join');

      act(() => {
        window.location.hash = '#admin';
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      });

      // Still on Join (non-admin can't see Admin), and the URL is rewritten
      // back — the in-session hashchange triggers a state update, which is
      // not the first render and so the sync effect does run.
      expect(screen.getByRole('tab', { name: 'Join Meeting' })).toHaveAttribute('aria-selected', 'true');
      expect(window.location.hash).toBe('#join');
    });
  });
});

describe('HomePage keyboard shortcuts', () => {
  /** Dispatch a keydown on the window, where the shortcut listener lives. */
  function pressKey(key: string) {
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    });
  }

  it('opens the shortcuts dialogue on "?"', () => {
    renderHomePage();

    pressKey('?');

    // Scoped by accessible name: the Help tab's prose also mentions shortcuts.
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
  });

  /** The kbd/description pairs listed in the shortcuts dialogue, in order. */
  function listedShortcuts(): [string, string][] {
    const rows = screen.getByRole('dialog', { name: 'Keyboard shortcuts' }).querySelectorAll('tr');
    return [...rows]
      .filter((row) => row.querySelector('kbd'))
      .map((row) => [row.querySelector('kbd')!.textContent!, row.querySelectorAll('td')[1].textContent!]);
  }

  it('lists the tab shortcuts followed by the General group', () => {
    renderHomePage();
    pressKey('?');

    expect(listedShortcuts()).toEqual([
      ['1', 'Switch to Join Meeting tab'],
      ['2', 'Switch to Admin tab'],
      ['3', 'Switch to Help tab'],
      ['?', 'Toggle shortcuts dialogue'],
      [',', 'Toggle preferences dialogue'],
    ]);
  });

  // Anti-drift: derived from the nav that's actually rendered rather than from
  // a hardcoded list, so a new or re-gated tab that the dialogue doesn't learn
  // about fails here instead of shipping a stale help dialogue.
  describe.each([
    ['an admin', true],
    ['a non-admin', false],
  ])('for %s, the dialogue matches the rendered nav', (_role, isAdmin) => {
    it('lists one numbered shortcut per tab, in nav order, labelled to match', () => {
      mockAuthState.isAdmin = isAdmin;
      renderHomePage();
      const navTabs = screen.getAllByRole('tab').map((tab) => tab.textContent);
      pressKey('?');

      const numbered = listedShortcuts().filter(([key]) => /^\d$/.test(key));

      expect(numbered).toEqual(navTabs.map((label, index) => [String(index + 1), `Switch to ${label} tab`]));
    });
  });

  describe('tab selection by position', () => {
    it('maps 1/2/3 to Join/Admin/Help for an admin', () => {
      renderHomePage();

      pressKey('2');
      expect(screen.getByRole('tab', { name: 'Admin' })).toHaveAttribute('aria-selected', 'true');

      pressKey('3');
      expect(screen.getByRole('tab', { name: 'Help' })).toHaveAttribute('aria-selected', 'true');

      pressKey('1');
      expect(screen.getByRole('tab', { name: 'Join Meeting' })).toHaveAttribute('aria-selected', 'true');
    });

    it('maps 2 to Help for a non-admin, who has no Admin tab', () => {
      mockAuthState.isAdmin = false;
      renderHomePage();

      pressKey('2');

      // Positional, not by identity: the second visible tab is Help.
      expect(screen.getByRole('tab', { name: 'Help' })).toHaveAttribute('aria-selected', 'true');
    });

    it('leaves 3 unbound for a non-admin, who has only two tabs', () => {
      mockAuthState.isAdmin = false;
      renderHomePage();
      // Move off the default tab first, so a passing assertion below can't be
      // explained by 'join' simply never having changed.
      pressKey('2');
      expect(screen.getByRole('tab', { name: 'Help' })).toHaveAttribute('aria-selected', 'true');

      pressKey('3');

      expect(screen.getByRole('tab', { name: 'Help' })).toHaveAttribute('aria-selected', 'true');
      // Not merely inert — the key isn't advertised in the dialogue either.
      pressKey('?');
      expect(listedShortcuts().map(([key]) => key)).toEqual(['1', '2', '?', ',']);
    });

    it('describes 2 as Help for a non-admin', () => {
      mockAuthState.isAdmin = false;
      renderHomePage();
      pressKey('?');

      expect(listedShortcuts()).toContainEqual(['2', 'Switch to Help tab']);
    });
  });
});
