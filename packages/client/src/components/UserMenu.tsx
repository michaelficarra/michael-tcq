/**
 * User menu — shows either a Log Out link (real OAuth) or a clickable
 * username that opens a user-switcher input (dev mock auth mode).
 *
 * Used in both the NavBar (meeting page) and the HomePage header.
 */

import { useRef, useState } from 'react';
import { useAuth } from '../contexts/AuthContext.js';
import { usePreferences } from '../contexts/PreferencesContext.js';
import { usePopover } from '../hooks/usePopover.js';
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
 * beneath it. The dropdown currently holds a single Log Out link. The dropdown
 * is a native `popover="auto"`, so outside-click and Esc dismissal come from
 * the platform; we measure its `top`/`right` in JS since CSS anchor positioning
 * isn't yet in Firefox/Safari.
 */
function HamburgerMenu() {
  const { openPreferences } = usePreferences();
  // Dev (mock-auth) and production (real OAuth) get different icons: a playful
  // 🍔 emoji for local hacking, a conventional three-line SVG for real users.
  const { mockAuth } = useAuth();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  // Inner icon ref — the button stretches to the full nav height so we anchor
  // the dropdown to the emoji's bottom rather than the button's to keep the
  // dropdown close to the visible icon.
  const iconRef = useRef<HTMLSpanElement | null>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const { popoverRef, triggerProps, consumeTriggerClick } = usePopover(open, () => setOpen(false));

  function toggleMenu() {
    // If this click is the tail of the gesture that just light-dismissed the
    // open menu, leave it closed rather than reopen it.
    if (consumeTriggerClick()) {
      setOpen(false);
      return;
    }
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

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={toggleMenu}
        {...triggerProps}
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
      {open && pos && (
        // Native popover: top-layer (escapes the navbar's `overflow-x-auto`
        // clipping and `z-index` cap with no portal) plus platform light
        // dismiss / Esc. Rendered inline so natural tab order flows from the
        // button into the items — no manual Tab routing needed.
        <div
          ref={popoverRef}
          popover="auto"
          role="menu"
          className="tcq-popover fixed min-w-32 rounded border border-stone-200 dark:border-stone-700
                     bg-white dark:bg-stone-800 shadow-lg py-1"
          style={{ top: pos.top, right: pos.right }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              openPreferences();
            }}
            className="block w-full text-left px-3 py-1.5 text-sm text-stone-700 dark:text-stone-200
                       hover:bg-stone-100 dark:hover:bg-stone-700 transition-colors cursor-pointer"
          >
            Preferences
          </button>
          <a
            href="https://github.com/michaelficarra/michael-tcq"
            target="_blank"
            rel="noopener noreferrer"
            role="menuitem"
            // `external-link` appends the NE arrow indicator — see index.css.
            className="external-link block px-3 py-1.5 text-sm text-stone-700 dark:text-stone-200
                       hover:bg-stone-100 dark:hover:bg-stone-700 transition-colors"
          >
            Report an issue
          </a>
          <a
            href="/auth/logout"
            role="menuitem"
            className="block px-3 py-1.5 text-sm text-stone-700 dark:text-stone-200
                       hover:bg-stone-100 dark:hover:bg-stone-700 transition-colors"
          >
            Log out
          </a>
        </div>
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
          className="self-stretch inline-flex items-center text-sm text-stone-600 dark:text-stone-300 hover:text-stone-800 dark:hover:text-stone-100 transition-colors cursor-pointer"
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
        className="text-sm text-stone-600 dark:text-stone-300 hover:text-stone-600 dark:hover:text-stone-300 transition-colors cursor-pointer"
      >
        Cancel
      </button>
    </span>
  );
}
