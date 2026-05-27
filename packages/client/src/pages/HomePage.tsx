/**
 * Home page — shown when the user is not in a meeting.
 *
 * Tabs:
 * - "Join Meeting" — cards for joining or creating a meeting.
 * - "Admin" — active-meetings list and server diagnostics. Only rendered for admin users.
 * - "Help" — usage guide (shared HelpPanel component).
 */

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.js';
import { useToast } from '../contexts/ToastContext.js';
import { AdminPanel } from '../components/AdminPanel.js';
import { DiagnosticsPanel } from '../components/DiagnosticsPanel.js';
import { PremiumUsersPanel } from '../components/PremiumUsersPanel.js';
import { HelpPanel } from '../components/HelpPanel.js';
import { Logo } from '../components/Logo.js';
import { MyMeetingsPanel } from '../components/MyMeetingsPanel.js';
import { UserMenu } from '../components/UserMenu.js';
import { useSlidingTabUnderline } from '../hooks/useSlidingTabUnderline.js';
import { inputValidation } from '../lib/inputStyles.js';

type HomeTab = 'join' | 'admin' | 'help';
const HOME_TABS: readonly HomeTab[] = ['join', 'admin', 'help'];

/**
 * One tab in the home-page nav. Anchor-based so middle-click and modifier-
 * click hand off to the browser (open in new tab/window); plain left-click
 * is intercepted to drive the SPA tab state.
 */
function HomeTabLink({
  tab,
  visibleTab,
  setActiveTab,
  label,
  onSpanRef,
}: {
  tab: HomeTab;
  visibleTab: HomeTab;
  setActiveTab: (tab: HomeTab) => void;
  label: string;
  // Registers the inner <span> so the nav can measure it for the sliding underline.
  onSpanRef?: (el: HTMLElement | null) => void;
}) {
  const isActive = visibleTab === tab;
  return (
    <a
      role="tab"
      href={`#${tab}`}
      aria-selected={isActive}
      className={`group flex items-center py-3 text-base font-medium cursor-pointer transition-colors ${
        isActive
          ? 'text-stone-900 dark:text-stone-100'
          : 'text-stone-600 dark:text-stone-300 hover:text-stone-800 dark:hover:text-stone-100'
      }`}
      onClick={(e) => {
        // Modifier-clicks fall through so the browser opens a new tab/window;
        // middle-click fires `auxclick`, not `click`, and is handled natively.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        setActiveTab(tab);
      }}
    >
      {/*
        The active tab's teal underline is drawn by the single sliding indicator in the nav
        (so it can animate between tabs), not by this border. All tabs keep a transparent
        border-b-2 to reserve the space and to host the faint hover hint on inactive tabs.
      */}
      <span
        ref={onSpanRef}
        className={`pb-1 border-b-2 transition-colors ${
          isActive
            ? 'border-transparent'
            : 'border-transparent group-hover:border-stone-300 dark:group-hover:border-stone-600'
        }`}
      >
        {label}
      </span>
    </a>
  );
}

