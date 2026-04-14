/**
 * Meeting page — the main view when a user has joined a meeting.
 *
 * Connects to the server via Socket.IO, receives meeting state, and
 * renders the nav bar with Agenda/Queue tab panels. Shows error
 * messages from the server (e.g. "Meeting not found"). Registers
 * keyboard shortcuts for common actions.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { MeetingProvider, useMeetingState, useMeetingDispatch, useIsChair } from '../contexts/MeetingContext.js';
import { SocketContext } from '../contexts/SocketContext.js';
import { useAuth } from '../contexts/AuthContext.js';
import { useSocketConnection } from '../hooks/useSocketConnection.js';
import { useKeyboardShortcuts, getShortcutsEnabled, setShortcutsEnabled, type Shortcut } from '../hooks/useKeyboardShortcuts.js';
import { NavBar, type Tab } from '../components/NavBar.js';
import { AgendaPanel } from '../components/AgendaPanel.js';
import { QueuePanel } from '../components/QueuePanel.js';
import { HelpPanel } from '../components/HelpPanel.js';
import { LogsPanel } from '../components/LogsPanel.js';
import { ConnectionStatus } from '../components/ConnectionStatus.js';
import { KeyboardShortcutsDialog } from '../components/KeyboardShortcutsDialog.js';

/** Inner component that uses the MeetingContext (must be inside MeetingProvider). */
function MeetingPageInner() {
  const { id: meetingId } = useParams<{ id: string }>();
  const [activeTab, setActiveTab] = useState<Tab>('queue');
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [shortcutsEnabled, setShortcutsEnabledState] = useState(getShortcutsEnabled);
  const [presentationMode, setPresentationMode] = useState(false);
  const { meeting, connected, error } = useMeetingState();
  const dispatch = useMeetingDispatch();
  const { user } = useAuth();
  const socket = useSocketConnection(meetingId ?? '');

  // Push the authenticated user from AuthContext into MeetingContext
  // so that components like useIsChair() can check permissions.
  useEffect(() => {
    if (user) {
      dispatch({ type: 'setUser', user });
    }
  }, [user, dispatch]);

  // --- Presentation mode ---
  // Hides the nav bar and controls, and enters browser fullscreen.

  /** Toggle presentation mode on/off, entering/exiting fullscreen. */
  const togglePresentationMode = useCallback(() => {
    setPresentationMode((prev) => {
      const next = !prev;
      if (next) {
        document.documentElement.requestFullscreen?.().catch(() => {});
      } else {
        document.exitFullscreen?.().catch(() => {});
      }
      return next;
    });
  }, []);

  // Exit presentation mode when the user exits fullscreen via Escape or
  // browser UI (e.g. pressing Escape in fullscreen exits fullscreen but
  // doesn't trigger our keyboard shortcut handler).
  useEffect(() => {
    function handleFullscreenChange() {
      if (!document.fullscreenElement) {
        setPresentationMode(false);
      }
    }
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  // --- Auto-edit state (shared between keyboard shortcuts and SpeakerControls) ---

  const [autoEditEntryId, setAutoEditEntryId] = useState<string | null>(null);

  /**
   * Add a queue entry with placeholder text, then trigger auto-edit on
   * the new entry. Used by both keyboard shortcuts and the SpeakerControls
   * buttons. Listens for the next state broadcast to identify the new entry.
   */
  const addQueueEntry = useCallback((type: 'topic' | 'reply' | 'question' | 'point-of-order', placeholder: string) => {
    if (!socket || !meeting) return;
    setActiveTab('queue');

    // Capture current entry IDs so we can identify the new one
    const currentIds = new Set(meeting.queuedSpeakers.map((e) => e.id));
    socket.once('state', (newState) => {
      const newEntry = newState.queuedSpeakers.find((e: { id: string }) => !currentIds.has(e.id));
      if (newEntry) {
        setAutoEditEntryId(newEntry.id);
      }
    });

    socket.emit('queue:add', { type, topic: placeholder });
  }, [socket, meeting]);

  // --- Keyboard shortcuts ---

  const isChair = useIsChair();

  /** Advance to the next speaker (chair only). */
  const advanceNextSpeaker = useCallback(() => {
    if (!socket || !meeting || !isChair) return;
    setActiveTab('queue');
    socket.emit('queue:next', { version: meeting.version }, () => {});
  }, [socket, meeting, isChair]);

  const shortcuts = useMemo<Shortcut[]>(() => [
    { key: 'n', description: 'New Topic', action: () => addQueueEntry('topic', 'New topic') },
    { key: 'r', description: 'Reply to current topic', action: () => addQueueEntry('reply', 'Reply') },
    { key: 'c', description: 'Clarifying Question', action: () => addQueueEntry('question', 'Clarifying question') },
    { key: 'p', description: 'Point of Order', action: () => addQueueEntry('point-of-order', 'Point of order') },
    { key: 's', description: 'Next Speaker (chair only)', action: advanceNextSpeaker },
    { key: 'f', description: 'Toggle presentation mode', action: togglePresentationMode },
    { key: '1', description: 'Switch to Agenda tab', action: () => setActiveTab('agenda') },
    { key: '2', description: 'Switch to Queue tab', action: () => setActiveTab('queue') },
    { key: '3', description: 'Switch to Logs tab', action: () => setActiveTab('log') },
    { key: '4', description: 'Switch to Help tab', action: () => setActiveTab('help') },
    { key: '?', description: 'Toggle shortcuts dialogue', action: () => setShowShortcuts((v) => !v), alwaysActive: true },
    { key: 'Escape', description: 'Close dialog', action: () => setShowShortcuts(false), alwaysActive: true },
  ], [addQueueEntry, advanceNextSpeaker, togglePresentationMode]);

  useKeyboardShortcuts(shortcuts, shortcutsEnabled);

  /** Toggle shortcuts on/off and persist to localStorage. */
  function handleToggleShortcuts() {
    const next = !shortcutsEnabled;
    setShortcutsEnabledState(next);
    setShortcutsEnabled(next);
  }

  // Filter Escape from the displayed shortcuts list
  const displayedShortcuts = shortcuts.filter((s) => s.key !== 'Escape');

  // Error state — show error message with a link back to the home page
  if (error && !meeting) {
    return (
      <div className="min-h-screen bg-stone-50 dark:bg-stone-900">
        <NavBar activeTab={activeTab} onTabChange={setActiveTab} />
        <main className="p-6 max-w-xl mx-auto text-center mt-12">
          <h1 className="text-xl font-semibold text-stone-800 dark:text-stone-200 mb-2">
            {error}
          </h1>
          <p className="text-stone-500 dark:text-stone-400 mb-4">
            The meeting you're looking for doesn't exist or is no longer available.
          </p>
          <Link
            to="/"
            className="text-teal-600 dark:text-teal-400 hover:text-teal-800 dark:hover:text-teal-300 font-medium transition-colors"
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
      <div className="min-h-screen bg-stone-50 dark:bg-stone-900">
        <NavBar activeTab={activeTab} onTabChange={setActiveTab} />
        <main className="p-6">
          {!connected ? (
            <p className="text-stone-500 dark:text-stone-400">Connecting&hellip;</p>
          ) : (
            <p className="text-stone-500 dark:text-stone-400">Loading meeting&hellip;</p>
          )}
        </main>
      </div>
    );
  }

  return (
    <SocketContext value={socket}>
      <div className={`min-h-screen bg-stone-50 dark:bg-stone-900 ${presentationMode ? 'presentation-mode' : ''}`}>
        {/* Navigation and controls are hidden in presentation mode */}
        {!presentationMode && (
          <>
            <NavBar activeTab={activeTab} onTabChange={setActiveTab} />

            {/* Dismissible error banner for non-fatal errors */}
            {error && (
              <div
                className="bg-red-50 dark:bg-red-900/30 border-b border-red-200 dark:border-red-800 px-6 py-2 text-sm text-red-700 dark:text-red-300
                           flex items-center justify-between"
                role="alert"
              >
                <span>{error}</span>
                <button
                  onClick={() => dispatch({ type: 'setError', error: '' })}
                  className="text-red-400 hover:text-red-600 dark:text-red-500 dark:hover:text-red-300 ml-4 cursor-pointer"
                  aria-label="Dismiss error"
                >
                  ✕
                </button>
              </div>
            )}
          </>
        )}

        <main>
          {activeTab === 'agenda' && <AgendaPanel />}
          {activeTab === 'queue' && (
            <QueuePanel
              autoEditEntryId={presentationMode ? null : autoEditEntryId}
              onAddEntry={addQueueEntry}
              onAutoEditConsumed={() => setAutoEditEntryId(null)}
            />
          )}
          {!presentationMode && activeTab === 'log' && <LogsPanel />}
          {!presentationMode && activeTab === 'help' && <HelpPanel />}
        </main>

        {/* Connection status indicator */}
        <ConnectionStatus connected={connected} />

        {/* Keyboard shortcuts dialog */}
        {showShortcuts && (
          <KeyboardShortcutsDialog
            shortcuts={displayedShortcuts}
            enabled={shortcutsEnabled}
            onToggleEnabled={handleToggleShortcuts}
            onClose={() => setShowShortcuts(false)}
          />
        )}
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
