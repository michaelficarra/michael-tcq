/**
 * Queue tab panel — displays the current agenda item, current speaker,
 * speaker controls, and the speaker queue.
 *
 * The agenda item section shows Start Meeting / Next Agenda Item buttons
 * for chairs. The speaker section shows the current speaker with a
 * Next Speaker button for chairs. Below that are the entry type buttons
 * and the queue list with drag-and-drop reordering for chairs.
 */

import { lazy, memo, Suspense, useState, useEffect, useCallback, useMemo, useRef, type FormEvent } from 'react';
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
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers';
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
  onAddEntry: (type: import('@tcq/shared').QueueEntryType) => void;
  /** Called when the user picks a canned response from the dropdown.
   *  Adds a finished topic entry — no pending state, no auto-edit. */
  onCannedResponse: (text: string) => void;
  /** Called when the auto-edit has been consumed by the entry component. */
  onAutoEditConsumed: () => void;
  /** Hide the panel when not the active tab (rendered but excluded from a11y tree). */
  hidden?: boolean;
}

export function QueuePanel({
  autoEditEntryId,
  onAddEntry,
  onCannedResponse,
  onAutoEditConsumed,
  hidden = false,
}: QueuePanelProps) {
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
  // Memoised so that unrelated meeting-state changes (poll updates, current
  // speaker advances, etc.) don't break referential equality on the array
  // passed to memo'd SortableQueueEntry children. The reference only changes
  // when the queue itself changes (entry add/remove/edit/reorder).
  const queue = meeting?.queue;
  const queuedSpeakers = useMemo(
    () => (queue ? queue.orderedIds.map((id) => queue.entries[id]).filter(Boolean) : []),
    [queue],
  );

  // Per-entry drag/edit eligibility and the legal type-change set, computed
  // once at the panel rather than per-entry. The original per-entry form
  // walked the whole queue (O(N²) total) and forced `SortableQueueEntry` to
  // take the queue array as a prop — which broke its `memo` on every queue
  // mutation. Lifting these here lets each child receive only stable
  // primitives and a memo-stable `legalTypes` array reference, so children
  // skip re-renders when other state changes.
  const ownerKey = user ? userKey(user) : null;
  const derivationsByEntryId = useMemo(() => {
    const map = new Map<string, QueueEntryDerivations>();
    const n = queuedSpeakers.length;
    if (n === 0) return map;

    // Two cumulative passes so each entry's legal-type bounds are an O(1)
    // lookup. `minPriorityAbove[i]` is the highest priority value seen at
    // positions 0..i-1; `maxPriorityBelow[i]` is the lowest seen at i+1..n-1.
    const minPriorityAbove = new Array<number>(n);
    let cur = 0;
    for (let i = 0; i < n; i++) {
      minPriorityAbove[i] = cur;
      const p = QUEUE_ENTRY_PRIORITY[queuedSpeakers[i].type];
      if (p > cur) cur = p;
    }
    const maxPriorityBelow = new Array<number>(n);
    cur = QUEUE_ENTRY_TYPES.length - 1;
    for (let i = n - 1; i >= 0; i--) {
      maxPriorityBelow[i] = cur;
      const p = QUEUE_ENTRY_PRIORITY[queuedSpeakers[i].type];
      if (p < cur) cur = p;
    }

    for (let i = 0; i < n; i++) {
      const entry = queuedSpeakers[i];
      const isOwnEntry = ownerKey !== null && entry.userId === ownerKey;
      // Chairs may move any entry past anyone; non-chair owners may only
      // move up across their own contiguous block above. Mirrors the
      // server-side validator.
      const canMoveUp = isChair ? i > 0 : isOwnEntry && i > 0 && queuedSpeakers[i - 1].userId === entry.userId;
      const canMoveDown = (isChair || isOwnEntry) && i < n - 1;
      const canDrag = (isChair || isOwnEntry) && (canMoveUp || canMoveDown);

      const minP = minPriorityAbove[i];
      const maxP = maxPriorityBelow[i];
      // Built in low-to-high priority order (topic first) so clicking the
      // type badge cycles toward higher priority naturally.
      const legalTypes = QUEUE_ENTRY_TYPES.filter(
        (t) => QUEUE_ENTRY_PRIORITY[t] >= minP && QUEUE_ENTRY_PRIORITY[t] <= maxP,
      ).reverse();

      map.set(entry.id, { isOwnEntry, canMoveUp, canMoveDown, canDrag, legalTypes });
    }
    return map;
  }, [queuedSpeakers, isChair, ownerKey]);

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

  // Commit the conclusion-dialog draft and advance to the next agenda item.
  // Shared between the Advance button and the Ctrl/Cmd+Enter shortcut in
  // the textarea so both paths emit identically.
  const confirmAdvance = useCallback(() => {
    // Capture the draft before resetting state. The server trims and
    // treats blank as "clear conclusion".
    const conclusion = conclusionDraft;
    setShowAdvanceConfirm(false);
    handleNextAgendaItem({ conclusion });
  }, [conclusionDraft, handleNextAgendaItem]);

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
    // Clear any stale bounds before computing fresh ones — guards against the
    // (currently impossible but cheap-to-prevent) case where a previous drag
    // ended without firing handleDragEnd / handleDragCancel and one of the
    // early returns below leaves bounds unset for this drag.
    dragBoundsRef.current = null;
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

  /**
   * Remove a queue entry (own entry, or any entry if chair). Stable across
   * renders so memo'd SortableQueueEntry children don't invalidate.
   */
  const handleRemoveEntry = useCallback(
    (entryId: string) => {
      socket?.emit('queue:remove', { id: entryId });
    },
    [socket],
  );

  // When hidden (not the active tab) or meeting state not yet loaded, render
  // only the empty tabpanel shell. Keeping the shell in the DOM avoids the
  // mount/unmount race on tab switch; skipping the inner content avoids
  // re-rendering the whole panel on every state broadcast while the user is
  // on another tab.
  if (hidden || !meeting) {
    return <div id="panel-queue" role="tabpanel" aria-label="Queue" hidden={hidden} className="p-6 space-y-6" />;
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
   * Drag cancellation (e.g. Escape pressed mid-drag) — clear bounds so the
   * next drag computes a fresh range. handleDragEnd does not fire on cancel.
   */
  function handleDragCancel() {
    dragBoundsRef.current = null;
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
              {/* On the last item the same dialog is reused to record the
                  final item's conclusion — the button label switches to
                  "Conclude meeting" so it's clear the action ends the
                  meeting rather than stepping to a next item. */}
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
                {hasMoreAgendaItems ? 'Next Agenda Item' : 'Conclude meeting'}
              </button>
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
                  className="ml-2 text-xs text-stone-600 dark:text-stone-300 tabular-nums"
                  overAfterMinutes={currentAgendaItem.duration}
                />
              )}
            </div>
          </div>
        ) : meeting.current.startedAt ? (
          // Past-final: the chair advanced past the last item. No
          // current item, but `startedAt` distinguishes this from
          // pre-start so we show a "concluded" hint instead of "waiting
          // to start". Adding a new agenda item from the Agenda tab
          // auto-activates it (server-side) and the meeting resumes.
          <div className="pl-3">
            <p className="text-stone-500 dark:text-stone-400">
              Meeting concluded &mdash; add a new agenda item to continue.
            </p>
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
                             ? 'opacity-50 cursor-not-allowed text-stone-600 dark:text-stone-300'
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
      <SpeakerControls onAddEntry={onAddEntry} onCannedResponse={onCannedResponse} />

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
              className="bg-teal-700 text-white px-4 py-1.5 rounded text-sm font-medium
                         enabled:hover:bg-teal-800 transition-colors cursor-pointer
                         disabled:opacity-50 disabled:cursor-not-allowed
                         focus:outline-none focus:ring-2 focus:ring-teal-500 focus:ring-offset-2 dark:focus:ring-offset-stone-900"
            >
              Add to Queue
            </button>
          </div>
        )}

        {queuedSpeakers.length === 0 && !showRestore ? (
          <p className="text-stone-600 dark:text-stone-300 italic text-sm">The queue is empty.</p>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            // Order matters: built-ins run first to lock the X axis and keep
            // the ghost inside the queue list (the parent <ol>), then our
            // custom modifier clamps Y to the legal index range computed at
            // drag start.
            modifiers={[restrictToVerticalAxis, restrictToParentElement, restrictDragBounds]}
            onDragStart={handleDragStart}
            onDragCancel={handleDragCancel}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={meeting.queue.orderedIds} strategy={verticalListSortingStrategy}>
              <ol aria-label="Queued speakers">
                {queuedSpeakers.map((entry, index) => {
                  const d = derivationsByEntryId.get(entry.id);
                  if (!d) return null;
                  return (
                    <SortableQueueEntry
                      key={entry.id}
                      entry={entry}
                      index={index}
                      isChair={isChair}
                      isOwnEntry={d.isOwnEntry}
                      canMoveUp={d.canMoveUp}
                      canMoveDown={d.canMoveDown}
                      canDrag={d.canDrag}
                      legalTypes={d.legalTypes}
                      onDelete={handleRemoveEntry}
                      initialEditing={autoEditEntryId === entry.id}
                      onEditingStarted={onAutoEditConsumed}
                    />
                  );
                })}
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
              // Focus on open so the chair can start typing immediately
              // without having to click into the field.
              autoFocus
              value={conclusionDraft}
              onChange={(e) => setConclusionDraft(e.target.value)}
              onKeyDown={(e) => {
                // Ctrl/Cmd+Enter submits the dialog — the chair can advance
                // without leaving the keyboard. A bare Enter keeps inserting
                // newlines so multi-line conclusions still work.
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  confirmAdvance();
                }
              }}
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
                className="text-sm text-stone-600 dark:text-stone-300 hover:text-stone-800 dark:hover:text-stone-100
                           transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={confirmAdvance}
                className="bg-red-600 text-white px-4 py-1.5 rounded text-sm font-medium
                           hover:bg-red-700 transition-colors cursor-pointer
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

/**
 * Per-entry state that depends on the entry's position within the queue
 * (and on chair/ownership). Computed once at the panel level so children
 * receive memo-stable references and don't re-walk the queue per render.
 */
interface QueueEntryDerivations {
  isOwnEntry: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  canDrag: boolean;
  legalTypes: QueueEntryType[];
}

interface SortableQueueEntryProps extends QueueEntryDerivations {
  entry: QueueEntry;
  index: number;
  isChair: boolean;
  onDelete: (id: string) => void;
  /** When true, the entry renders in edit mode immediately. */
  initialEditing?: boolean;
  /** Called when the initial editing state has been consumed. */
  onEditingStarted?: () => void;
}

const SortableQueueEntry = memo(function SortableQueueEntry({
  entry,
  index,
  isChair,
  isOwnEntry,
  canMoveUp,
  canMoveDown,
  canDrag,
  legalTypes,
  onDelete,
  initialEditing = false,
  onEditingStarted,
}: SortableQueueEntryProps) {
  const { meeting } = useMeetingState();
  const socket = useSocket();

  // The entry is "pending" when the server has it in the initial-editing
  // state — the author just added it and hasn't finalised. All viewers see
  // a typing-indicator (bouncing dots) instead of the topic; the owner
  // additionally sees the inline editor. The pending flag clears via
  // `queue:finalize` (Save/Cancel/Escape) or on the author's disconnect.
  const isPending = entry.pending === true;

  // Open the editor automatically when:
  //   - this is the author's freshly-added pending entry (`isPending &&
  //     isOwnEntry`), or
  //   - the parent flagged this entry via `autoEditEntryId` (legacy /
  //     post-edit-pencil case).
  // Once cleared (Save/Cancel), `editing` goes false; the pending flag
  // also clears via the server delta, so we won't reopen.
  const shouldOpenInitially = (isPending && isOwnEntry) || initialEditing;
  const [editing, setEditing] = useState(shouldOpenInitially);
  // Both pending entries (server stamps the default-for-type as the
  // topic) and pencil-edits on already-saved entries pre-fill with the
  // current `entry.topic`. The input is pre-selected on mount so the
  // author can either type over the default or submit it as-is.
  const [editTopic, setEditTopic] = useState(shouldOpenInitially ? entry.topic : '');

  // When `initialEditing` or `isPending` flips on while we're not yet in
  // edit mode (e.g. the `queue:added` delta just arrived for the author's
  // own add), enter edit mode and notify the parent so it can clear
  // `autoEditEntryId`.
  useEffect(() => {
    if (shouldOpenInitially && !editing) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setEditTopic(entry.topic);
      setEditing(true);
    }
    if (initialEditing) {
      onEditingStarted?.();
    }
  }, [shouldOpenInitially, initialEditing]); // eslint-disable-line react-hooks/exhaustive-deps

  // Ref callback for the edit input — focuses and selects text only
  // on initial mount, not on re-renders.
  const editInputRef = useCallback((el: HTMLInputElement | null) => {
    if (el) {
      el.focus();
      el.select();
    }
  }, []);

  // `canMoveUp`, `canMoveDown`, `canDrag`, and `legalTypes` are computed
  // once at the panel level (see `derivationsByEntryId` in QueuePanel) and
  // arrive here as stable props. The drag handle is only rendered when at
  // least one direction is possible — this naturally hides it for
  // non-owners and for the no-valid-moves case (e.g. a single-entry queue,
  // or an own entry pinned at the bottom under a non-owner entry).

  /** Cycle to the next legal type when the type badge is clicked. */
  function handleCycleType() {
    if (legalTypes.length <= 1) return;
    const currentIdx = legalTypes.indexOf(entry.type);
    const nextType = legalTypes[(currentIdx + 1) % legalTypes.length];
    socket?.emit('queue:edit', { id: entry.id, type: nextType });
  }

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: entry.id,
    // Stays draggable while editing — owner/chair can reorder mid-edit and
    // the in-progress form state survives because the component is keyed by
    // entry.id in the parent list. The position/ownership rules in canDrag
    // still apply unchanged.
    disabled: !canDrag,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  // Shared drag handle used in both display and editing modes. Cursor
  // direction reflects the legal moves for this entry's current position;
  // when no move is legal, the handle is omitted.
  const dragHandle = canDrag ? (
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
  ) : null;

  // Pencil-edit is suppressed while the entry is pending: the owner's
  // editor is auto-open via the pending flow, and a chair-driven
  // `queue:edit` here wouldn't clear `pending`, leaving the dots stuck.
  // Delete remains available so a chair can clean up an abandoned pending
  // entry (e.g. the author's socket survived disconnect-finalise somehow).
  const canEdit = (isOwnEntry || isChair) && !isPending;
  const canDelete = isOwnEntry || isChair;

  // Premium-tier owners get an animated gradient/glow border around their
  // entry. The flag is server-stamped on the user record at broadcast time
  // (omitted when false), so absence means a regular user.
  const isPremiumEntry = !!meeting?.users[entry.userId]?.isPremium;
  // The premium border lives on the outer <li>; the existing visual classes
  // (background, borders, padding) all move to an inner <div> so the
  // gradient on the <li>'s pseudo-elements peeks out through the 4px
  // padding instead of being masked by the entry's own background. For
  // this to work the inner background must be fully opaque — the
  // point-of-order tint is therefore solid in dark mode for premium
  // entries (zebra striping is opaque unconditionally; see below).
  const outerClass = isPremiumEntry ? 'premium-border my-1' : '';
  const pointOfOrderBg = isPremiumEntry ? 'bg-red-50 dark:bg-red-900' : 'bg-red-50 dark:bg-red-900/30';

  /** Open the inline edit form, pre-populated with current topic. */
  function startEditing() {
    setEditTopic(entry.topic);
    setEditing(true);
  }

  /**
   * Submit the edit and close the form.
   *
   * - Non-empty input on a pending entry: emit `queue:edit` with the
   *   typed topic. The server clears `pending` as part of handling the
   *   edit (any edit on a pending entry counts as the finalisation).
   * - Empty input on a pending entry: treat as cancel — remove the entry.
   *   The input is pre-filled with the default-for-type, so reaching
   *   empty requires the author to have deliberately cleared it.
   * - Non-pending pencil-edit: emit `queue:edit` with the topic; reject
   *   empty input (existing entries can't be edited to nothing).
   */
  function handleEditSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = editTopic.trim();
    if (isPending) {
      if (trimmed) {
        socket?.emit('queue:edit', { id: entry.id, topic: trimmed });
      } else {
        socket?.emit('queue:remove', { id: entry.id });
      }
      setEditing(false);
      return;
    }
    if (!trimmed) return;
    socket?.emit('queue:edit', { id: entry.id, topic: trimmed });
    setEditing(false);
  }

  /**
   * Cancel editing. For pending entries, remove the entry from the queue
   * (the entry only exists because the author was composing; cancelling
   * means they changed their mind). For non-pending entries, just close
   * the editor — the saved state is unchanged.
   */
  function handleEditCancel() {
    if (isPending) {
      socket?.emit('queue:remove', { id: entry.id });
      setEditing(false);
      return;
    }
    setEditing(false);
  }

  // --- Editing mode: inline form ---
  if (editing) {
    return (
      <li ref={setNodeRef} style={style} className={outerClass}>
        <div
          className={`flex items-center gap-2 pb-2 pt-1 px-2 rounded ${
            entry.type === 'point-of-order'
              ? `${pointOfOrderBg} border border-red-300 dark:border-red-700 my-2`
              : `border-b border-stone-100 dark:border-stone-700 ${index % 2 === 0 ? 'bg-white dark:bg-stone-900' : 'bg-stone-100 dark:bg-stone-800'}`
          } ${entry.type !== 'point-of-order' && isOwnEntry ? 'border-l-3 border-l-teal-500 dark:border-l-teal-500' : ''}`}
        >
          {dragHandle}

          <span className="text-lg font-semibold text-stone-600 dark:text-stone-300 tabular-nums min-w-[1.5rem] text-center select-none">
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
              // Pending entries allow empty submit (server falls through to
              // the default-for-type topic). Pencil-edits on already-saved
              // entries still require non-empty.
              required={!isPending}
              aria-label="Topic description"
              // Focus and select all text on mount so the user can
              // immediately start typing. (For pending entries the input
              // starts empty, so the select is a no-op.)
              ref={editInputRef}
              className="border border-stone-300 dark:border-stone-600 rounded px-2 py-0.5 text-sm flex-1 min-w-[100px]
                         dark:bg-stone-700 dark:text-stone-100
                         focus:outline-none focus:ring-1 focus:ring-teal-500"
            />
            <button
              type="submit"
              className="text-xs text-teal-700 dark:text-teal-400 hover:text-teal-800 dark:hover:text-teal-300 font-medium cursor-pointer"
            >
              Save
            </button>
            <button
              type="button"
              onClick={handleEditCancel}
              className="text-xs text-stone-600 dark:text-stone-300 hover:text-stone-600 dark:hover:text-stone-300 cursor-pointer"
            >
              Cancel
            </button>
          </form>
        </div>
      </li>
    );
  }

  // --- Display mode ---
  return (
    <li ref={setNodeRef} style={style} className={outerClass}>
      <div
        className={`flex items-center gap-2 pb-2 pt-1 px-2 rounded ${
          isDragging
            ? 'opacity-50 bg-stone-200 dark:bg-stone-700'
            : entry.type === 'point-of-order'
              ? `${pointOfOrderBg} border border-red-300 dark:border-red-700 my-2`
              : `border-b border-stone-100 dark:border-stone-700 ${index % 2 === 0 ? 'bg-white dark:bg-stone-900' : 'bg-stone-100 dark:bg-stone-800'}`
        } ${entry.type !== 'point-of-order' && isOwnEntry ? 'border-l-3 border-l-teal-500 dark:border-l-teal-500' : ''}`}
      >
        {/* Drag handle — rendered only when the entry has at least one legal
            move from its current position. The cursor advertises which
            directions are legal: ns-resize for both, n-resize for up only,
            s-resize for down only. The same handle is used in the editing
            branch above so reorder stays available mid-edit. */}
        {dragHandle}

        {/* Position number */}
        <span className="text-lg font-semibold text-stone-600 dark:text-stone-300 tabular-nums min-w-[1.5rem] text-center select-none">
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
          {isPending ? (
            <span
              className="tcq-typing-dots ml-1 text-stone-500 dark:text-stone-400 align-middle"
              role="status"
              aria-label="Composing topic"
            >
              <span />
              <span />
              <span />
            </span>
          ) : (
            <InlineMarkdown className="ml-1 text-stone-800 dark:text-stone-200">{entry.topic}</InlineMarkdown>
          )}

          {/* Speaker info */}
          <div className="text-sm text-stone-600 dark:text-stone-300">
            <UserBadge user={meeting?.users[entry.userId]} size={16} />
          </div>
        </div>

        {/* Edit and delete buttons — right-aligned */}
        {(canEdit || canDelete) && (
          <div className="flex gap-3 shrink-0 presentation-hidden">
            {canEdit && (
              <button
                onClick={startEditing}
                className="text-xs text-stone-600 dark:text-stone-300 hover:text-teal-600 dark:hover:text-teal-400
                           transition-colors cursor-pointer"
                aria-label={`Edit entry: ${entry.topic}`}
              >
                Edit
              </button>
            )}
            {canDelete && (
              <button
                onClick={() => onDelete(entry.id)}
                className="text-xs text-stone-600 dark:text-stone-300 hover:text-red-600 dark:hover:text-red-400
                           transition-colors cursor-pointer"
                aria-label={`Delete entry: ${entry.topic}`}
              >
                Delete
              </button>
            )}
          </div>
        )}
      </div>
    </li>
  );
});

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
      return 'text-blue-700 dark:text-blue-400';
    case 'reply':
      return 'text-cyan-700 dark:text-cyan-400';
    case 'question':
      return 'text-green-700 dark:text-green-400';
    case 'point-of-order':
      return 'text-red-700 dark:text-red-400';
    default:
      return 'text-stone-600 dark:text-stone-400';
  }
}
