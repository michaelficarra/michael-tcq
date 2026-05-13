/**
 * User menu — shows either a Log Out link (real OAuth) or a clickable
 * username that opens a user-switcher input (dev mock auth mode).
 *
 * Used in both the NavBar (meeting page) and the HomePage header.
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '../contexts/AuthContext.js';
import { usePreferences } from '../contexts/PreferencesContext.js';
import { UserBadge } from './UserBadge.js';
import { UserCombobox } from './UserCombobox.js';

export function UserMenu() {
  const { user, mockAuth, switchUser } = useAuth();

  if (mockAuth && user) {
    return <DevUserSwitcher user={user} switchUser={switchUser} />;
  }

  return (
    <span className="inline-flex items-center gap-3">
      {user && (
        <span className="text-sm text-stone-500 dark:text-stone-400">
          <UserBadge user={user} size={20} />
        </span>
      )}
      <HamburgerMenu />
    </span>
  );
}

// -- Hamburger dropdown with the Log Out action --

/**
 * Renders a hamburger icon button that opens a small dropdown anchored
 * beneath it. The dropdown currently holds a single Log Out link. Clicking
 * outside the dropdown or pressing Escape dismisses it.
 */
function HamburgerMenu() {
  const { openPreferences } = usePreferences();
  // Dev (mock-auth) and production (real OAuth) get different icons: a playful
  // 🍔 emoji for local hacking, a conventional three-line SVG for real users.
  const { mockAuth } = useAuth();
  const [open, setOpen] = useState(false);
  // The nav has `overflow-x-auto` (which clips descendants) and `sticky + z-50`
  // (which creates a stacking context that caps descendant z-indices). Render
  // the dropdown into a portal on <body> with measured fixed coordinates so it
  // escapes both.
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  // Inner icon ref — the button stretches to the full nav height so we anchor
  // the dropdown to the emoji's bottom rather than the button's to keep the
  // dropdown close to the visible icon.
  const iconRef = useRef<HTMLSpanElement | null>(null);
  // Menu item refs — since the dropdown is portaled to <body>, natural tab
  // order skips past it. We route Tab from the button through the items
  // manually so Preferences → Report an issue → Log out → button forms a cycle.
  const prefsItemRef = useRef<HTMLButtonElement | null>(null);
  const reportItemRef = useRef<HTMLAnchorElement | null>(null);
  const logoutItemRef = useRef<HTMLAnchorElement | null>(null);
  // Dropdown container ref for outside-click detection.
  const dropdownRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

  function toggleMenu() {
    if (open) {
      setOpen(false);
      return;
    }
    const iconRect = iconRef.current?.getBoundingClientRect();
    const buttonRect = buttonRef.current?.getBoundingClientRect();
    if (!iconRect || !buttonRect) return;
    setPos({ top: iconRect.bottom + 8, right: window.innerWidth - buttonRect.right });
    setOpen(true);
  }

  // Dismiss the menu when the user presses Escape anywhere in the document.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // Dismiss on pointerdown anywhere outside the button or dropdown. Using
  // pointerdown (rather than a blocking overlay) lets the same gesture both
  // close the menu and reach the underlying element — e.g. clicking a tab
  // switches tabs and dismisses the menu in one click.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node | null;
      if (!target) return;
      if (buttonRef.current?.contains(target)) return;
      if (dropdownRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={toggleMenu}
        onKeyDown={(e) => {
          // When the menu is open, Tab should route into the dropdown (which
          // lives in a body-level portal and is otherwise skipped).
          if (open && e.key === 'Tab' && !e.shiftKey) {
            e.preventDefault();
            prefsItemRef.current?.focus();
          }
        }}
        aria-label="Open menu"
        aria-haspopup="menu"
        aria-expanded={open}
        className="group self-stretch inline-flex items-center text-3xl leading-none cursor-pointer"
      >
        {mockAuth ? (
          <span
            ref={iconRef}
            aria-hidden="true"
            className={`inline-block transition duration-300 ease-out ${
              open ? 'saturate-100' : 'saturate-[.5] group-hover:saturate-100'
            }`}
          >
            🍔
          </span>
        ) : (
          <span
            ref={iconRef}
            aria-hidden="true"
            className={`inline-flex items-center transition-colors duration-200 ease-out ${
              open
                ? 'text-teal-500 dark:text-teal-400'
                : 'text-stone-500 dark:text-stone-400 group-hover:text-stone-900 dark:group-hover:text-stone-100'
            }`}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              className="h-7 w-7"
            >
              <line x1="4" y1="7" x2="20" y2="7" />
              <line x1="4" y1="12" x2="20" y2="12" />
              <line x1="4" y1="17" x2="20" y2="17" />
            </svg>
          </span>
        )}
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={dropdownRef}
            role="menu"
            className="fixed z-[70] min-w-32 rounded border border-stone-200 dark:border-stone-700
                       bg-white dark:bg-stone-800 shadow-lg py-1"
            style={{ top: pos.top, right: pos.right }}
          >
            <button
              ref={prefsItemRef}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                openPreferences();
              }}
              onKeyDown={(e) => {
                // Tab → Report an issue (next item); Shift+Tab → trigger button.
                if (e.key === 'Tab') {
                  e.preventDefault();
                  if (e.shiftKey) buttonRef.current?.focus();
                  else reportItemRef.current?.focus();
                }
              }}
              className="block w-full text-left px-3 py-1.5 text-sm text-stone-700 dark:text-stone-200
                         hover:bg-stone-100 dark:hover:bg-stone-700 transition-colors cursor-pointer"
            >
              Preferences
            </button>
            <a
              ref={reportItemRef}
              href="https://github.com/michaelficarra/michael-tcq"
              target="_blank"
              rel="noopener noreferrer"
              role="menuitem"
              onKeyDown={(e) => {
                // Tab → Log Out; Shift+Tab → Preferences.
                if (e.key === 'Tab') {
                  e.preventDefault();
                  if (e.shiftKey) prefsItemRef.current?.focus();
                  else logoutItemRef.current?.focus();
                }
              }}
              // `external-link` appends the NE arrow indicator — see index.css.
              className="external-link block px-3 py-1.5 text-sm text-stone-700 dark:text-stone-200
                         hover:bg-stone-100 dark:hover:bg-stone-700 transition-colors"
            >
              Report an issue
            </a>
            <a
              ref={logoutItemRef}
              href="/auth/logout"
              role="menuitem"
              onKeyDown={(e) => {
                // Tab → cycle back to trigger button; Shift+Tab → Report an issue.
                if (e.key === 'Tab') {
                  e.preventDefault();
                  if (e.shiftKey) reportItemRef.current?.focus();
                  else buttonRef.current?.focus();
                }
              }}
              className="block px-3 py-1.5 text-sm text-stone-700 dark:text-stone-200
                         hover:bg-stone-100 dark:hover:bg-stone-700 transition-colors"
            >
              Log out
            </a>
          </div>,
          document.body,
        )}
    </>
  );
}