export function HomePage() {
  const { isAdmin } = useAuth();
  // Initialise from the URL fragment so /#admin or /#help link directly into
  // a tab. Falls through to 'join' for missing/invalid hashes.
  const [activeTab, setActiveTab] = useState<HomeTab>(() => {
    const hash = window.location.hash.slice(1);
    return HOME_TABS.includes(hash as HomeTab) ? (hash as HomeTab) : 'join';
  });

  // The Admin tab is admin-gated. Derive the displayed tab so that if the user
  // loses admin access while parked on Admin (e.g. via the dev user-switcher),
  // they fall back to Join without us needing a state-sync effect (which would
  // trip `react-hooks/set-state-in-effect`).
  const visibleTab = activeTab === 'admin' && !isAdmin ? 'join' : activeTab;

  // Sliding teal underline that tracks the visible tab. The Admin tab is
  // conditionally rendered, so the hook's ResizeObserver repositions the
  // underline when it appears/disappears and shifts the other tabs.
  const { tablistRef, registerTab, indicator } = useSlidingTabUnderline(visibleTab);

  // Sync the *visible* tab to the URL fragment, but only when activeTab
  // actually changes — not on initial mount. Mounting at a hashless `/`
  // should leave it as `/` (the visible default tab is still 'join');
  // rewriting it on mount creates a brief `/` → `/#join` history flicker
  // that races Playwright's `waitForURL('/')` in Firefox. We compare the
  // current activeTab against a ref of the last value we synced from, so
  // StrictMode's double-invoke of effects in dev is also a no-op (the ref
  // and the current value match the second time round). An in-session
  // hashchange to #admin by a non-admin still flips activeTab and trips
  // the comparison, so the URL gets corrected back to #join.
  const prevActiveTabRef = useRef<HomeTab>(activeTab);
  useEffect(() => {
    if (prevActiveTabRef.current === activeTab) return;
    prevActiveTabRef.current = activeTab;
    window.history.replaceState(null, '', `#${visibleTab}`);
  }, [activeTab, visibleTab]);

  // Listen for hashchange events so browser back/forward updates the tab.
  useEffect(() => {
    function handleHashChange() {
      const hash = window.location.hash.slice(1);
      if (HOME_TABS.includes(hash as HomeTab)) {
        setActiveTab(hash as HomeTab);
      }
    }
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  return (
    <div className="h-dvh flex flex-col bg-stone-50 dark:bg-stone-900 text-stone-900 dark:text-stone-100">
      <nav
        className="scrollbar-hide shrink-0 z-50 flex items-stretch gap-3 sm:gap-6 border-b border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 px-3 sm:px-6 overflow-x-auto shadow-md"
        aria-label="Main navigation"
      >
        {/* Branding */}
        <span className="shrink-0 flex items-center py-3">
          <Logo />
        </span>

        {/* Tab toggles. Rendered as <a> so middle/modifier-click open in a new
            tab; left-click is intercepted to drive the SPA tab state. The active
            tab has a teal underline that slides between tabs. */}
        <div
          ref={tablistRef}
          className="relative flex shrink-0 items-stretch gap-4"
          role="tablist"
          aria-label="Home views"
        >
          <HomeTabLink
            tab="join"
            visibleTab={visibleTab}
            setActiveTab={setActiveTab}
            label="Join Meeting"
            onSpanRef={registerTab('join')}
          />
          {isAdmin && (
            <HomeTabLink
              tab="admin"
              visibleTab={visibleTab}
              setActiveTab={setActiveTab}
              label="Admin"
              onSpanRef={registerTab('admin')}
            />
          )}
          <HomeTabLink
            tab="help"
            visibleTab={visibleTab}
            setActiveTab={setActiveTab}
            label="Help"
            onSpanRef={registerTab('help')}
          />
          {/* Decorative sliding underline tracking the active tab. */}
          {indicator}
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* User menu */}
        <div className="shrink-0 flex items-stretch">
          <UserMenu />
        </div>
      </nav>

      <main className="flex-1 overflow-y-auto min-h-0">
        {visibleTab === 'join' && <JoinTab />}
        {visibleTab === 'admin' && <AdminTab />}
        {visibleTab === 'help' && <HelpPanel showChairHelp={true} />}
      </main>
    </div>
  );
}

// -- Join tab (cards) --

function JoinTab() {
  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-4">
        <JoinMeetingCard />
        <NewMeetingCard />
      </div>
      <MyMeetingsPanel />
    </div>
  );
}

// -- Admin tab (active meetings + diagnostics) --

function AdminTab() {
  return (
    <div className="p-6 max-w-3xl mx-auto">
      <AdminSection />
    </div>
  );
}

// -- Admin section (owns the shared refresh timer) --

/**
 * Wraps the two admin panels and drives both of their refreshes from a
 * single setInterval, so the meetings list and the diagnostics snapshot
 * fetch on exactly the same tick rather than on two independent timers
 * that happen to share a cadence.
 */
