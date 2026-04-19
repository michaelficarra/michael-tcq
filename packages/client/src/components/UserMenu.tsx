/**
 * User menu — shows either a Log Out link (real OAuth) or a clickable
 * username that opens a user-switcher input (dev mock auth mode).
 *
 * Used in both the NavBar (meeting page) and the HomePage header.
 */

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '../contexts/AuthContext.js';
import { UserBadge } from './UserBadge.js';

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

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={toggleMenu}
        aria-label="Open menu"
        aria-haspopup="menu"
        aria-expanded={open}
        className="group self-stretch inline-flex items-center text-3xl leading-none cursor-pointer"
      >
        <span
          ref={iconRef}
          aria-hidden="true"
          className={`inline-block transition duration-300 ease-out ${
            open ? 'saturate-100' : 'saturate-[.5] group-hover:saturate-100'
          }`}
        >
          🍔
        </span>
      </button>
      {open &&
        pos &&
        createPortal(
          <>
            {/* Invisible backdrop: any click outside the dropdown lands here and closes the menu.
                Sits above the nav (which has `z-50`) so clicks inside the nav bar also dismiss. */}
            <div className="fixed inset-0 z-[60]" onClick={() => setOpen(false)} />
            <div
              role="menu"
              className="fixed z-[70] min-w-32 rounded border border-stone-200 dark:border-stone-700
                         bg-white dark:bg-stone-800 shadow-lg py-1"
              style={{ top: pos.top, right: pos.right }}
            >
              <a
                href="/auth/logout"
                role="menuitem"
                className="block px-3 py-1.5 text-sm text-stone-700 dark:text-stone-200
                           hover:bg-stone-100 dark:hover:bg-stone-700 transition-colors"
              >
                Log Out
              </a>
            </div>
          </>,
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
  const [username, setUsername] = useState('');
  const [switching, setSwitching] = useState(false);

  // Callback ref: focus and select the input text on mount.
  const inputRef = useCallback((node: HTMLInputElement | null) => {
    if (node) {
      node.focus();
      node.select();
    }
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = username.trim();
    if (!trimmed || switching) return;

    setSwitching(true);
    await switchUser(trimmed);
    setSwitching(false);
    setOpen(false);
    setUsername('');
    window.location.reload();
  }

  if (!open) {
    return (
      <span className="inline-flex items-center gap-3">
        <button
          onClick={() => {
            setUsername(user.ghUsername);
            setOpen(true);
          }}
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
    <form onSubmit={handleSubmit} className="flex items-center gap-2">
      <input
        ref={inputRef}
        type="text"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setOpen(false);
            setUsername('');
          }
        }}
        placeholder="username"
        className="border border-stone-300 dark:border-stone-600 rounded px-2 py-0.5 text-sm w-28
                   dark:bg-stone-700 dark:text-stone-100
                   focus:outline-none focus:ring-1 focus:ring-teal-500"
      />
      <button
        type="submit"
        disabled={switching}
        className="text-sm text-teal-600 dark:text-teal-400 enabled:hover:text-teal-800 dark:enabled:hover:text-teal-300 font-medium
                   transition-colors disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
      >
        {switching ? '…' : 'Switch'}
      </button>
      <button
        type="button"
        onClick={() => {
          setOpen(false);
          setUsername('');
        }}
        className="text-sm text-stone-400 dark:text-stone-500 hover:text-stone-600 dark:hover:text-stone-300 transition-colors cursor-pointer"
      >
        Cancel
      </button>
    </form>
  );
}
