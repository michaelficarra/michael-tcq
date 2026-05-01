/**
 * Queue tab panel — displays the current agenda item, current speaker,
 * speaker controls, and the speaker queue.
 *
 * The agenda item section shows Start Meeting / Next Agenda Item buttons
 * for chairs. The speaker section shows the current speaker with a
 * Next Speaker button for chairs. Below that are the entry type buttons
 * and the queue list with drag-and-drop reordering for chairs.
 */

import { lazy, Suspense, useState, useEffect, useCallback, useRef, type FormEvent } from 'react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type Modifier,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { AgendaItem, QueueEntry, QueueEntryType } from '@tcq/shared';
import {
  QUEUE_ENTRY_TYPES,
  QUEUE_ENTRY_LABELS,
  QUEUE_ENTRY_PRIORITY,
  formatShortDuration,
  isAgendaItem,
  normaliseGithubUsername,
  userKey,
} from '@tcq/shared';
import { useMeetingState, useMeetingDispatch, useIsChair } from '../contexts/MeetingContext.js';
import { useSocket } from '../contexts/SocketContext.js';
import { useAdvanceAction } from '../hooks/useAdvanceAction.js';
import { InlineMarkdown } from './InlineMarkdown.js';
import { SpeakerControls } from './SpeakerControls.js';
import { UserBadge } from './UserBadge.js';
import { PollReactions } from './PollReactions.js';
const PollSetup = lazy(() => import('./PollSetup.js').then((m) => ({ default: m.PollSetup })));
import { CountUpTimer } from './CountUpTimer.js';

// Stable references so useSensor's internal useMemo doesn't invalidate every render.
const POINTER_SENSOR_OPTIONS = {
  activationConstraint: { distance: 5 },
};
const KEYBOARD_SENSOR_OPTIONS = {
  coordinateGetter: sortableKeyboardCoordinates,
};

interface QueuePanelProps {
  /** ID of a newly added queue entry that should open in edit mode. */
  autoEditEntryId: string | null;
  /** Add a queue entry with placeholder text and trigger auto-edit. */
  onAddEntry: (type: import('@tcq/shared').QueueEntryType, placeholder: string) => void;
  /** Called when the auto-edit has been consumed by the entry component. */
  onAutoEditConsumed: () => void;
  /** Hide the panel when not the active tab (rendered but excluded from a11y tree). */
  hidden?: boolean;
}

