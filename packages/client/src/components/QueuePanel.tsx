/**
 * Queue tab panel — displays the current agenda item, current speaker,
 * speaker controls, and the speaker queue.
 *
 * The agenda item section shows Start Meeting / Next Agenda Item buttons
 * for chairs. The speaker section shows the current speaker with a
 * Next Speaker button for chairs. Below that are the entry type buttons
 * and the queue list with drag-and-drop reordering for chairs.
 */

import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { QueueEntry } from '@tcq/shared';
import { useMeetingState, useIsChair } from '../contexts/MeetingContext.js';
import { useSocket } from '../contexts/SocketContext.js';
import { useAdvanceAction } from '../hooks/useAdvanceAction.js';
import { SpeakerControls } from './SpeakerControls.js';
import { UserBadge } from './UserBadge.js';

export function QueuePanel() {
  const { meeting, user } = useMeetingState();
  const isChair = useIsChair();
  const socket = useSocket();

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

  if (!meeting) return null;

  /** Remove a queue entry (own entry, or any entry if chair). */
  function handleRemoveEntry(entryId: string) {
    socket?.emit('queue:remove', { id: entryId });
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
      <SpeakerControls />

      {/* --- Speaker Queue Section --- */}
      <section aria-labelledby="queue-heading">
        <h2
          id="queue-heading"
          className="text-xs font-bold uppercase tracking-wider text-stone-800 mb-1"
        >
          Speaker Queue
        </h2>

        {meeting.queuedSpeakers.length === 0 ? (
          <p className="text-stone-400 italic text-sm">The queue is empty.</p>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={meeting.queuedSpeakers.map((e) => e.id)}
              strategy={verticalListSortingStrategy}
              disabled={!isChair}
            >
              <ol className="space-y-3" aria-label="Queued speakers">
                {meeting.queuedSpeakers.map((entry, index) => (
                  <SortableQueueEntry
                    key={entry.id}
                    entry={entry}
                    index={index}
                    isChair={isChair}
                    isOwnEntry={!!user && entry.user.ghid === user.ghid}
                    onDelete={handleRemoveEntry}
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
  isChair: boolean;
  isOwnEntry: boolean;
  onDelete: (id: string) => void;
}

function SortableQueueEntry({ entry, index, isChair, isOwnEntry, onDelete }: SortableQueueEntryProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: entry.id, disabled: !isChair });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const canDelete = isOwnEntry || isChair;

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-2 border-b border-stone-100 pb-2 pt-1 px-2 rounded ${
        isDragging ? 'opacity-50 bg-stone-200' : index % 2 === 0 ? 'bg-white' : 'bg-stone-100/50'
      }`}
    >
      {/* Drag handle — chair only, to the left of the position number */}
      {isChair && (
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
      <span className="text-lg font-semibold text-stone-400 tabular-nums min-w-[1.5rem] text-right">
        {index + 1}
      </span>

      <div className="flex-1 min-w-0">
        {/* Type badge and topic */}
        <span className={`text-sm font-semibold ${entryTypeColor(entry.type)}`}>
          {entryTypeLabel(entry.type)}:
        </span>
        <span className="ml-1 text-stone-800">{entry.topic}</span>

        {/* Speaker info and action buttons */}
        <div className="text-sm text-stone-500 flex flex-wrap items-center">
          <UserBadge user={entry.user} size={16} />

          {/* Delete button — own entries or chair */}
          {canDelete && (
            <button
              onClick={() => onDelete(entry.id)}
              className="ml-3 text-xs text-stone-400 hover:text-red-600
                         transition-colors cursor-pointer"
              aria-label={`Delete entry: ${entry.topic}`}
            >
              Delete
            </button>
          )}
        </div>
      </div>
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
