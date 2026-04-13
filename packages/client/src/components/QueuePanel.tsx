/**
 * Queue tab panel — displays the current agenda item, current speaker,
 * speaker controls, and the speaker queue.
 *
 * The agenda item section shows Start Meeting / Next Agenda Item buttons
 * for chairs. The speaker section shows the current speaker with a
 * Next Speaker button for chairs. Below that are the entry type buttons
 * and the queue list with drag-and-drop reordering for chairs.
 */

import { useState, useEffect, useCallback, useRef, type FormEvent } from 'react';
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
import type { QueueEntry, QueueEntryType } from '@tcq/shared';
import { QUEUE_ENTRY_TYPES, QUEUE_ENTRY_PRIORITY } from '@tcq/shared';
import { useMeetingState, useIsChair } from '../contexts/MeetingContext.js';
import { useSocket } from '../contexts/SocketContext.js';
import { useAdvanceAction } from '../hooks/useAdvanceAction.js';
import { SpeakerControls } from './SpeakerControls.js';
import { UserBadge } from './UserBadge.js';
import { TemperatureCheck } from './TemperatureCheck.js';
import { TemperatureSetup } from './TemperatureSetup.js';

export function QueuePanel() {
  const { meeting, user } = useMeetingState();
  const isChair = useIsChair();
  const socket = useSocket();

  // Whether the temperature check setup form is open
  const [showTempSetup, setShowTempSetup] = useState(false);

  // ID of a newly added queue entry that should open in edit mode.
  // Set by SpeakerControls after adding an entry with placeholder text.
  const [autoEditEntryId, setAutoEditEntryId] = useState<string | null>(null);

  // Advancement actions with automatic retry on stale version
  const handleNextAgendaItem = useAdvanceAction('meeting:nextAgendaItem');
  const handleNextSpeaker = useAdvanceAction('queue:next');

  // Drag-and-drop sensors with keyboard support for accessibility
  const sensors = useSensors(
    useSensor(PointerSensor, {
      // Require a small drag distance before activating, so that clicks
      // on buttons (e.g. delete) inside the draggable row work normally.
      activationConstraint: { distance: 5 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  // Track whether the current drag is a non-chair self-drag (downward only).
  // When true, the drag modifier clamps upward movement.
  const restrictUpwardRef = useRef(false);

  /** Called when a drag starts — determine if we need to restrict direction. */
  function handleDragStart(event: DragStartEvent) {
    if (!meeting || !user) return;
    const entry = meeting.queuedSpeakers.find((e) => e.id === event.active.id);
    if (!entry) return;
    const isOwner = entry.user.ghUsername.toLowerCase() === user.ghUsername.toLowerCase();
    // Restrict upward movement for non-chair owners
    restrictUpwardRef.current = isOwner && !isChair;
  }

  /**
   * Custom dnd-kit modifier that prevents dragging above the starting
   * position. Used for non-chair participants who can only defer (move
   * down), not jump ahead.
   */
  const restrictDownwardOnly: Modifier = useCallback(({ transform }) => {
    if (restrictUpwardRef.current && transform.y < 0) {
      // Clamp upward movement to zero
      return { ...transform, y: 0 };
    }
    return transform;
  }, []);

  if (!meeting) return null;

  /** Remove a queue entry (own entry, or any entry if chair). */
  function handleRemoveEntry(entryId: string) {
    socket?.emit('queue:remove', { id: entryId });
  }

  // Whether the restore queue textarea is open
  const [showRestore, setShowRestore] = useState(false);
  const [restoreText, setRestoreText] = useState('');

  /**
   * Copy the queue to the clipboard in a human-readable text format.
   * Each line: "Type: topic (username)"
   */
  function handleCopyQueue() {
    if (!meeting) return;
    const text = meeting.queuedSpeakers
      .map((e) => `${entryTypeLabel(e.type)}: ${e.topic} (${e.user.ghUsername})`)
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
        asUsername = parenMatch[2].trim();
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
    if (!over || active.id === over.id || !meeting) return;

    const items = meeting.queuedSpeakers;
    const oldIndex = items.findIndex((e) => e.id === active.id);
    const newIndex = items.findIndex((e) => e.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

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

    socket?.emit('queue:reorder', { id: active.id as string, afterId });
  }

  // Determine whether there are more agenda items after the current one
  const hasMoreAgendaItems = (() => {
    if (!meeting.currentAgendaItem) {
      return meeting.agenda.length > 0;
    }
    const currentIndex = meeting.agenda.findIndex(
      (item) => item.id === meeting.currentAgendaItem!.id,
    );
    return currentIndex < meeting.agenda.length - 1;
  })();

  return (
    <div id="panel-queue" role="tabpanel" aria-label="Queue" className="p-6 space-y-6">
      {/* --- Agenda Item Section --- */}
      <section aria-labelledby="agenda-item-heading">
        <h2
          id="agenda-item-heading"
          className="text-xs font-bold uppercase tracking-wider text-blue-600 mb-1"
        >
          Agenda Item
        </h2>

        {meeting.currentAgendaItem ? (
          <div>
            <p className="text-stone-800 font-medium">
              {meeting.currentAgendaItem.name}
            </p>
            <div className="text-sm text-stone-500 flex flex-wrap items-center gap-x-2">
              <UserBadge user={meeting.currentAgendaItem.owner} size={18} />
              {meeting.currentAgendaItem.timebox != null && meeting.currentAgendaItem.timebox > 0 && (
                <span className="ml-2">
                  {meeting.currentAgendaItem.timebox}{' '}
                  {meeting.currentAgendaItem.timebox === 1 ? 'minute' : 'minutes'}
                </span>
              )}

              {/* Next Agenda Item button — chair only */}
              {isChair && hasMoreAgendaItems && (
                <button
                  onClick={handleNextAgendaItem}
                  className="ml-3 border border-stone-300 rounded px-2 py-0.5 text-xs
                             text-stone-600 hover:bg-stone-100 transition-colors cursor-pointer"
                >
                  Next Agenda Item
                </button>
              )}
            </div>

            {/* Temperature check controls — chair only */}
            {isChair && (
              meeting.trackTemperature ? (
                <button
                  onClick={() => socket?.emit('temperature:stop')}
                  className="mt-2 border border-stone-300 rounded px-3 py-1 text-sm
                             text-stone-700 hover:bg-stone-100 transition-colors cursor-pointer"
                >
                  Stop Temperature Check
                </button>
              ) : showTempSetup ? (
                <TemperatureSetup
                  onCancel={() => setShowTempSetup(false)}
                  onStarted={() => setShowTempSetup(false)}
                />
              ) : (
                <button
                  onClick={() => setShowTempSetup(true)}
                  className="mt-2 border border-stone-300 rounded px-3 py-1 text-sm
                             text-stone-700 hover:bg-stone-100 transition-colors cursor-pointer"
                >
                  Check Temperature
                </button>
              )
            )}

            {/* Temperature check reaction panel — visible to all when active */}
            <TemperatureCheck />
          </div>
        ) : (
          <div>
            <p className="text-stone-500">
              Waiting for the meeting to start&hellip;
            </p>
            {/* Start Meeting button — chair only */}
            {isChair && meeting.agenda.length > 0 && (
              <button
                onClick={handleNextAgendaItem}
                className="mt-2 border border-stone-300 rounded px-3 py-1 text-sm
                           text-stone-700 hover:bg-stone-100 transition-colors cursor-pointer"
              >
                Start Meeting
              </button>
            )}
          </div>
        )}
      </section>

      {/* --- Current Topic Section --- */}
      {meeting.currentTopic && (
        <section aria-labelledby="topic-heading">
          <h2
            id="topic-heading"
            className="text-xs font-bold uppercase tracking-wider text-blue-600 mb-1"
          >
            Topic
          </h2>
          <p className="text-stone-800">{meeting.currentTopic.topic}</p>
          <UserBadge user={meeting.currentTopic.user} size={18} className="text-sm text-stone-500" />
        </section>
      )}

      {/* --- Current Speaker Section --- */}
      <section aria-labelledby="speaking-heading">
        <h2
          id="speaking-heading"
          className="text-xs font-bold uppercase tracking-wider text-stone-800 mb-1"
        >
          Speaking
        </h2>

        {meeting.currentSpeaker ? (
          <div>
            <UserBadge user={meeting.currentSpeaker.user} size={22} className="text-stone-800 font-medium" />
            <p className="text-sm text-stone-500">
              {meeting.currentSpeaker.topic}
            </p>

            {/* Next Speaker button — chair only */}
            {isChair && (
              <button
                onClick={handleNextSpeaker}
                className="mt-2 border border-stone-300 rounded px-3 py-1 text-sm
                           text-stone-700 hover:bg-stone-100 transition-colors cursor-pointer"
              >
                Next Speaker
              </button>
            )}
          </div>
        ) : (
          <div>
            <p className="text-stone-500">
              Nobody speaking yet&hellip; enter the queue to get started
            </p>

            {/* Next Speaker button when nobody is speaking — starts from queue */}
            {isChair && meeting.queuedSpeakers.length > 0 && (
              <button
                onClick={handleNextSpeaker}
                className="mt-2 border border-stone-300 rounded px-3 py-1 text-sm
                           text-stone-700 hover:bg-stone-100 transition-colors cursor-pointer"
              >
                Next Speaker
              </button>
            )}
          </div>
        )}
      </section>

      {/* --- Speaker Entry Controls --- */}
      <SpeakerControls onEntryAdded={setAutoEditEntryId} />

      {/* --- Speaker Queue Section --- */}
      <section aria-labelledby="queue-heading">
        <div className="flex items-center gap-3 mb-1">
          <h2
            id="queue-heading"
            className="text-xs font-bold uppercase tracking-wider text-stone-800"
          >
            Speaker Queue
          </h2>

          {/* Copy/Restore buttons — chairs only */}
          {isChair && (
            <>
              {meeting.queuedSpeakers.length > 0 && (
                <button
                  onClick={handleCopyQueue}
                  className="text-xs text-stone-400 hover:text-stone-700
                             transition-colors cursor-pointer"
                >
                  Copy Queue
                </button>
              )}
              <button
                onClick={() => setShowRestore(!showRestore)}
                className="text-xs text-stone-400 hover:text-stone-700
                           transition-colors cursor-pointer"
              >
                {showRestore ? 'Cancel' : 'Restore Queue'}
              </button>
            </>
          )}
        </div>

        {/* Restore queue textarea — chairs only */}
        {isChair && showRestore && (
          <div className="mb-3 border border-stone-200 rounded-lg p-3 bg-white">
            <label htmlFor="restore-queue" className="block text-xs font-medium text-stone-600 mb-1">
              Paste queue items (one per line: "Type: topic")
            </label>
            <textarea
              id="restore-queue"
              value={restoreText}
              onChange={(e) => setRestoreText(e.target.value)}
              placeholder={'New Topic: My discussion point\nClarifying Question: How does this work?\nReply: I agree with the previous speaker\nPoint of Order: We should timebox this'}
              rows={5}
              className="w-full border border-stone-300 rounded px-3 py-2 text-sm mb-2
                         focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500
                         font-mono"
            />
            <button
              onClick={handleRestoreQueue}
              disabled={!restoreText.trim()}
              className="bg-teal-500 text-white px-4 py-1.5 rounded text-sm font-medium
                         hover:bg-teal-600 transition-colors cursor-pointer
                         disabled:opacity-50 disabled:cursor-not-allowed
                         focus:outline-none focus:ring-2 focus:ring-teal-500 focus:ring-offset-2"
            >
              Add to Queue
            </button>
          </div>
        )}

        {meeting.queuedSpeakers.length === 0 && !showRestore ? (
          <p className="text-stone-400 italic text-sm">The queue is empty.</p>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictDownwardOnly]}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={meeting.queuedSpeakers.map((e) => e.id)}
              strategy={verticalListSortingStrategy}
            >
              <ol aria-label="Queued speakers">
                {meeting.queuedSpeakers.map((entry, index) => (
                  <SortableQueueEntry
                    key={entry.id}
                    entry={entry}
                    index={index}
                    queue={meeting.queuedSpeakers}
                    isChair={isChair}
                    isOwnEntry={!!user && entry.user.ghUsername.toLowerCase() === user.ghUsername.toLowerCase()}
                    onDelete={handleRemoveEntry}
                    initialEditing={autoEditEntryId === entry.id}
                    onEditingStarted={() => setAutoEditEntryId(null)}
                  />
                ))}
              </ol>
            </SortableContext>
          </DndContext>
        )}
      </section>
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
  entry, index, queue, isChair, isOwnEntry, onDelete,
  initialEditing = false, onEditingStarted,
}: SortableQueueEntryProps) {
  const socket = useSocket();
  const [editing, setEditing] = useState(initialEditing);
  const [editTopic, setEditTopic] = useState(initialEditing ? entry.topic : '');

  // Ref callback for the edit input — focuses and selects text only
  // on initial mount, not on re-renders.
  const editInputRef = useCallback((el: HTMLInputElement | null) => {
    if (el) {
      el.focus();
      el.select();
    }
  }, []);

  // When initialEditing transitions to true, enter edit mode and
  // notify the parent so it can clear the flag.
  useEffect(() => {
    if (initialEditing && !editing) {
      setEditTopic(entry.topic);
      setEditing(true);
    }
    if (initialEditing) {
      onEditingStarted?.();
    }
  }, [initialEditing]); // eslint-disable-line react-hooks/exhaustive-deps

  // Chairs can drag any entry; participants can drag their own entries
  const canDrag = isChair || isOwnEntry;

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

    return QUEUE_ENTRY_TYPES.filter(
      (t) => QUEUE_ENTRY_PRIORITY[t] >= minPriority && QUEUE_ENTRY_PRIORITY[t] <= maxPriority,
    );
  })();

  /** Cycle to the next legal type when the type badge is clicked. */
  function handleCycleType() {
    if (legalTypes.length <= 1) return;
    const currentIdx = legalTypes.indexOf(entry.type);
    const nextType = legalTypes[(currentIdx + 1) % legalTypes.length];
    socket?.emit('queue:edit', { id: entry.id, type: nextType });
  }

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: entry.id, disabled: !canDrag || editing });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const canEdit = isOwnEntry || isChair;
  const canDelete = isOwnEntry || isChair;

  /** Open the inline edit form, pre-populated with current topic. */
  function startEditing() {
    setEditTopic(entry.topic);
    setEditing(true);
  }

  /** Submit the edit and close the form. */
  function handleEditSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = editTopic.trim();
    if (!trimmed) return;

    socket?.emit('queue:edit', { id: entry.id, topic: trimmed });
    setEditing(false);
  }

  // --- Editing mode: inline form ---
  if (editing) {
    return (
      <li
        ref={setNodeRef}
        style={style}
        className={`flex items-center gap-2 border-b border-stone-100 pb-2 pt-1 px-2 rounded ${
          index % 2 === 0 ? 'bg-white' : 'bg-stone-100/50'
        } ${isOwnEntry ? 'border-l-3 border-l-teal-500' : ''}`}
      >
        {/* Placeholder for drag handle column */}
        {canDrag && <span className="w-4" />}

        <span className="text-lg font-semibold text-stone-400 tabular-nums min-w-[1.5rem] text-center">
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
            required
            aria-label="Topic description"
            // Focus and select all text on mount so the user can
            // immediately start typing to replace the placeholder.
            // Uses a stable ref via useCallback to run only once.
            ref={editInputRef}
            className="border border-stone-300 rounded px-2 py-0.5 text-sm flex-1 min-w-[100px]
                       focus:outline-none focus:ring-1 focus:ring-teal-500"
          />
          <button
            type="submit"
            className="text-xs text-teal-600 hover:text-teal-800 font-medium cursor-pointer"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="text-xs text-stone-400 hover:text-stone-600 cursor-pointer"
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
      className={`flex items-center gap-2 border-b border-stone-100 pb-2 pt-1 px-2 rounded ${
        isDragging ? 'opacity-50 bg-stone-200' : index % 2 === 0 ? 'bg-white' : 'bg-stone-100/50'
      } ${isOwnEntry ? 'border-l-3 border-l-teal-500' : ''}`}
    >
      {/* Drag handle — chairs can drag any entry, participants their own */}
      {canDrag && (
        <span
          className="text-stone-300 hover:text-stone-500 cursor-grab active:cursor-grabbing
                     select-none text-sm leading-none"
          aria-label={`Drag to reorder: ${entry.topic}`}
          {...attributes}
          {...listeners}
        >
          ⠿
        </span>
      )}

      {/* Position number */}
      <span className="text-lg font-semibold text-stone-400 tabular-nums min-w-[1.5rem] text-center">
        {index + 1}
      </span>

      <div className="flex-1 min-w-0">
        {/* Type badge and topic — chairs can click to cycle through legal types */}
        {(isChair || isOwnEntry) && legalTypes.length > 1 ? (
          <button
            onClick={handleCycleType}
            className={`text-sm font-semibold cursor-pointer hover:underline ${entryTypeColor(entry.type)}`}
            title={`Click to change type (${legalTypes.map(entryTypeLabel).join(' → ')})`}
            aria-label={`Change type from ${entryTypeLabel(entry.type)}`}
          >
            {entryTypeLabel(entry.type)}:
          </button>
        ) : (
          <span className={`text-sm font-semibold ${entryTypeColor(entry.type)}`}>
            {entryTypeLabel(entry.type)}:
          </span>
        )}
        <span className="ml-1 text-stone-800">{entry.topic}</span>

        {/* Speaker info */}
        <div className="text-sm text-stone-500">
          <UserBadge user={entry.user} size={16} />
        </div>
      </div>

      {/* Edit and delete buttons — right-aligned */}
      {(canEdit || canDelete) && (
        <div className="flex gap-3 shrink-0">
          {canEdit && (
            <button
              onClick={startEditing}
              className="text-xs text-stone-400 hover:text-teal-600
                         transition-colors cursor-pointer"
              aria-label={`Edit entry: ${entry.topic}`}
            >
              Edit
            </button>
          )}
          {canDelete && (
            <button
              onClick={() => onDelete(entry.id)}
              className="text-xs text-stone-400 hover:text-red-600
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
export function entryTypeLabel(type: string): string {
  switch (type) {
    case 'topic': return 'New Topic';
    case 'reply': return 'Reply';
    case 'question': return 'Clarifying Question';
    case 'point-of-order': return 'Point of Order';
    default: return type;
  }
}

/** Map a display label back to a queue entry type. Case-insensitive. */
function parseEntryType(label: string): QueueEntryType | null {
  switch (label.toLowerCase()) {
    case 'new topic': return 'topic';
    case 'reply': return 'reply';
    case 'clarifying question': return 'question';
    case 'point of order': return 'point-of-order';
    default: return null;
  }
}

/** Map a queue entry type to a Tailwind text colour class. */
export function entryTypeColor(type: string): string {
  switch (type) {
    case 'topic': return 'text-blue-600';
    case 'reply': return 'text-cyan-600';
    case 'question': return 'text-green-600';
    case 'point-of-order': return 'text-red-600';
    default: return 'text-stone-600';
  }
}
