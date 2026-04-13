/**
 * Home page — tabbed layout with "Join Meeting" (create/join forms)
 * and "Help" (usage guide) tabs.
 */

import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.js';
import { UserMenu } from '../components/UserMenu.js';
import { HelpPanel } from '../components/HelpPanel.js';
import { Logo } from '../components/Logo.js';
import { AdminPanel } from '../components/AdminPanel.js';

type HomeTab = 'join' | 'help';

export function HomePage() {
  const [activeTab, setActiveTab] = useState<HomeTab>('join');

  return (
    <div className="min-h-screen bg-stone-50 text-stone-900">
      <nav
        className="sticky top-0 z-40 flex items-center gap-3 sm:gap-6 border-b border-stone-200 bg-white px-3 sm:px-6 py-3"
        aria-label="Main navigation"
      >
        {/* Branding */}
        <Logo />

        {/* Tab toggles */}
        <div className="flex gap-4" role="tablist" aria-label="Home views">
          <button
            role="tab"
            aria-selected={activeTab === 'join'}
            className={`text-base font-medium transition-colors cursor-pointer pb-1 border-b-2 ${
              activeTab === 'join'
                ? 'text-stone-900 border-teal-500'
                : 'text-stone-400 border-transparent hover:text-stone-600 hover:border-stone-300'
            }`}
            onClick={() => setActiveTab('join')}
          >
            Join Meeting
          </button>
          <button
            role="tab"
            aria-selected={activeTab === 'help'}
            className={`text-base font-medium transition-colors cursor-pointer pb-1 border-b-2 ${
              activeTab === 'help'
                ? 'text-stone-900 border-teal-500'
                : 'text-stone-400 border-transparent hover:text-stone-600 hover:border-stone-300'
            }`}
            onClick={() => setActiveTab('help')}
          >
            Help
          </button>
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* User menu */}
        <UserMenu />
      </nav>

      <main>
        {activeTab === 'join' && <JoinTab />}
        {activeTab === 'help' && <HelpPanel />}
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

      {/* Admin panel — only shown for admin users */}
      {isAdmin && <AdminPanel />}
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
    <div className="bg-white rounded-lg shadow-sm border border-stone-200 p-6">
      <h2 className="text-lg font-semibold text-stone-800 mb-4">Join Meeting</h2>

      <form onSubmit={handleSubmit}>
        <label htmlFor="meeting-id" className="block text-sm font-medium text-stone-700 mb-1">
          Meeting ID
        </label>
        <input
          id="meeting-id"
          type="text"
          value={meetingId}
          onChange={(e) => setMeetingId(e.target.value)}
          placeholder="e.g. bright-pine-lake"
          required
          className="w-full border border-stone-300 rounded px-3 py-2 text-sm mb-1
                     focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
        />

        {/* Error message */}
        {error && (
          <p className="text-red-600 text-sm mb-2" role="alert">{error}</p>
        )}

        <button
          type="submit"
          className="mt-2 bg-teal-500 text-white px-4 py-2 rounded text-sm font-medium
                     hover:bg-teal-600 transition-colors cursor-pointer
                     focus:outline-none focus:ring-2 focus:ring-teal-500 focus:ring-offset-2"
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
      navigate(`/meeting/${meeting.id}`);
    } catch {
      setError('Failed to create meeting');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="bg-white rounded-lg shadow-sm border border-stone-200 p-6">
      <h2 className="text-lg font-semibold text-stone-800 mb-4">New Meeting</h2>

      <p className="text-sm text-stone-500 mb-4">
        You will be the initial chair. Additional chairs can be added
        from the Agenda tab after the meeting is created.
      </p>

      {/* Error message */}
      {error && (
        <p className="text-red-600 text-sm mb-2" role="alert">{error}</p>
      )}

      <button
        onClick={handleCreate}
        disabled={loading || !user}
        className="bg-teal-500 text-white px-4 py-2 rounded text-sm font-medium
                   hover:bg-teal-600 transition-colors cursor-pointer disabled:opacity-50
                   focus:outline-none focus:ring-2 focus:ring-teal-500 focus:ring-offset-2"
      >
        {loading ? 'Creating…' : 'Start a New Meeting'}
      </button>
    </div>
  );
}
