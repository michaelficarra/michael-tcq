/**
 * Agenda tab panel — displays the ordered list of agenda items with
 * management controls for chairs.
 *
 * Chairs can:
 * - Add new agenda items via a form
 * - Delete existing items
 * - Reorder items via drag-and-drop
 *
 * Participants see a read-only numbered list.
 */

import { useState, type FormEvent } from 'react';
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
import type { AgendaItem } from '@tcq/shared';
import { useMeetingState, useIsChair } from '../contexts/MeetingContext.js';
import { useSocket } from '../contexts/SocketContext.js';
import { AgendaForm } from './AgendaForm.js';
import { UserBadge } from './UserBadge.js';

export function AgendaPanel() {
  const { meeting, user } = useMeetingState();
  const isChair = useIsChair();
  const socket = useSocket();
  const [showForm, setShowForm] = useState(false);

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

  /** Handle the end of a drag-and-drop reorder. */
  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id || !meeting) return;

    // Find the item that was dragged and the item it was dropped on
    const items = meeting.agenda;
    const oldIndex = items.findIndex((i) => i.id === active.id);
    const newIndex = items.findIndex((i) => i.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    // Determine what item the dragged item should come after.
    // If it was dropped at position 0, afterId is null (move to beginning).
    // Otherwise, afterId is the item just before the new position.
    let afterId: string | null;
    if (newIndex === 0) {
      // Moving to the beginning — but we need to check if the item moved up or down.
      // If oldIndex > newIndex, the item is being moved to before the item at newIndex.
      afterId = null;
    } else if (oldIndex < newIndex) {
      // Moving down: place after the item at newIndex
      afterId = items[newIndex].id;
    } else {
      // Moving up: place after the item just before newIndex
      afterId = items[newIndex - 1]?.id ?? null;
    }

    socket?.emit('agenda:reorder', { id: active.id as string, afterId });
  }

  /** Handle deleting an agenda item. */
  function handleDelete(itemId: string) {
    socket?.emit('agenda:delete', { id: itemId });
  }

  return (
    <div id="panel-agenda" role="tabpanel" aria-label="Agenda" className="p-6">
      {/* Chairs list */}
      <section className="mb-5" aria-label="Meeting chairs">
        <h2 className="text-xs font-bold uppercase tracking-wider text-stone-500 mb-1">
          Chairs
        </h2>
        <div className="flex flex-wrap gap-3 text-sm text-stone-700">
          {meeting.chairs.map((chair) => (
            <UserBadge key={chair.ghUsername} user={chair} size={18} />
          ))}
        </div>
      </section>

      {/* Agenda item list */}
      {meeting.agenda.length === 0 && !showForm ? (
        <p className="text-stone-400 italic mb-4">No agenda items yet.</p>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={meeting.agenda.map((i) => i.id)}
            strategy={verticalListSortingStrategy}
            disabled={!isChair}
          >
            <ol className="space-y-1 mb-4" aria-label="Agenda items">
              {meeting.agenda.map((item, index) => (
                <SortableAgendaItem
                  key={item.id}
                  item={item}
                  index={index}
                  isChair={isChair}
                  isOwnItem={!!user && item.owner.ghUsername.toLowerCase() === user.ghUsername.toLowerCase()}
                  onDelete={handleDelete}
                />
              ))}
            </ol>
          </SortableContext>
        </DndContext>
      )}

      {/* Add agenda item — chairs only */}
      {isChair && (
        showForm ? (
          <AgendaForm
            onCancel={() => setShowForm(false)}
            onSubmit={() => setShowForm(false)}
          />
        ) : (
          <button
            onClick={() => setShowForm(true)}
            className="text-blue-600 hover:text-blue-800 transition-colors font-medium"
          >
            + New Agenda Item
          </button>
        )
      )}
    </div>
  );
}

// -- Sortable agenda item component --

interface SortableAgendaItemProps {
  item: AgendaItem;
  index: number;
  isChair: boolean;
  /** Whether the current user is the owner of this agenda item. */
  isOwnItem: boolean;
  onDelete: (id: string) => void;
}