function AdminSection() {
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setRefreshTick((t) => t + 1);
    }, 10_000);
    return () => clearInterval(interval);
  }, []);

  return (
    <>
      <AdminPanel refreshTick={refreshTick} />
      <PremiumUsersPanel refreshTick={refreshTick} />
      <DiagnosticsPanel refreshTick={refreshTick} />
    </>
  );
}

// -- Join Meeting card --

function JoinMeetingCard() {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [meetingId, setMeetingId] = useState('');

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();

    const trimmed = meetingId.trim();
    if (!trimmed) return;

    // Check the meeting exists before navigating
    const res = await fetch(`/api/meetings/${encodeURIComponent(trimmed)}`);
    if (!res.ok) {
      showToast({ message: 'Meeting not found' });
      return;
    }

    navigate(`/meeting/${encodeURIComponent(trimmed)}`);
  }

  return (
    <div className="bg-white dark:bg-stone-800 rounded-lg shadow-sm border border-stone-200 dark:border-stone-700 p-6">
      <h2 className="text-lg font-semibold text-stone-800 dark:text-stone-200 mb-4">Join Meeting</h2>

      <form onSubmit={handleSubmit}>
        <label htmlFor="meeting-id" className="block text-sm font-medium text-stone-700 dark:text-stone-300 mb-1">
          Meeting ID
        </label>
        <input
          id="meeting-id"
          type="text"
          value={meetingId}
          onChange={(e) => setMeetingId(e.target.value)}
          placeholder="e.g. bright-pine-lake"
          required
          className={`w-full border border-stone-300 dark:border-stone-600 rounded px-3 py-2 text-sm mb-1
                     bg-white dark:bg-stone-700 text-stone-900 dark:text-stone-100
                     focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500 ${inputValidation}`}
        />

        <button
          type="submit"
          className="mt-2 bg-teal-700 text-white px-4 py-2 rounded text-sm font-medium
                     hover:bg-teal-800 transition-colors cursor-pointer
                     focus:outline-none focus:ring-2 focus:ring-teal-500 focus:ring-offset-2 dark:focus:ring-offset-stone-800"
        >
          Join
        </button>
      </form>
    </div>
  );
}

// -- New Meeting card --

function NewMeetingCard() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { showToast } = useToast();
  const [loading, setLoading] = useState(false);

  /** Create a new meeting with the current user as the only chair. */
  async function handleCreate() {
    if (!user) return;
    setLoading(true);

    try {
      const res = await fetch('/api/meetings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chairs: [user.handle ?? user.accountId] }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Failed to create meeting' }));
        showToast({ message: body.error ?? 'Failed to create meeting' });
        return;
      }

      const meeting = await res.json();
      // Land on the Agenda tab so the chair can immediately add items and
      // co-chairs — the Queue is empty and uninteresting for a fresh meeting.
      navigate(`/meeting/${meeting.id}#agenda`);
    } catch {
      showToast({ message: 'Failed to create meeting' });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="bg-white dark:bg-stone-800 rounded-lg shadow-sm border border-stone-200 dark:border-stone-700 p-6">
      <h2 className="text-lg font-semibold text-stone-800 dark:text-stone-200 mb-4">New Meeting</h2>

      <p className="text-sm text-stone-500 dark:text-stone-400 mb-4">
        You will be the initial chair. Additional chairs can be added from the Agenda tab after the meeting is created.
      </p>

      <button
        onClick={handleCreate}
        disabled={loading || !user}
        className="bg-teal-700 text-white px-4 py-2 rounded text-sm font-medium
                   enabled:hover:bg-teal-800 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed
                   focus:outline-none focus:ring-2 focus:ring-teal-500 focus:ring-offset-2 dark:focus:ring-offset-stone-800"
      >
        {loading ? 'Creating…' : 'Start a New Meeting'}
      </button>
    </div>
  );
}
