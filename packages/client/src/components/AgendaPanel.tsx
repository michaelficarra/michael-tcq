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
import { userKey } from '@tcq/shared';
import { useMeetingState, useMeetingDispatch, useIsChair } from '../contexts/MeetingContext.js';
import { useSocket } from '../contexts/SocketContext.js';
import { AgendaForm } from './AgendaForm.js';
import { InlineMarkdown } from './InlineMarkdown.js';
import { UserBadge } from './UserBadge.js';

// Stable references so useSensor's internal useMemo doesn't invalidate every render.
const POINTER_SENSOR_OPTIONS = {
  activationConstraint: { distance: 5 },
};
const KEYBOARD_SENSOR_OPTIONS = {
  coordinateGetter: sortableKeyboardCoordinates,
};

export function AgendaPanel() {
  const { meeting, user } = useMeetingState();
  const dispatch = useMeetingDispatch();
  const isChair = useIsChair();
  const socket = useSocket();
  const [showForm, setShowForm] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importUrl, setImportUrl] = useState('');
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  // Drag-and-drop sensors with keyboard support for accessibility.
  // Options are hoisted to module scope so useSensor's internal useMemo
  // sees stable references and doesn't recreate descriptors every render.
  const sensors = useSensors(
    useSensor(PointerSensor, POINTER_SENSOR_OPTIONS),
    useSensor(KeyboardSensor, KEYBOARD_SENSOR_OPTIONS),
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

    dispatch({ type: 'optimisticAgendaReorder', oldIndex, newIndex });
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
        <div className="mb-4">
          <p className="text-stone-400 dark:text-stone-500 italic mb-2">No agenda items yet.</p>
          {isChair && !showImport && (
            <button
              onClick={() => {
                setShowImport(true);
                setImportError(null);
              }}
              className="border border-stone-300 dark:border-stone-600 rounded px-3 py-1 text-sm font-medium
                         text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800 transition-colors
                         cursor-pointer presentation-hidden"
            >
              Import Agenda from URL
            </button>
          )}
          {isChair && showImport && (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const trimmed = importUrl.trim();
                if (!trimmed || importing) return;
                setImporting(true);
                setImportError(null);
                try {
                  const res = await fetch(`/api/meetings/${meeting.id}/import-agenda`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url: trimmed }),
                  });
                  const body = await res.json();
                  if (!res.ok) {
                    setImportError(body.error || 'Import failed');
                  } else {
                    setShowImport(false);
                    setImportUrl('');
                  }
                } catch {
                  setImportError('Network error');
                } finally {
                  setImporting(false);
                }
              }}
              className="flex flex-wrap items-center gap-2"
            >
              <input
                type="url"
                value={importUrl}
                onChange={(e) => setImportUrl(e.target.value)}
                placeholder="https://github.com/tc39/agendas/blob/main/YYYY/MM.md"
                pattern="https://(github\.com/tc39/agendas/blob/main|raw\.githubusercontent\.com/tc39/agendas/refs/heads/main)/\d{4}/\d{2}\.md"
                title="URL must point to a TC39 agenda markdown file, e.g. https://github.com/tc39/agendas/blob/main/2026/03.md"
                required
                autoFocus
                aria-label="Agenda markdown URL"
                className="border border-stone-300 dark:border-stone-600 rounded px-2 py-1 text-sm flex-1 min-w-[200px]
                           dark:bg-stone-700 dark:text-stone-100
                           focus:outline-none focus:ring-1 focus:ring-teal-500"
              />
              <button
                type="submit"
                disabled={importing}
                className="bg-teal-500 text-white px-3 py-1 rounded text-sm font-medium
                           enabled:hover:bg-teal-600 transition-colors cursor-pointer
                           disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {importing ? 'Importing…' : 'Import'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowImport(false);
                  setImportUrl('');
                  setImportError(null);
                }}
                className="text-sm text-stone-400 dark:text-stone-500 hover:text-stone-600 dark:hover:text-stone-300 transition-colors cursor-pointer"
              >
                Cancel
              </button>
              {importError && (
                <p className="text-red-600 dark:text-red-400 text-sm w-full" role="alert">
                  {importError}
                </p>
              )}
            </form>
          )}
        </div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
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
                  isOwnItem={!!user && item.ownerId === userKey(user)}
                  onDelete={handleDelete}
                />
              ))}
            </ol>
          </SortableContext>
        </DndContext>
      )}

      {/* Add agenda item — chairs only */}
      {isChair &&
        (showForm ? (
          <AgendaForm onCancel={() => setShowForm(false)} onSubmit={() => setShowForm(false)} />
        ) : (
          <button
            onClick={() => setShowForm(true)}
            className="border border-stone-300 dark:border-stone-600 rounded px-3 py-1 text-sm font-medium
                       text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800 transition-colors
                       cursor-pointer presentation-hidden"
          >
            New Agenda Item
          </button>
        ))}
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
  const { meeting } = useMeetingState();
  const socket = useSocket();
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editOwner, setEditOwner] = useState('');
  const [editTimebox, setEditTimebox] = useState('');

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
    disabled: !isChair || editing,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  /** Open the inline edit form, pre-populated with current values. */
  function startEditing() {
    setEditName(item.name);
    setEditOwner(meeting?.users[item.ownerId]?.ghUsername ?? item.ownerId);
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
        className={`flex items-center gap-3 border-b border-stone-100 dark:border-stone-700 pb-2 pt-1 px-2 rounded ${
          index % 2 === 0 ? 'bg-white dark:bg-stone-900' : 'bg-stone-100/50 dark:bg-stone-800/50'
        } ${isOwnItem ? 'border-l-3 border-l-teal-500 dark:border-l-teal-500' : ''}`}
      >
        <span className="text-lg font-semibold text-stone-400 dark:text-stone-500 tabular-nums min-w-[1.5rem] text-right select-none">
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
            className="border border-stone-300 dark:border-stone-600 rounded px-2 py-0.5 text-sm flex-1 min-w-[120px]
                       dark:bg-stone-700 dark:text-stone-100
                       focus:outline-none focus:ring-1 focus:ring-teal-500"
          />
          <input
            type="text"
            value={editOwner}
            onChange={(e) => setEditOwner(e.target.value)}
            required
            aria-label="Owner username"
            className="border border-stone-300 dark:border-stone-600 rounded px-2 py-0.5 text-sm w-28
                       dark:bg-stone-700 dark:text-stone-100
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
            className="border border-stone-300 dark:border-stone-600 rounded px-2 py-0.5 text-sm w-16
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
            onClick={() => setEditing(false)}
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
      className={`flex items-center gap-3 border-b border-stone-100 dark:border-stone-700 pb-2 pt-1 px-2 rounded ${
        isDragging
          ? 'opacity-50 bg-stone-200 dark:bg-stone-700'
          : index % 2 === 0
            ? 'bg-white dark:bg-stone-900'
            : 'bg-stone-100/50 dark:bg-stone-800/50'
      } ${isChair ? 'cursor-grab active:cursor-grabbing' : ''} ${isOwnItem ? 'border-l-3 border-l-teal-500 dark:border-l-teal-500' : ''}`}
      aria-label={isChair ? `Drag to reorder item ${index + 1}` : undefined}
      {...(isChair ? { ...attributes, ...listeners } : {})}
    >
      {/* Item number */}
      <span className="text-lg font-semibold text-stone-400 dark:text-stone-500 tabular-nums min-w-[1.5rem] text-right select-none">
        {index + 1}
      </span>

      <div className="flex-1 min-w-0">
        {/* Item name */}
        <InlineMarkdown className="font-medium text-stone-800 dark:text-stone-200 align-middle">
          {item.name}
        </InlineMarkdown>

        {/* Owner info */}
        <UserBadge
          user={meeting?.users[item.ownerId]}
          size={16}
          className="ml-2 text-sm text-stone-500 dark:text-stone-400"
        />

        {/* Timebox */}
        {item.timebox != null && item.timebox > 0 && (
          <span className="ml-2 text-sm text-stone-400 dark:text-stone-500 align-middle">
            {item.timebox} {item.timebox === 1 ? 'minute' : 'minutes'}
          </span>
        )}
      </div>

      {/* Edit and delete buttons — chairs only */}
      {isChair && (
        <div className="flex gap-3 shrink-0 presentation-hidden">
          <button
            onClick={startEditing}
            className="text-xs text-stone-400 dark:text-stone-500 hover:text-teal-600 dark:hover:text-teal-400 transition-colors cursor-pointer"
            aria-label={`Edit ${item.name}`}
          >
            edit
          </button>
          <button
            onClick={() => onDelete(item.id)}
            className="text-xs text-stone-400 dark:text-stone-500 hover:text-red-600 dark:hover:text-red-400 transition-colors cursor-pointer"
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
  function canRemove(chairId: string): boolean {
    if (!canEditChairs) return false;
    // Non-admins cannot remove themselves
    if (!isAdmin && user && userKey(user) === chairId) return false;
    return true;
  }

  /** Remove a chair by emitting the updated list without them. */
  function handleRemove(chairId: string) {
    const usernames = meeting!.chairIds
      .filter((id) => id !== chairId)
      .map((id) => meeting!.users[id]?.ghUsername ?? id);
    socket?.emit('meeting:updateChairs', { usernames });
    setRemoveConfirm(null);
  }

  /** Add a new chair by username. */
  function handleAdd(e: FormEvent) {
    e.preventDefault();
    const username = addValue.trim();
    if (!username) return;

    const usernames = meeting!.chairIds.map((id) => meeting!.users[id]?.ghUsername ?? id);
    if (!usernames.some((u) => u.toLowerCase() === username.toLowerCase())) {
      usernames.push(username);
    }
    socket?.emit('meeting:updateChairs', { usernames });
    setAddValue('');
    setAdding(false);
  }

  return (
    <section className="mb-5" aria-label="Meeting chairs">
      <div className="flex flex-wrap items-center gap-3 text-sm text-stone-700 dark:text-stone-300">
        <h2 className="text-sm font-bold uppercase tracking-wider text-stone-500 dark:text-stone-400">Chairs</h2>

        {meeting.chairIds.map((chairId) => {
          const chair = meeting.users[chairId];
          return (
            <span
              key={chairId}
              className={`inline-flex items-center gap-1 bg-stone-200 dark:bg-stone-700 rounded-full pl-1 py-1 select-none ${canRemove(chairId) ? 'pr-1' : 'pr-2'}`}
            >
              <UserBadge user={chair} size={18} />
              {canRemove(chairId) && (
                <button
                  onClick={() => setRemoveConfirm(chairId)}
                  className="text-red-400 hover:text-red-600 dark:hover:text-red-400 transition-colors
                             cursor-pointer presentation-hidden"
                  aria-label={`Remove chair ${chair?.ghUsername ?? chairId}`}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
                    <path
                      fillRule="evenodd"
                      d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z"
                      clipRule="evenodd"
                    />
                  </svg>
                </button>
              )}
            </span>
          );
        })}

        {canEditChairs && !adding && (
          <button
            onClick={() => setAdding(true)}
            className="text-teal-500 dark:text-teal-400 hover:text-teal-700 dark:hover:text-teal-300 transition-colors
                       cursor-pointer presentation-hidden"
            aria-label="Add chair"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
              <path
                fillRule="evenodd"
                d="M10 18a8 8 0 100-16 8 8 0 000 16zm.75-11.25a.75.75 0 00-1.5 0v2.5h-2.5a.75.75 0 000 1.5h2.5v2.5a.75.75 0 001.5 0v-2.5h2.5a.75.75 0 000-1.5h-2.5v-2.5z"
                clipRule="evenodd"
              />
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
              className="border border-stone-300 dark:border-stone-600 rounded px-2 py-0.5 text-sm w-28
                         dark:bg-stone-700 dark:text-stone-100
                         focus:outline-none focus:ring-1 focus:ring-teal-500"
            />
            <button
              type="submit"
              className="text-xs text-teal-600 dark:text-teal-400 hover:text-teal-800 dark:hover:text-teal-300 font-medium cursor-pointer"
            >
              Add
            </button>
            <button
              type="button"
              onClick={() => {
                setAdding(false);
                setAddValue('');
              }}
              className="text-xs text-stone-400 dark:text-stone-500 hover:text-stone-600 dark:hover:text-stone-300 cursor-pointer"
            >
              Cancel
            </button>
          </form>
        )}
      </div>

      {/* Remove chair confirmation modal */}
      {removeConfirm && (
        <div
          className="fixed inset-0 top-[3rem] bg-black/30 flex items-center justify-center z-40"
          onClick={() => setRemoveConfirm(null)}
          role="dialog"
          aria-label="Confirm chair removal"
        >
          <div
            className="bg-white dark:bg-stone-900 rounded-lg shadow-lg dark:shadow-stone-950/50 p-6 max-w-sm mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-stone-800 dark:text-stone-200 mb-2">Remove Chair</h3>
            <p className="text-sm text-stone-600 dark:text-stone-400 mb-4">
              Remove <strong>{removeConfirm}</strong> from the chair list?
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setRemoveConfirm(null)}
                className="text-sm text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-300
                           transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={() => handleRemove(removeConfirm)}
                autoFocus
                className="bg-red-500 text-white px-4 py-1.5 rounded text-sm font-medium
                           hover:bg-red-600 transition-colors cursor-pointer
                           focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 dark:focus:ring-offset-stone-900"
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