// -- Dev user-switcher --

interface DevUserSwitcherProps {
  user: import('@tcq/shared').User;
  switchUser: (username: string) => Promise<void>;
}

/**
 * In dev mode, shows the current user's avatar and name as a clickable
 * button. Clicking it reveals an input to switch to a different mock user.
 */
function DevUserSwitcher({ user, switchUser }: DevUserSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);

  async function handleCommit(username: string) {
    if (!username || switching) return;
    setSwitching(true);
    await switchUser(username);
    setSwitching(false);
    setOpen(false);
  }

  if (!open) {
    return (
      <span className="inline-flex items-center gap-3">
        <button
          onClick={() => setOpen(true)}
          className="self-stretch inline-flex items-center text-sm text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-300 transition-colors cursor-pointer"
          title="Click to switch user (dev mode)"
        >
          <UserBadge user={user} size={20} />
        </button>
        <HamburgerMenu />
      </span>
    );
  }

  return (
    <span className="flex items-center gap-2">
      <UserCombobox
        mode="single"
        autoFocus
        disabled={switching}
        initialValue={user.ghUsername}
        placeholder="username"
        ariaLabel="Switch to GitHub username"
        onCommit={handleCommit}
        onCancel={() => setOpen(false)}
        inputClassName="border border-stone-300 dark:border-stone-600 rounded px-2 py-0.5 text-sm w-32
                        dark:bg-stone-700 dark:text-stone-100
                        focus:outline-none focus:ring-1 focus:ring-teal-500"
      />
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="text-sm text-stone-400 dark:text-stone-500 hover:text-stone-600 dark:hover:text-stone-300 transition-colors cursor-pointer"
      >
        Cancel
      </button>
    </span>
  );
}