export function QueuePanel({ autoEditEntryId, onAddEntry, onAutoEditConsumed, hidden = false }: QueuePanelProps) {
  const { meeting, user } = useMeetingState();
  const dispatch = useMeetingDispatch();
  const isChair = useIsChair();
  const socket = useSocket();

  // Derive the current agenda item from the ID reference
  const currentAgendaItem = meeting?.agenda.find(
    (entry): entry is AgendaItem => isAgendaItem(entry) && entry.id === meeting.current.agendaItemId,
  );

  // Current speaker / topic are first-class structs on meeting.current
  const currentSpeaker = meeting?.current.speaker;
  const currentTopic = meeting?.current.topic;
  const queuedSpeakers = meeting?.queue.orderedIds.map((id) => meeting.queue.entries[id]).filter(Boolean) ?? [];

  // Derive start times for count-up timers
  const agendaItemStartTime = meeting?.current.agendaItemStartTime;
  const topicSpeakers = meeting?.current.topicSpeakers;
  const currentTopicStartTime = topicSpeakers?.[0]?.startTime;
  const currentSpeakerStartTime = (() => {
    if (!topicSpeakers?.length) return undefined;
    const last = topicSpeakers[topicSpeakers.length - 1];
    return last.duration === undefined ? last.startTime : undefined;
  })();

  // Whether the poll setup form is open
  const [showPollSetup, setShowPollSetup] = useState(false);

  // Whether the "advance agenda item" confirmation modal is open
  const [showAdvanceConfirm, setShowAdvanceConfirm] = useState(false);

  // Draft of the conclusion text the chair is authoring in the dialog.
  // Seeded from the outgoing item's existing conclusion at the moment the
  // dialog is opened (see the Next Agenda Item button's onClick), so
  // revisits show what was previously saved.
  const [conclusionDraft, setConclusionDraft] = useState('');

  // Advancement actions with debounce + cooldown protection
  const { fire: handleNextAgendaItem } = useAdvanceAction('meeting:nextAgendaItem');
  const { fire: handleNextSpeaker, disabled: nextSpeakerDisabled } = useAdvanceAction('queue:next');

  // Drag-and-drop sensors with keyboard support for accessibility.
  // Options are hoisted to module scope so useSensor's internal useMemo
  // sees stable references and doesn't recreate descriptors every render.
  const sensors = useSensors(
    useSensor(PointerSensor, POINTER_SENSOR_OPTIONS),
    useSensor(KeyboardSensor, KEYBOARD_SENSOR_OPTIONS),
  );

  // Holds the index range the dragged entry is permitted to occupy, plus
  // its start index. `null` means unrestricted (chair, or no active drag).
  // Non-chair owners are bounded above by the top of their own contiguous
  // block — they may reorder among their own entries but never jump ahead
  // of someone else's entry.
  const dragBoundsRef = useRef<{
    currentIndex: number;
    minIndex: number;
    maxIndex: number;
  } | null>(null);

  /** Called when a drag starts — compute the legal index range for the move. */
  function handleDragStart(event: DragStartEvent) {
    if (!meeting || !user) return;
    const entries = meeting.queue.orderedIds.map((id) => meeting.queue.entries[id]).filter(Boolean);
    const currentIndex = entries.findIndex((e) => e.id === event.active.id);
    if (currentIndex === -1) return;

    if (isChair) {
      // Chairs may move any entry anywhere — no clamp needed.
      dragBoundsRef.current = null;
      return;
    }

    const ownerKey = userKey(user);
    const entry = entries[currentIndex];
    if (entry.userId !== ownerKey) {
      // Non-owner non-chair shouldn't be able to drag (no handle), but be
      // defensive: pin the entry in place.
      dragBoundsRef.current = { currentIndex, minIndex: currentIndex, maxIndex: currentIndex };
      return;
    }

    // Walk upward from the entry to find the top of the contiguous block of
    // own-owned entries above it. The entry can move up to that index but
    // no further. Downward movement is unconstrained.
    let minIndex = currentIndex;
    for (let i = currentIndex - 1; i >= 0 && entries[i].userId === ownerKey; i--) {
      minIndex = i;
    }
    dragBoundsRef.current = { currentIndex, minIndex, maxIndex: entries.length - 1 };
  }

  /**
   * Custom dnd-kit modifier that clamps the dragged entry's vertical
   * translation so it cannot leave the index range computed at drag start.
   * Heights are taken from the active node; rows in this list are roughly
   * uniform so this is a close approximation. The server is the
   * authoritative validator regardless.
   */
  const restrictDragBounds: Modifier = useCallback(({ transform, activeNodeRect }) => {
    const bounds = dragBoundsRef.current;
    if (!bounds || !activeNodeRect) return transform;
    const h = activeNodeRect.height;
    const minY = (bounds.minIndex - bounds.currentIndex) * h;
    const maxY = (bounds.maxIndex - bounds.currentIndex) * h;
    return { ...transform, y: Math.max(minY, Math.min(maxY, transform.y)) };
  }, []);

  // Whether the restore queue textarea is open
  const [showRestore, setShowRestore] = useState(false);
  const [restoreText, setRestoreText] = useState('');

  // When hidden (not the active tab) or meeting state not yet loaded, render
  // only the empty tabpanel shell. Keeping the shell in the DOM avoids the
  // mount/unmount race on tab switch; skipping the inner content avoids
  // re-rendering the whole panel on every state broadcast while the user is
  // on another tab.
  if (hidden || !meeting) {
    return <div id="panel-queue" role="tabpanel" aria-label="Queue" hidden={hidden} className="p-6 space-y-6" />;
  }

  /** Remove a queue entry (own entry, or any entry if chair). */
  function handleRemoveEntry(entryId: string) {
    socket?.emit('queue:remove', { id: entryId });
  }

  /**
   * Copy the queue to the clipboard in a human-readable text format.
   * Each line: "Type: topic (username)"
   */
  function handleCopyQueue() {
    if (!meeting) return;
    const text = queuedSpeakers
      .map((e) => `${entryTypeLabel(e.type)}: ${e.topic} (${meeting.users[e.userId]?.ghUsername ?? e.userId})`)
      .join('\n');
    navigator.clipboard.writeText(text).catch(() => {});
  }

  /**
   * Parse the restore text and bulk-add entries to the queue.
   * Each line should be "Type: topic" or "Type: topic (username)".
   * When a username is present, the entry is added on behalf of that
   * user (chair-only feature via the asUsername field).
   */
  function handleRestoreQueue() {
    if (!socket || !restoreText.trim()) return;

    const lines = restoreText.trim().split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Parse "Type: topic" or "Type: topic (username)"
      const colonIndex = trimmed.indexOf(':');
      if (colonIndex === -1) continue;

      const typeLabel = trimmed.slice(0, colonIndex).trim();
      let rest = trimmed.slice(colonIndex + 1).trim();

      // Extract trailing "(username)" if present
      let asUsername: string | undefined;
      const parenMatch = rest.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
      if (parenMatch) {
        rest = parenMatch[1].trim();
        asUsername = normaliseGithubUsername(parenMatch[2]);
      }

      const type = parseEntryType(typeLabel);
      if (!type || !rest) continue;

      socket.emit('queue:add', { type, topic: rest, asUsername });
    }

    setRestoreText('');
    setShowRestore(false);
  }

  /**
   * Handle the end of a drag-and-drop reorder on the queue.
   * Resolves the drop position to a UUID-based afterId so the server
   * receives race-condition-safe reorder commands.
   */
  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    // Clear bounds whether or not we end up dispatching, so a follow-up
    // chair drag isn't accidentally constrained by a stale entry.
    const bounds = dragBoundsRef.current;
    dragBoundsRef.current = null;

    if (!over || active.id === over.id || !meeting) return;

    const items = queuedSpeakers;
    const oldIndex = items.findIndex((e) => e.id === active.id);
    const newIndex = items.findIndex((e) => e.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    // If bounds were active, reject drops outside the legal range without
    // dispatching — the entry visually snaps back. The server would reject
    // anyway, but checking here avoids an optimistic update that flickers.
    if (bounds && (newIndex < bounds.minIndex || newIndex > bounds.maxIndex)) return;

    // Determine what entry the dragged item should come after.
    // If dropped at position 0, afterId is null (move to beginning).
    let afterId: string | null;
    if (newIndex === 0) {
      afterId = null;
    } else if (oldIndex < newIndex) {
      // Moving down: place after the entry at newIndex
      afterId = items[newIndex].id;
    } else {
      // Moving up: place after the entry just before newIndex
      afterId = items[newIndex - 1]?.id ?? null;
    }

    dispatch({ type: 'optimisticQueueReorder', oldIndex, newIndex });
    socket?.emit('queue:reorder', { id: active.id as string, afterId });
  }

  // Determine whether there are more agenda items after the current one.
  // Session headers are skipped — advancement only lands on actual items.
  const hasMoreAgendaItems = (() => {
    if (!currentAgendaItem) {
      return meeting.agenda.some((e) => isAgendaItem(e));
    }
    const currentIndex = meeting.agenda.findIndex((e) => isAgendaItem(e) && e.id === currentAgendaItem.id);
    for (let i = currentIndex + 1; i < meeting.agenda.length; i++) {
      if (isAgendaItem(meeting.agenda[i])) return true;
    }
    return false;
  })();

  return (
    <div id="panel-queue" role="tabpanel" aria-label="Queue" className="p-6 space-y-6">
      {/* --- Agenda Item Section --- */}
      <section aria-labelledby="agenda-item-heading">
        <div className="flex items-center gap-3 mb-1">
          <h2
            id="agenda-item-heading"
            className="text-sm font-bold uppercase tracking-wider text-stone-700 dark:text-stone-300 select-none"
          >
            Agenda Item
          </h2>

          {/* Chair controls next to the heading */}
          {isChair && currentAgendaItem && (
            <>
              {hasMoreAgendaItems && (
                <button
                  onClick={() => {
                    // Always show the dialog so the chair can record (or
                    // edit) a conclusion for the outgoing item, regardless
                    // of whether the queue has entries that need clearing.
                    // Seed the draft from the outgoing item's saved
                    // conclusion so revisits show what was last entered.
                    setConclusionDraft(currentAgendaItem?.conclusion ?? '');
                    setShowAdvanceConfirm(true);
                  }}
                  className="text-xs border border-stone-300 dark:border-stone-600 rounded px-2 py-0.5
                             text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800 transition-colors cursor-pointer presentation-hidden"
                >
                  Next Agenda Item
                </button>
              )}
              {!meeting.poll && (
                <button
                  onClick={() => setShowPollSetup(true)}
                  className="text-xs border border-stone-300 dark:border-stone-600 rounded px-2 py-0.5
                             text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800 transition-colors cursor-pointer presentation-hidden"
                >
                  Create Poll
                </button>
              )}
            </>
          )}
        </div>

        {currentAgendaItem ? (
          <div className="pl-3">
            <p className="text-stone-800 dark:text-stone-200 font-medium">
              <InlineMarkdown>{currentAgendaItem.name}</InlineMarkdown>
            </p>
            <div className="text-sm text-stone-500 dark:text-stone-400 flex flex-wrap items-center gap-x-2">
              {currentAgendaItem.presenterIds.map((pid) => (
                <UserBadge key={pid} user={meeting.users[pid]} size={18} />
              ))}
              {currentAgendaItem.duration != null && currentAgendaItem.duration > 0 && (
                <span
                  className="ml-2"
                  title="Estimate"
                  aria-label={`Estimate: ${formatShortDuration(currentAgendaItem.duration)}`}
                >
                  {formatShortDuration(currentAgendaItem.duration)}
                </span>
              )}
              {agendaItemStartTime && (
                <CountUpTimer
                  since={agendaItemStartTime}
                  className="ml-2 text-xs text-stone-400 dark:text-stone-500 tabular-nums"
                  overAfterMinutes={currentAgendaItem.duration}
                />
              )}
            </div>
          </div>
        ) : (
          <div className="pl-3">
            <p className="text-stone-500 dark:text-stone-400">Waiting for the meeting to start&hellip;</p>
            {/* Start Meeting button — chair only. Enabled only when the
                agenda has at least one actual item (sessions don't count). */}
            {isChair && meeting.agenda.some((e) => isAgendaItem(e)) && (
              <button
                onClick={() => handleNextAgendaItem()}
                className="mt-2 border border-stone-300 dark:border-stone-600 rounded px-3 py-1 text-sm
                           text-stone-700 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800 transition-colors cursor-pointer presentation-hidden"
              >
                Start Meeting
              </button>
            )}
          </div>
        )}
      </section>

      {/* --- Current Topic Section (hidden when the same turn is the current speaker) --- */}
      {currentTopic && currentTopic.speakerId !== currentSpeaker?.id && (
        <section aria-labelledby="topic-heading">
          <h2
            id="topic-heading"
            className="text-sm font-bold uppercase tracking-wider text-stone-700 dark:text-stone-300 select-none mb-1"
          >
            Topic
          </h2>
          <div className="pl-3">
            <p className="text-stone-800 dark:text-stone-200">
              <InlineMarkdown>{currentTopic.topic}</InlineMarkdown>
            </p>
            <div className="flex items-center gap-2 text-sm text-stone-500 dark:text-stone-400">
              <UserBadge user={meeting.users[currentTopic.userId]} size={18} />
              {currentTopicStartTime && <CountUpTimer since={currentTopicStartTime} />}
            </div>
          </div>
        </section>
      )}

      {/* --- Current Speaker Section --- */}
      <section aria-labelledby="speaking-heading">
        <div className="flex items-center gap-3 mb-1">
          <h2
            id="speaking-heading"
            className="text-sm font-bold uppercase tracking-wider text-stone-700 dark:text-stone-300 select-none"
          >
            Speaking
          </h2>

          {/* Next Speaker button — chair only, next to the heading */}
          {isChair && (currentSpeaker || queuedSpeakers.length > 0) && (
            <button
              onClick={() => handleNextSpeaker()}
              disabled={nextSpeakerDisabled}
              className={`text-xs border border-stone-300 dark:border-stone-600 rounded px-2 py-0.5
                         transition-colors presentation-hidden ${
                           nextSpeakerDisabled
                             ? 'opacity-50 cursor-not-allowed text-stone-400 dark:text-stone-500'
                             : 'text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800 cursor-pointer'
                         }`}
            >
              Next Speaker
            </button>
          )}
        </div>

        {currentSpeaker ? (
          <div className="pl-3">
            <p className="text-stone-800 dark:text-stone-200">
              <InlineMarkdown>{currentSpeaker.topic}</InlineMarkdown>
            </p>
            <div className="flex items-center gap-2 text-sm text-stone-500 dark:text-stone-400">
              <UserBadge user={meeting.users[currentSpeaker.userId]} size={18} />
              {currentSpeakerStartTime && <CountUpTimer since={currentSpeakerStartTime} />}
            </div>
          </div>
        ) : (
          <p className="text-stone-500 dark:text-stone-400 pl-3">
            Nobody speaking yet&hellip; enter the queue to get started
          </p>
        )}
      </section>

      {/* --- Speaker Entry Controls --- */}
      <SpeakerControls onAddEntry={onAddEntry} />

      {/* --- Speaker Queue Section --- */}
      <section aria-labelledby="queue-heading">
        <div className="flex items-center gap-3 mb-1">
          <h2
            id="queue-heading"
            className="text-sm font-bold uppercase tracking-wider text-stone-700 dark:text-stone-300 select-none"
          >
            Speaker Queue
          </h2>

          {/* Queue management buttons — chairs only */}
          {isChair && (
            <>
              {currentAgendaItem && (
                <button
                  onClick={() => socket?.emit('queue:setClosed', { closed: !meeting.queue.closed })}
                  className="text-xs border border-stone-300 dark:border-stone-600 rounded px-2 py-0.5
                             text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800 transition-colors cursor-pointer presentation-hidden"
                >
                  {meeting.queue.closed ? 'Open Queue' : 'Close Queue'}
                </button>
              )}
              {queuedSpeakers.length > 0 && (
                <button
                  onClick={handleCopyQueue}
                  className="text-xs border border-stone-300 dark:border-stone-600 rounded px-2 py-0.5
                             text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800 transition-colors cursor-pointer presentation-hidden"
                >
                  Copy Queue
                </button>
              )}
              <button
                onClick={() => setShowRestore(!showRestore)}
                className="text-xs border border-stone-300 dark:border-stone-600 rounded px-2 py-0.5
                           text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800 transition-colors cursor-pointer presentation-hidden"
              >
                {showRestore ? 'Cancel' : 'Restore Queue'}
              </button>
            </>
          )}
        </div>

        {/* Restore queue textarea — chairs only */}
        {isChair && showRestore && (
          <div className="mb-3 border border-stone-200 dark:border-stone-700 rounded-lg p-3 bg-white dark:bg-stone-900">
            <label
              htmlFor="restore-queue"
              className="block text-xs font-medium text-stone-600 dark:text-stone-400 mb-1"
            >
              Paste queue items (one per line: "Type: topic")
            </label>
            <textarea
              id="restore-queue"
              value={restoreText}
              onChange={(e) => setRestoreText(e.target.value)}
              placeholder={
                'New Topic: My discussion point\nClarifying Question: How does this work?\nReply: I agree with the previous speaker\nPoint of Order: We should timebox this'
              }
              rows={5}
              className="w-full border border-stone-300 dark:border-stone-600 rounded px-3 py-2 text-sm mb-2
                         dark:bg-stone-700 dark:text-stone-100
                         focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500
                         font-mono"
            />
            <button
              onClick={handleRestoreQueue}
              disabled={!restoreText.trim()}
              className="bg-teal-500 text-white px-4 py-1.5 rounded text-sm font-medium
                         enabled:hover:bg-teal-600 transition-colors cursor-pointer
                         disabled:opacity-50 disabled:cursor-not-allowed
                         focus:outline-none focus:ring-2 focus:ring-teal-500 focus:ring-offset-2 dark:focus:ring-offset-stone-900"
            >
              Add to Queue
            </button>
          </div>
        )}

        {queuedSpeakers.length === 0 && !showRestore ? (
          <p className="text-stone-400 dark:text-stone-500 italic text-sm">The queue is empty.</p>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictDragBounds]}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={meeting.queue.orderedIds} strategy={verticalListSortingStrategy}>
              <ol aria-label="Queued speakers">
                {queuedSpeakers.map((entry, index) => (
                  <SortableQueueEntry
                    key={entry.id}
                    entry={entry}
                    index={index}
                    queue={queuedSpeakers}
                    isChair={isChair}
                    isOwnEntry={!!user && entry.userId === userKey(user)}
                    onDelete={handleRemoveEntry}
                    initialEditing={autoEditEntryId === entry.id}
                    onEditingStarted={onAutoEditConsumed}
                  />
                ))}
              </ol>
            </SortableContext>
          </DndContext>
        )}

        {meeting.queue.closed && !isChair && (
          <p className="text-stone-500 dark:text-stone-400 italic text-sm mt-3">
            The queue is closed. You can still raise a Point of Order.
          </p>
        )}
      </section>

      {/* Advance agenda item confirmation modal — always shown so the chair
          has somewhere to record the outgoing item's conclusion. The
          queue-clearing warning only renders when there are entries to
          clear; the conclusion textarea always renders. */}
      {showAdvanceConfirm && (
        <div
          className="fixed inset-0 top-[3rem] bg-black/30 flex items-center justify-center z-40"
          onClick={() => setShowAdvanceConfirm(false)}
          role="dialog"
          aria-label="Confirm agenda advancement"
          aria-modal="true"
        >
          <div
            className="bg-white dark:bg-stone-900 rounded-lg shadow-lg dark:shadow-stone-950/50 border border-stone-200 dark:border-stone-700 p-6 max-w-md w-full mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-stone-800 dark:text-stone-200 mb-2">Next Agenda Item</h3>
            <label
              htmlFor="agenda-conclusion"
              className="block text-xs font-medium text-stone-600 dark:text-stone-400 mb-1"
            >
              Conclusion (optional)
            </label>
            <textarea
              id="agenda-conclusion"
              value={conclusionDraft}
              onChange={(e) => setConclusionDraft(e.target.value)}
              placeholder="What was decided or concluded for this item?"
              rows={4}
              className="w-full border border-stone-300 dark:border-stone-600 rounded px-3 py-2 text-sm mb-3
                         dark:bg-stone-700 dark:text-stone-100
                         focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
            />
            {queuedSpeakers.length > 0 && (
              <p className="text-sm text-stone-600 dark:text-stone-400 mb-4">
                Advancing to the next agenda item will clear the speaker queue ({queuedSpeakers.length}{' '}
                {queuedSpeakers.length === 1 ? 'entry' : 'entries'}).
              </p>
            )}
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setShowAdvanceConfirm(false)}
                className="text-sm text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-300
                           transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                autoFocus
                onClick={() => {
                  // Capture the draft before resetting state. The server
                  // trims and treats blank as "clear conclusion".
                  const conclusion = conclusionDraft;
                  setShowAdvanceConfirm(false);
                  handleNextAgendaItem({ conclusion });
                }}
                className="bg-red-500 text-white px-4 py-1.5 rounded text-sm font-medium
                           hover:bg-red-600 transition-colors cursor-pointer
                           focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 dark:focus:ring-offset-stone-900"
              >
                Advance
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Poll setup modal — chair only (lazy-loaded to keep emoji-mart out of the main bundle) */}
      {showPollSetup && (
        <div
          className="fixed inset-0 top-[3rem] bg-black/30 flex items-center justify-center z-40"
          onClick={() => setShowPollSetup(false)}
          role="dialog"
          aria-label="Create poll"
          aria-modal="true"
        >
          <div
            className="bg-white dark:bg-stone-900 rounded-lg shadow-lg dark:shadow-stone-950/50 border border-stone-200 dark:border-stone-700 max-w-md w-full mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <Suspense fallback={<div className="p-6 text-stone-400">Loading&hellip;</div>}>
              <PollSetup onCancel={() => setShowPollSetup(false)} onStarted={() => setShowPollSetup(false)} />
            </Suspense>
          </div>
        </div>
      )}

      {/* Active poll modal — non-dismissable, visible to all */}
      {meeting.poll && (
        <div
          className="fixed inset-0 top-[3rem] bg-black/30 flex items-center justify-center z-40"
          role="dialog"
          aria-label="Active poll"
          aria-modal="true"
        >
          <div className="bg-white dark:bg-stone-900 rounded-lg shadow-lg dark:shadow-stone-950/50 border border-stone-200 dark:border-stone-700 mx-4 p-6 w-fit max-w-[80vw]">
            <PollReactions />
          </div>
        </div>
      )}
    </div>
  );
}