function SortableAgendaItem({ item, index, isChair, isOwnItem, onDelete }: SortableAgendaItemProps) {
  const socket = useSocket();
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editOwner, setEditOwner] = useState('');
  const [editTimebox, setEditTimebox] = useState('');

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id, disabled: !isChair || editing });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  /** Open the inline edit form, pre-populated with current values. */
  function startEditing() {
    setEditName(item.name);
    setEditOwner(item.owner.ghUsername);
    setEditTimebox(item.timebox != null && item.timebox > 0 ? String(item.timebox) : '');
    setEditing(true);
  }

  /** Submit the edit and close the form. */
  function handleEditSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmedName = editName.trim();
    const trimmedOwner = editOwner.trim();
    if (!trimmedName || !trimmedOwner) return;

    const timeboxMinutes = parseInt(editTimebox, 10);

    socket?.emit('agenda:edit', {
      id: item.id,
      name: trimmedName,
      ownerUsername: trimmedOwner,
      timebox: timeboxMinutes > 0 ? timeboxMinutes : null,
    });
    setEditing(false);
  }

  // --- Editing mode: inline form ---
  if (editing) {
    return (
      <li
        ref={setNodeRef}
        style={style}
        className={`flex items-center gap-3 border-b border-stone-100 pb-2 pt-1 px-2 rounded ${
          index % 2 === 0 ? 'bg-white' : 'bg-stone-100/50'
        } ${isOwnItem ? 'border-l-3 border-l-teal-500' : ''}`}
      >
        <span className="text-lg font-semibold text-stone-400 tabular-nums min-w-[1.5rem] text-right select-none">
          {index + 1}
        </span>

        <form onSubmit={handleEditSubmit} className="flex-1 flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            required
            autoFocus
            aria-label="Agenda item name"
            className="border border-stone-300 rounded px-2 py-0.5 text-sm flex-1 min-w-[120px]
                       focus:outline-none focus:ring-1 focus:ring-teal-500"
          />
          <input
            type="text"
            value={editOwner}
            onChange={(e) => setEditOwner(e.target.value)}
            required
            aria-label="Owner username"
            className="border border-stone-300 rounded px-2 py-0.5 text-sm w-28
                       focus:outline-none focus:ring-1 focus:ring-teal-500"
          />
          <input
            type="number"
            value={editTimebox}
            onChange={(e) => setEditTimebox(e.target.value)}
            min="0"
            max="999"
            placeholder="min"
            aria-label="Timebox in minutes"
            className="border border-stone-300 rounded px-2 py-0.5 text-sm w-16
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
      className={`flex items-center gap-3 border-b border-stone-100 pb-2 pt-1 px-2 rounded ${
        isDragging ? 'opacity-50 bg-stone-200' : index % 2 === 0 ? 'bg-white' : 'bg-stone-100/50'
      } ${isChair ? 'cursor-grab active:cursor-grabbing' : ''} ${isOwnItem ? 'border-l-3 border-l-teal-500' : ''}`}
      aria-label={isChair ? `Drag to reorder item ${index + 1}` : undefined}
      {...(isChair ? { ...attributes, ...listeners } : {})}
    >
      {/* Item number */}
      <span className="text-lg font-semibold text-stone-400 tabular-nums min-w-[1.5rem] text-right select-none">
        {index + 1}
      </span>

      <div className="flex-1 min-w-0">
        {/* Item name */}
        <span className="font-medium text-stone-800 align-middle">{item.name}</span>

        {/* Owner info */}
        <UserBadge user={item.owner} size={16} className="ml-2 text-sm text-stone-500" />

        {/* Timebox */}
        {item.timebox != null && item.timebox > 0 && (
          <span className="ml-2 text-sm text-stone-400 align-middle">
            {item.timebox} {item.timebox === 1 ? 'minute' : 'minutes'}
          </span>
        )}
      </div>

      {/* Edit and delete buttons — chairs only */}
      {isChair && (
        <div className="flex gap-3 shrink-0">
          <button
            onClick={startEditing}
            className="text-xs text-stone-400 hover:text-teal-600 transition-colors cursor-pointer"
            aria-label={`Edit ${item.name}`}
          >
            edit
          </button>
          <button
            onClick={() => onDelete(item.id)}
            className="text-xs text-stone-400 hover:text-red-600 transition-colors cursor-pointer"
            aria-label={`Delete ${item.name}`}
          >
            delete
          </button>
        </div>
      )}
    </li>
  );
}
