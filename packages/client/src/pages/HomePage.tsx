/**
 * Home page — shown when the user is not in a meeting.
 *
 * Two tabs:
 * - "Join Meeting" — cards for joining or creating a meeting, plus admin panel.
 * - "Help" — usage guide (shared HelpPanel component).
 */

import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.js';
import { AdminPanel } from '../components/AdminPanel.js';
import { DiagnosticsPanel } from '../components/DiagnosticsPanel.js';
import { HelpPanel } from '../components/HelpPanel.js';
import { Logo } from '../components/Logo.js';
import { UserMenu } from '../components/UserMenu.js';

export function HomePage() {
  const [activeTab, setActiveTab] = useState<'join' | 'help'>('join');

  return (
    <div className="h-dvh flex flex-col bg-stone-50 dark:bg-stone-900 text-stone-900 dark:text-stone-100">
      <nav
        className="shrink-0 z-50 flex items-stretch gap-3 sm:gap-6 border-b border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 px-3 sm:px-6 shadow-md"
        aria-label="Main navigation"
      >
        {/* Branding */}
        <span className="flex items-center py-3">
          <Logo />
        </span>

        {/* Tab toggles */}
        <div className="flex items-stretch gap-4" role="tablist" aria-label="Home views">
          <button
            role="tab"
            aria-selected={activeTab === 'join'}
            className={`group flex items-center py-3 text-base font-medium cursor-pointer transition-colors ${
              activeTab === 'join'
                ? 'text-stone-900 dark:text-stone-100'
                : 'text-stone-400 dark:text-stone-500 hover:text-stone-600 dark:hover:text-stone-300'
            }`}
            onClick={() => setActiveTab('join')}
          >
            <span
              className={`pb-1 border-b-2 transition-colors ${
                activeTab === 'join'
                  ? 'border-teal-500'
                  : 'border-transparent group-hover:border-stone-300 dark:group-hover:border-stone-600'
              }`}
            >
              Join Meeting
            </span>
          </button>
          <button
            role="tab"
            aria-selected={activeTab === 'help'}
            className={`group flex items-center py-3 text-base font-medium cursor-pointer transition-colors ${
              activeTab === 'help'
                ? 'text-stone-900 dark:text-stone-100'
                : 'text-stone-400 dark:text-stone-500 hover:text-stone-600 dark:hover:text-stone-300'
            }`}
            onClick={() => setActiveTab('help')}
          >
            <span
              className={`pb-1 border-b-2 transition-colors ${
                activeTab === 'help'
                  ? 'border-teal-500'
                  : 'border-transparent group-hover:border-stone-300 dark:group-hover:border-stone-600'
              }`}
            >
              Help
            </span>
          </button>
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* User menu */}
        <div className="flex items-stretch">
          <UserMenu />
        </div>
      </nav>

      <main className="flex-1 overflow-y-auto min-h-0">
        {activeTab === 'join' && <JoinTab />}
        {activeTab === 'help' && <HelpPanel showChairHelp={true} />}
      </main>
    </div>
  );
}

// -- Join tab (cards + admin panel) --

function JoinTab() {
  const { isAdmin } = useAuth();

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-4">
        <JoinMeetingCard />
        <NewMeetingCard />
      </div>

      {/* Admin sections — only shown for admin users */}
      {isAdmin && (
        <>
          <AdminPanel />
          <DiagnosticsPanel />
        </>
      )}
    </div>
  );
}

// -- Join Meeting card --

function JoinMeetingCard() {
  const navigate = useNavigate();
  const [meetingId, setMeetingId] = useState('');
  const [error, setError] = useState('');

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');

    const trimmed = meetingId.trim();
    if (!trimmed) return;

    // Check the meeting exists before navigating
    const res = await fetch(`/api/meetings/${encodeURIComponent(trimmed)}`);
    if (!res.ok) {
      setError('Meeting not found');
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
          className="w-full border border-stone-300 dark:border-stone-600 rounded px-3 py-2 text-sm mb-1
                     bg-white dark:bg-stone-700 text-stone-900 dark:text-stone-100
                     focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
        />

        {/* Error message */}
        {error && (
          <p className="text-red-600 dark:text-red-400 text-sm mb-2" role="alert">
            {error}
          </p>
        )}

        <button
          type="submit"
          className="mt-2 bg-teal-500 text-white px-4 py-2 rounded text-sm font-medium
                     hover:bg-teal-600 transition-colors cursor-pointer
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
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  /** Create a new meeting with the current user as the only chair. */
  async function handleCreate() {
    if (!user) return;
    setError('');
    setLoading(true);

    try {
      const res = await fetch('/api/meetings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chairs: [user.ghUsername] }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Failed to create meeting' }));
        setError(body.error ?? 'Failed to create meeting');
        return;
      }

      const meeting = await res.json();
      // Land on the Agenda tab so the chair can immediately add items and
      // co-chairs — the Queue is empty and uninteresting for a fresh meeting.
      navigate(`/meeting/${meeting.id}#agenda`);
    } catch {
      setError('Failed to create meeting');
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

      {/* Error message */}
      {error && (
        <p className="text-red-600 dark:text-red-400 text-sm mb-2" role="alert">
          {error}
        </p>
      )}

      <button
        onClick={handleCreate}
        disabled={loading || !user}
        className="bg-teal-500 text-white px-4 py-2 rounded text-sm font-medium
                   enabled:hover:bg-teal-600 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed
                   focus:outline-none focus:ring-2 focus:ring-teal-500 focus:ring-offset-2 dark:focus:ring-offset-stone-800"
      >
        {loading ? 'Creating…' : 'Start a New Meeting'}
      </button>
    </div>
  );
}
