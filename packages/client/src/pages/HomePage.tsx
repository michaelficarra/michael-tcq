/**
 * Home page — landing page with Join Meeting and New Meeting forms.
 *
 * Join Meeting: enter a meeting ID to navigate to it.
 * New Meeting: specify chairs (comma-separated GitHub usernames) to
 * create a new meeting and be redirected to it.
 */

import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';

export function HomePage() {
  return (
    <div className="min-h-screen bg-stone-50 text-stone-900">
      <header className="flex items-center justify-between border-b border-stone-200 bg-white px-6 py-3">
        <span className="text-2xl font-semibold text-stone-800">TCQ</span>
        <a
          href="/auth/logout"
          className="text-sm text-stone-500 hover:text-stone-700 transition-colors"
        >
          Log Out
        </a>
      </header>

      <main className="p-6 max-w-3xl mx-auto">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-4">
          <JoinMeetingCard />
          <NewMeetingCard />
        </div>
      </main>
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
                     hover:bg-teal-600 transition-colors
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
  const [chairs, setChairs] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');

    // Split on commas and trim whitespace from each username
    const chairList = chairs
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    if (chairList.length === 0) {
      setError('At least one chair is required');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/meetings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chairs: chairList }),
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

      <form onSubmit={handleSubmit}>
        <label htmlFor="chairs" className="block text-sm font-medium text-stone-700 mb-1">
          Chairs
        </label>
        <input
          id="chairs"
          type="text"
          value={chairs}
          onChange={(e) => setChairs(e.target.value)}
          required
          className="w-full border border-stone-300 rounded px-3 py-2 text-sm mb-1
                     focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
        />
        <p className="text-xs text-stone-400 mb-2">
          Chairs control the agenda and speaker queue. Enter GitHub usernames separated by commas.
        </p>

        {/* Error message */}
        {error && (
          <p className="text-red-600 text-sm mb-2" role="alert">{error}</p>
        )}

        <button
          type="submit"
          disabled={loading}
          className="mt-1 bg-teal-500 text-white px-4 py-2 rounded text-sm font-medium
                     hover:bg-teal-600 transition-colors disabled:opacity-50
                     focus:outline-none focus:ring-2 focus:ring-teal-500 focus:ring-offset-2"
        >
          {loading ? 'Creating…' : 'Start a New Meeting'}
        </button>
      </form>
    </div>
  );
}
