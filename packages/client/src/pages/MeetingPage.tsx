/**
 * Meeting page — the main view when a user has joined a meeting.
 *
 * Connects to the server via Socket.IO, receives meeting state, and
 * renders the nav bar with Agenda/Queue tab panels.
 */

import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
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
  const { meeting, connected } = useMeetingState();
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
