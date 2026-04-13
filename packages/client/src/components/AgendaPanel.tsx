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
import { useAuth } from '../contexts/AuthContext.js';
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
      {/* Chairs list with inline edit for chairs */}
      <ChairsSection />

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
            className="border border-stone-300 rounded px-3 py-1 text-sm font-medium
                       text-stone-600 hover:bg-stone-100 transition-colors
                       cursor-pointer presentation-hidden"
          >
            New Agenda Item
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
        <div className="flex gap-3 shrink-0 presentation-hidden">
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

// -- Chairs section with inline editing --

function ChairsSection() {
  const { meeting } = useMeetingState();
  const { user, isAdmin } = useAuth();
  const isChair = useIsChair();
  const socket = useSocket();
  const canEditChairs = isChair || isAdmin;
  const [adding, setAdding] = useState(false);
  const [addValue, setAddValue] = useState('');
  const [removeConfirm, setRemoveConfirm] = useState<string | null>(null);

  if (!meeting) return null;

  /** Whether the current user can remove a given chair. */
  function canRemove(chairUsername: string): boolean {
    if (!canEditChairs) return false;
    // Non-admins cannot remove themselves
    if (!isAdmin && user?.ghUsername.toLowerCase() === chairUsername.toLowerCase()) return false;
    return true;
  }

  /** Remove a chair by emitting the updated list without them. */
  function handleRemove(chairUsername: string) {
    const usernames = meeting!.chairs
      .map((c) => c.ghUsername)
      .filter((u) => u.toLowerCase() !== chairUsername.toLowerCase());
    socket?.emit('meeting:updateChairs', { usernames });
    setRemoveConfirm(null);
  }

  /** Add a new chair by username. */
  function handleAdd(e: FormEvent) {
    e.preventDefault();
    const username = addValue.trim();
    if (!username) return;

    const usernames = meeting!.chairs.map((c) => c.ghUsername);
    if (!usernames.some((u) => u.toLowerCase() === username.toLowerCase())) {
      usernames.push(username);
    }
    socket?.emit('meeting:updateChairs', { usernames });
    setAddValue('');
    setAdding(false);
  }

  return (
    <section className="mb-5" aria-label="Meeting chairs">
      <div className="flex flex-wrap items-center gap-3 text-sm text-stone-700">
        <h2 className="text-sm font-bold uppercase tracking-wider text-stone-500">
          Chairs
        </h2>

        {meeting.chairs.map((chair) => (
          <span key={chair.ghUsername} className={`inline-flex items-center gap-1 bg-stone-200 rounded-full pl-1 py-1 select-none ${canRemove(chair.ghUsername) ? 'pr-1' : 'pr-2'}`}>
            <UserBadge user={chair} size={18} />
            {canRemove(chair.ghUsername) && (
              <button
                onClick={() => setRemoveConfirm(chair.ghUsername)}
                className="text-red-400 hover:text-red-600 transition-colors
                           cursor-pointer presentation-hidden"
                aria-label={`Remove chair ${chair.ghUsername}`}
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z" clipRule="evenodd" />
                </svg>
              </button>
            )}
          </span>
        ))}

        {canEditChairs && !adding && (
          <button
            onClick={() => setAdding(true)}
            className="text-teal-500 hover:text-teal-700 transition-colors
                       cursor-pointer presentation-hidden"
            aria-label="Add chair"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm.75-11.25a.75.75 0 00-1.5 0v2.5h-2.5a.75.75 0 000 1.5h2.5v2.5a.75.75 0 001.5 0v-2.5h2.5a.75.75 0 000-1.5h-2.5v-2.5z" clipRule="evenodd" />
            </svg>
          </button>
        )}

        {adding && (
          <form onSubmit={handleAdd} className="inline-flex items-center gap-1">
            <input
              type="text"
              value={addValue}
              onChange={(e) => setAddValue(e.target.value)}
              autoFocus
              required
              placeholder="username"
              aria-label="New chair username"
              className="border border-stone-300 rounded px-2 py-0.5 text-sm w-28
                         focus:outline-none focus:ring-1 focus:ring-teal-500"
            />
            <button
              type="submit"
              className="text-xs text-teal-600 hover:text-teal-800 font-medium cursor-pointer"
            >
              Add
            </button>
            <button
              type="button"
              onClick={() => { setAdding(false); setAddValue(''); }}
              className="text-xs text-stone-400 hover:text-stone-600 cursor-pointer"
            >
              Cancel
            </button>
          </form>
        )}
      </div>

      {/* Remove chair confirmation modal */}
      {removeConfirm && (
        <div
          className="fixed inset-0 bg-black/30 flex items-center justify-center z-40"
          onClick={() => setRemoveConfirm(null)}
          role="dialog"
          aria-label="Confirm chair removal"
        >
          <div
            className="bg-white rounded-lg shadow-lg p-6 max-w-sm mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-stone-800 mb-2">
              Remove Chair
            </h3>
            <p className="text-sm text-stone-600 mb-4">
              Remove <strong>{removeConfirm}</strong> from the chair list?
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setRemoveConfirm(null)}
                className="text-sm text-stone-500 hover:text-stone-700
                           transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={() => handleRemove(removeConfirm)}
                autoFocus
                className="bg-red-500 text-white px-4 py-1.5 rounded text-sm font-medium
                           hover:bg-red-600 transition-colors cursor-pointer
                           focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2"
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
