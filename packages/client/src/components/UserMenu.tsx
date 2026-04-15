/**
 * User menu — shows either a Log Out link (real OAuth) or a clickable
 * username that opens a user-switcher input (dev mock auth mode).
 *
 * Used in both the NavBar (meeting page) and the HomePage header.
 */

import { useCallback, useState, type FormEvent } from 'react';
import { useAuth } from '../contexts/AuthContext.js';
import { UserBadge } from './UserBadge.js';

export function UserMenu() {
  const { user, mockAuth, switchUser } = useAuth();

  if (mockAuth && user) {
    return <DevUserSwitcher user={user} switchUser={switchUser} />;
  }

  return (
    <a
      href="/auth/logout"
      className="text-sm text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-300 transition-colors"
    >
      Log Out
    </a>
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
          className="text-sm text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-300 transition-colors cursor-pointer"
          title="Click to switch user (dev mode)"
        >
          <UserBadge user={user} size={20} />
        </button>
        <a href="/auth/logout" className="text-sm text-stone-500 hover:text-stone-700 transition-colors">
          Log Out
        </a>
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
        className="text-sm text-teal-600 dark:text-teal-400 hover:text-teal-800 dark:hover:text-teal-300 font-medium
                   transition-colors disabled:opacity-50 cursor-pointer"
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
