/**
 * Meeting page — the main view when a user has joined a meeting.
 *
 * Connects to the server via Socket.IO, receives meeting state, and
 * renders the nav bar with Agenda/Queue tab panels. Shows error
 * messages from the server (e.g. "Meeting not found").
 */

import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { MeetingProvider, useMeetingState, useMeetingDispatch } from '../contexts/MeetingContext.js';
import { SocketContext } from '../contexts/SocketContext.js';
import { useAuth } from '../contexts/AuthContext.js';
import { useSocketConnection } from '../hooks/useSocketConnection.js';
import { NavBar } from '../components/NavBar.js';
import { AgendaPanel } from '../components/AgendaPanel.js';
import { QueuePanel } from '../components/QueuePanel.js';

/** Inner component that uses the MeetingContext (must be inside MeetingProvider). */
function MeetingPageInner() {
  const { id: meetingId } = useParams<{ id: string }>();
  const [activeTab, setActiveTab] = useState<'agenda' | 'queue'>('queue');
  const { meeting, connected, error } = useMeetingState();
  const dispatch = useMeetingDispatch();
  const { user } = useAuth();

  // Push the authenticated user from AuthContext into MeetingContext
  // so that components like useIsChair() can check permissions.
  useEffect(() => {
    if (user) {
      dispatch({ type: 'setUser', user });
    }
  }, [user, dispatch]);

  // Connect to the meeting via Socket.IO and provide the socket to children
  const socket = useSocketConnection(meetingId ?? '');

  // Error state — show error message with a link back to the home page
  if (error && !meeting) {
    return (
      <div className="min-h-screen bg-stone-50">
        <NavBar activeTab={activeTab} onTabChange={setActiveTab} />
        <main className="p-6 max-w-xl mx-auto text-center mt-12">
          <h1 className="text-xl font-semibold text-stone-800 mb-2">
            {error}
          </h1>
          <p className="text-stone-500 mb-4">
            The meeting you're looking for doesn't exist or is no longer available.
          </p>
          <Link
            to="/"
            className="text-teal-600 hover:text-teal-800 font-medium transition-colors"
          >
            Back to home
          </Link>
        </main>
      </div>
    );
  }

  // Loading state — haven't received meeting data yet
  if (!meeting) {
    return (
      <div className="min-h-screen bg-stone-50">
        <NavBar activeTab={activeTab} onTabChange={setActiveTab} />
        <main className="p-6">
          {!connected ? (
            <p className="text-stone-500">Connecting&hellip;</p>
          ) : (
            <p className="text-stone-500">Loading meeting&hellip;</p>
          )}
        </main>
      </div>
    );
  }

  return (
    <SocketContext value={socket}>
      <div className="min-h-screen bg-stone-50">
        <NavBar activeTab={activeTab} onTabChange={setActiveTab} />

        {/* Dismissible error banner for non-fatal errors (e.g. permission denied) */}
        {error && (
          <div
            className="bg-red-50 border-b border-red-200 px-6 py-2 text-sm text-red-700
                       flex items-center justify-between"
            role="alert"
          >
            <span>{error}</span>
            <button
              onClick={() => dispatch({ type: 'setError', error: '' })}
              className="text-red-400 hover:text-red-600 ml-4 cursor-pointer"
              aria-label="Dismiss error"
            >
              ✕
            </button>
          </div>
        )}

        <main>
          {activeTab === 'agenda' ? <AgendaPanel /> : <QueuePanel />}
        </main>
      </div>
    </SocketContext>
  );
}

/** Wrapper that provides MeetingContext. */
export function MeetingPage() {
  return (
    <MeetingProvider>
      <MeetingPageInner />
    </MeetingProvider>
  );
}