// -- Sortable queue entry component --

interface SortableQueueEntryProps {
  entry: QueueEntry;
  index: number;
  /** The full queue — needed to compute legal type changes. */
  queue: QueueEntry[];
  isChair: boolean;
  isOwnEntry: boolean;
  onDelete: (id: string) => void;
  /** When true, the entry renders in edit mode immediately. */
  initialEditing?: boolean;
  /** Called when the initial editing state has been consumed. */
  onEditingStarted?: () => void;
}

function SortableQueueEntry({
  entry,
  index,
  queue,
  isChair,
  isOwnEntry,
  onDelete,
  initialEditing = false,
  onEditingStarted,
}: SortableQueueEntryProps) {
  const { meeting } = useMeetingState();
  const socket = useSocket();
  const [editing, setEditing] = useState(initialEditing);
  const [editTopic, setEditTopic] = useState(initialEditing ? entry.topic : '');
  // Track whether we're in the initial editing state for a freshly created entry.
  // When true and the text hasn't been modified, Cancel/Escape removes the entry.
  const [isNewEntry, setIsNewEntry] = useState(initialEditing);

  // When initialEditing transitions to true, enter edit mode and
  // notify the parent so it can clear the flag.
  useEffect(() => {
    if (initialEditing && !editing) {
      setEditTopic(entry.topic); // eslint-disable-line react-hooks/set-state-in-effect
      setEditing(true);
      setIsNewEntry(true);
    }
    if (initialEditing) {
      onEditingStarted?.();
    }
  }, [initialEditing]); // eslint-disable-line react-hooks/exhaustive-deps

  // Ref callback for the edit input — focuses and selects text only
  // on initial mount, not on re-renders.
  const editInputRef = useCallback((el: HTMLInputElement | null) => {
    if (el) {
      el.focus();
      el.select();
    }
  }, []);

  // Whether this entry has any legal upward / downward move from its
  // current position. Chairs may move past anyone; non-chair owners may
  // only move up across their own contiguous block above.
  const canMoveUp = isChair ? index > 0 : isOwnEntry && index > 0 && queue[index - 1].userId === entry.userId;
  const canMoveDown = (isChair || isOwnEntry) && index < queue.length - 1;
  // Drag handle is only rendered when at least one direction is possible —
  // this naturally hides it for non-owners and for the no-valid-moves case
  // (e.g. a single-entry queue, or an own entry pinned at the bottom under
  // a non-owner entry).
  const canDrag = (isChair || isOwnEntry) && (canMoveUp || canMoveDown);

  /**
   * Compute which types this entry can legally be changed to without
   * breaking the priority ordering of the queue. A type is legal if
   * its priority is:
   * - >= the highest priority (lowest number) of items above
   * - <= the lowest priority (highest number) of items below
   * The entry's own current type is always included.
   */
  const legalTypes: QueueEntryType[] = (() => {
    // Priority bounds from neighbours
    let minPriority = 0; // highest possible priority (point-of-order)
    let maxPriority = QUEUE_ENTRY_TYPES.length - 1; // lowest possible priority (topic)

    // Constrain by items above: type must be at least as low-priority
    // as the lowest-priority item above
    for (let i = 0; i < index; i++) {
      const p = QUEUE_ENTRY_PRIORITY[queue[i].type];
      if (p > minPriority) minPriority = p;
    }

    // Constrain by items below: type must be at least as high-priority
    // as the highest-priority item below
    for (let i = index + 1; i < queue.length; i++) {
      const p = QUEUE_ENTRY_PRIORITY[queue[i].type];
      if (p < maxPriority) maxPriority = p;
    }

    // Build the list in low-to-high priority order (topic first) so
    // clicking cycles toward higher priority naturally.
    return QUEUE_ENTRY_TYPES.filter(
      (t) => QUEUE_ENTRY_PRIORITY[t] >= minPriority && QUEUE_ENTRY_PRIORITY[t] <= maxPriority,
    ).reverse();
  })();

  /** Cycle to the next legal type when the type badge is clicked. */
  function handleCycleType() {
    if (legalTypes.length <= 1) return;
    const currentIdx = legalTypes.indexOf(entry.type);
    const nextType = legalTypes[(currentIdx + 1) % legalTypes.length];
    socket?.emit('queue:edit', { id: entry.id, type: nextType });
  }

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: entry.id,
    disabled: !canDrag || editing,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const canEdit = isOwnEntry || isChair;
  const canDelete = isOwnEntry || isChair;

  /** Open the inline edit form, pre-populated with current topic. */
  function startEditing() {
    setEditTopic(entry.topic);
    setIsNewEntry(false);
    setEditing(true);
  }

  /** Submit the edit and close the form. */
  function handleEditSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = editTopic.trim();
    if (!trimmed) return;

    socket?.emit('queue:edit', { id: entry.id, topic: trimmed });
    setIsNewEntry(false);
    setEditing(false);
  }

  /** Cancel editing. If this is a new entry with unmodified text, delete it. */
  function handleEditCancel() {
    if (isNewEntry) {
      onDelete(entry.id);
    } else {
      setEditing(false);
    }
  }

  // --- Editing mode: inline form ---
  if (editing) {
    return (
      <li
        ref={setNodeRef}
        style={style}
        className={`flex items-center gap-2 pb-2 pt-1 px-2 rounded ${
          entry.type === 'point-of-order'
            ? 'bg-red-50 dark:bg-red-900/30 border border-red-300 dark:border-red-700 my-2'
            : `border-b border-stone-100 dark:border-stone-700 ${index % 2 === 0 ? 'bg-white dark:bg-stone-900' : 'bg-stone-100/50 dark:bg-stone-800/50'}`
        } ${entry.type !== 'point-of-order' && isOwnEntry ? 'border-l-3 border-l-teal-500 dark:border-l-teal-500' : ''}`}
      >
        {/* Placeholder for drag handle column */}
        {canDrag && <span className="w-4" />}

        <span className="text-lg font-semibold text-stone-400 dark:text-stone-500 tabular-nums min-w-[1.5rem] text-center">
          {index + 1}
        </span>

        <form onSubmit={handleEditSubmit} className="flex-1 flex items-center gap-2">
          {/* Show the type badge (not editable inline) */}
          <span className={`text-sm font-semibold shrink-0 ${entryTypeColor(entry.type)}`}>
            {entryTypeLabel(entry.type)}:
          </span>
          <input
            type="text"
            value={editTopic}
            onChange={(e) => setEditTopic(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') handleEditCancel();
            }}
            required
            aria-label="Topic description"
            // Focus and select all text on mount so the user can
            // immediately start typing to replace the placeholder.
            // Uses a stable ref via useCallback to run only once.
            ref={editInputRef}
            className="border border-stone-300 dark:border-stone-600 rounded px-2 py-0.5 text-sm flex-1 min-w-[100px]
                       dark:bg-stone-700 dark:text-stone-100
                       focus:outline-none focus:ring-1 focus:ring-teal-500"
          />
          <button
            type="submit"
            className="text-xs text-teal-600 dark:text-teal-400 hover:text-teal-800 dark:hover:text-teal-300 font-medium cursor-pointer"
          >
            Save
          </button>
          <button
            type="button"
            onClick={handleEditCancel}
            className="text-xs text-stone-400 dark:text-stone-500 hover:text-stone-600 dark:hover:text-stone-300 cursor-pointer"
          >
            Cancel
          </button>
        </form>
      </li>
    );
  }

  // --- Display mode ---
  return (
    <li
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-2 pb-2 pt-1 px-2 rounded ${
        isDragging
          ? 'opacity-50 bg-stone-200 dark:bg-stone-700'
          : entry.type === 'point-of-order'
            ? 'bg-red-50 dark:bg-red-900/30 border border-red-300 dark:border-red-700 my-2'
            : `border-b border-stone-100 dark:border-stone-700 ${index % 2 === 0 ? 'bg-white dark:bg-stone-900' : 'bg-stone-100/50 dark:bg-stone-800/50'}`
      } ${entry.type !== 'point-of-order' && isOwnEntry ? 'border-l-3 border-l-teal-500 dark:border-l-teal-500' : ''}`}
    >
      {/* Drag handle — rendered only when the entry has at least one legal
          move from its current position. The cursor advertises which
          directions are legal: ns-resize for both, n-resize for up only,
          s-resize for down only. */}
      {canDrag && (
        <span
          className={`text-stone-300 dark:text-stone-600 hover:text-stone-500 dark:hover:text-stone-400 ${
            canMoveUp && canMoveDown ? 'cursor-ns-resize' : canMoveUp ? 'cursor-n-resize' : 'cursor-s-resize'
          } select-none text-sm leading-none presentation-hidden`}
          aria-label={`Drag to reorder: ${entry.topic}`}
          {...attributes}
          {...listeners}
        >
          ⠿
        </span>
      )}

      {/* Position number */}
      <span className="text-lg font-semibold text-stone-400 dark:text-stone-500 tabular-nums min-w-[1.5rem] text-center">
        {index + 1}
      </span>

      <div className="flex-1 min-w-0">
        {/* Type badge and topic — chairs can click to cycle through legal types */}
        {isChair && legalTypes.length > 1 ? (
          <button
            onClick={handleCycleType}
            className={`text-sm font-semibold cursor-pointer hover:underline ${entryTypeColor(entry.type)}`}
            title={`Click to change type (${legalTypes.map(entryTypeLabel).join(' → ')})`}
            aria-label={`Change type from ${entryTypeLabel(entry.type)}`}
          >
            {entryTypeLabel(entry.type)}:
          </button>
        ) : (
          <span className={`text-sm font-semibold ${entryTypeColor(entry.type)}`}>{entryTypeLabel(entry.type)}:</span>
        )}
        <InlineMarkdown className="ml-1 text-stone-800 dark:text-stone-200">{entry.topic}</InlineMarkdown>

        {/* Speaker info */}
        <div className="text-sm text-stone-500 dark:text-stone-400">
          <UserBadge user={meeting?.users[entry.userId]} size={16} />
        </div>
      </div>

      {/* Edit and delete buttons — right-aligned */}
      {(canEdit || canDelete) && (
        <div className="flex gap-3 shrink-0 presentation-hidden">
          {canEdit && (
            <button
              onClick={startEditing}
              className="text-xs text-stone-400 dark:text-stone-500 hover:text-teal-600 dark:hover:text-teal-400
                         transition-colors cursor-pointer"
              aria-label={`Edit entry: ${entry.topic}`}
            >
              Edit
            </button>
          )}
          {canDelete && (
            <button
              onClick={() => onDelete(entry.id)}
              className="text-xs text-stone-400 dark:text-stone-500 hover:text-red-600 dark:hover:text-red-400
                         transition-colors cursor-pointer"
              aria-label={`Delete entry: ${entry.topic}`}
            >
              Delete
            </button>
          )}
        </div>
      )}
    </li>
  );
}

/** Map a queue entry type to its display label. */
function entryTypeLabel(type: string): string {
  return QUEUE_ENTRY_LABELS[type as QueueEntryType] ?? type;
}

/** Map a display label back to a queue entry type. Case-insensitive. */
function parseEntryType(label: string): QueueEntryType | null {
  switch (label.toLowerCase()) {
    case 'new topic':
      return 'topic';
    case 'reply':
      return 'reply';
    case 'clarifying question':
      return 'question';
    case 'point of order':
      return 'point-of-order';
    default:
      return null;
  }
}

/** Map a queue entry type to a Tailwind text colour class. */
function entryTypeColor(type: string): string {
  switch (type) {
    case 'topic':
      return 'text-blue-600';
    case 'reply':
      return 'text-cyan-600';
    case 'question':
      return 'text-green-600';
    case 'point-of-order':
      return 'text-red-600 dark:text-red-400';
    default:
      return 'text-stone-600 dark:text-stone-400';
  }
}
