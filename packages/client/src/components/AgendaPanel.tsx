/**
 * Agenda tab panel — displays the ordered list of agenda items with
 * management controls for chairs.
 *
 * Chairs can:
 * - Add new agenda items via a form
 * - Delete existing items
 * - Reorder items via drag-and-drop
 *
 * Participants see a read-only numbered list with the current-item
 * highlight and past-item dimming.
 */

import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
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
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers';
import { CSS } from '@dnd-kit/utilities';
import type { AgendaItem, Session } from '@tcq/shared';
import { formatShortDuration, isAgendaItem, isSession, normaliseGithubUsername, userKey } from '@tcq/shared';
import { useMeetingState, useMeetingDispatch, useIsChair } from '../contexts/MeetingContext.js';
import { useSocket } from '../contexts/SocketContext.js';
import { useToast } from '../contexts/ToastContext.js';
import { computeContainment } from '../lib/containment.js';
import { inputValidation } from '../lib/inputStyles.js';
import { AgendaForm } from './AgendaForm.js';
import { SessionForm } from './SessionForm.js';
import { useNow } from '../lib/secondClock.js';
import { formatElapsed } from './CountUpTimer.js';
import { BlockMarkdown } from './BlockMarkdown.js';
import { InlineMarkdown } from './InlineMarkdown.js';
import { UserBadge } from './UserBadge.js';
import { UserCombobox } from './UserCombobox.js';
import { CirclePlusIcon, CircleXIcon } from './icons.js';

// Stable references so useSensor's internal useMemo doesn't invalidate every render.
const POINTER_SENSOR_OPTIONS = {
  activationConstraint: { distance: 5 },
};
const KEYBOARD_SENSOR_OPTIONS = {
  coordinateGetter: sortableKeyboardCoordinates,
};

export function AgendaPanel({ hidden = false }: { hidden?: boolean } = {}) {
  const { meeting, user } = useMeetingState();
  const dispatch = useMeetingDispatch();
  const isChair = useIsChair();
  const socket = useSocket();
  const [showForm, setShowForm] = useState(false);
  const [showSessionForm, setShowSessionForm] = useState(false);
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

  // Stable across renders so memo'd SortableAgendaItem / SortableSession
  // children skip re-renders when only their siblings change.
  const handleDelete = useCallback(
    (itemId: string) => {
      socket?.emit('agenda:delete', { id: itemId });
    },
    [socket],
  );
  const handleDeleteSession = useCallback(
    (sessionId: string) => {
      socket?.emit('session:delete', { id: sessionId });
    },
    [socket],
  );

  // Containment derived from the current agenda order + durations. Sessions
  // collect the contiguous run of items that follow them (stopping at the
  // next session header); items whose cumulative durations stay within the
  // session's capacity are rendered indented. Memoised on `meeting.agenda`
  // so unrelated state changes (e.g. a poll reaction or speaker advance)
  // don't trigger the linear walk.
  const agenda = meeting?.agenda;
  const containment = useMemo(() => computeContainment(agenda ?? []), [agenda]);

  // 1-based display number per agenda item — counted across items only so
  // that session interpolation doesn't create gaps in the numbering.
  // Memoised for the same reason as `containment`.
  const itemNumbers = useMemo(() => {
    const map = new Map<string, number>();
    if (!agenda) return map;
    let n = 0;
    for (const entry of agenda) {
      if (isAgendaItem(entry)) {
        n += 1;
        map.set(entry.id, n);
      }
    }
    return map;
  }, [agenda]);

  // Scroll the current agenda item into view whenever the tab becomes
  // visible (including the initial mount when the user lands directly on
  // `#agenda`). Seeded `true` so the first render with `hidden=false` is
  // treated as a hidden→visible edge. Re-runs when `currentAgendaItemId`
  // changes too, but the `!wasHidden` guard makes that a no-op — the
  // trigger is *tab visibility*, not *active-item change*.
  //
  // The active row is tagged with the dedicated `tcq-agenda-current-item`
  // class (see SortableAgendaItem below). Keeping the marker class
  // separate from the Tailwind utility classes means visual restyling
  // can't break the scroll behaviour by accident.
  const prevHiddenRef = useRef(true);
  const currentAgendaItemId = meeting?.current.agendaItemId;
  useEffect(() => {
    const wasHidden = prevHiddenRef.current;
    prevHiddenRef.current = hidden;
    if (!wasHidden || hidden) return;
    if (!currentAgendaItemId) return;
    const el = document.querySelector('.tcq-agenda-current-item');
    el?.scrollIntoView({ block: 'center', behavior: 'auto' });
  }, [hidden, currentAgendaItemId]);

  // When hidden (not the active tab) or meeting state not yet loaded, render
  // only the empty tabpanel shell. Keeping the shell in the DOM avoids the
  // mount/unmount race on tab switch that caused Firefox CI flakes; skipping
  // the inner content avoids re-rendering the whole panel on every state
  // broadcast for tabs the user isn't looking at.
  if (hidden || !meeting) {
    return <div id="panel-agenda" role="tabpanel" aria-label="Agenda" hidden={hidden} className="p-6" />;
  }

  // Index of the current agenda item within the full entry array (`-1`
  // means there isn't one yet). Drives the orange current-row highlight
  // and the past-row dimming. Only agenda items can be "current" —
  // sessions are never current.
  const currentIndex = meeting.current.agendaItemId
    ? meeting.agenda.findIndex((e) => isAgendaItem(e) && e.id === meeting.current.agendaItemId)
    : -1;
  // Past-final state: the chair advanced past the last item, so the
  // meeting is concluded and every existing item is "past". `isPast`
  // is what gates conclusion rendering and the dim styling, so without
  // this branch the conclusion the chair just recorded for the final
  // item would not show anywhere on the agenda.
  const isPastFinal = meeting.current.agendaItemId === undefined && meeting.current.startedAt !== undefined;

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

  return (
    <div id="panel-agenda" role="tabpanel" aria-label="Agenda" className="p-6">
      {/* Chairs list with inline edit for chairs */}
      <ChairsSection />

      {/* Optional chair-authored prologue rendered above the agenda list.
          Non-chairs see nothing when unset; chairs see a dashed
          "add a prologue" placeholder. */}
      <EditableMarkdownSection
        kind="prologue"
        value={meeting.prologue}
        isChair={isChair}
        placeholder="Add an agenda prologue"
        ariaLabel="Agenda prologue"
        onSave={(v) => socket?.emit('agenda:setPrologue', { prologue: v })}
      />

      {/* Agenda item list */}
      {meeting.agenda.length === 0 && !showForm && !showSessionForm ? (
        <div className="mb-4">
          <p className="text-stone-600 dark:text-stone-300 italic mb-2">No agenda items yet.</p>
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
                className={`border border-stone-300 dark:border-stone-600 rounded px-2 py-1 text-sm flex-1 min-w-[200px]
                           dark:bg-stone-700 dark:text-stone-100
                           focus:outline-none focus:ring-1 focus:ring-teal-500 ${inputValidation}`}
              />
              <button
                type="submit"
                disabled={importing}
                className="bg-teal-700 text-white px-3 py-1 rounded text-sm font-medium
                           enabled:hover:bg-teal-800 transition-colors cursor-pointer
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
                className="text-sm text-stone-600 dark:text-stone-300 hover:text-stone-600 dark:hover:text-stone-300 transition-colors cursor-pointer"
              >
                Cancel
              </button>
              {importError && (
                <p className="text-red-700 dark:text-red-400 text-sm w-full" role="alert">
                  {importError}
                </p>
              )}
            </form>
          )}
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          // Lock the drag ghost to vertical motion and keep it inside the
          // agenda list (the parent <ol>) — the list is strictly vertical
          // and chairs are the only ones who can drag (SortableContext is
          // disabled for non-chairs below).
          modifiers={[restrictToVerticalAxis, restrictToParentElement]}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={meeting.agenda.map((i) => i.id)}
            strategy={verticalListSortingStrategy}
            disabled={!isChair}
          >
            <ol className="space-y-1 mb-4" aria-label="Agenda items">
              {meeting.agenda.map((entry, index) => {
                if (isSession(entry)) {
                  return (
                    <SortableSession
                      key={entry.id}
                      session={entry}
                      isChair={isChair}
                      used={containment.used.get(entry.id) ?? 0}
                      runTotal={containment.runTotal.get(entry.id) ?? 0}
                      onDelete={handleDeleteSession}
                    />
                  );
                }
                const overflowSessionId = containment.overflowBy.get(entry.id);
                const prev = meeting.agenda[index - 1];
                const prevOverflowSessionId =
                  prev && isAgendaItem(prev) ? containment.overflowBy.get(prev.id) : undefined;
                // The overflow header marks the boundary where the
                // contained prefix ends and the overflow tail begins.
                // Render it once per run, immediately before the first
                // overflow item.
                const showOverflowHeader =
                  overflowSessionId !== undefined && overflowSessionId !== prevOverflowSessionId;
                const isContained = containment.containedBy.has(entry.id);
                const isOverflow = overflowSessionId !== undefined;
                return (
                  <Fragment key={entry.id}>
                    {showOverflowHeader && <OverflowHeader />}
                    <SortableAgendaItem
                      item={entry}
                      index={index}
                      displayNumber={itemNumbers.get(entry.id) ?? 0}
                      isChair={isChair}
                      isOwnItem={!!user && entry.presenterIds.includes(userKey(user))}
                      isPast={isPastFinal || index < currentIndex}
                      isCurrent={index === currentIndex}
                      isIndented={isContained || isOverflow}
                      overflowAmount={containment.overflowAmount.get(entry.id) ?? 0}
                      isFirstOverflow={showOverflowHeader}
                      currentItemStartedAt={index === currentIndex ? meeting.current.agendaItemStartTime : undefined}
                      onDelete={handleDelete}
                    />
                  </Fragment>
                );
              })}
            </ol>
          </SortableContext>
        </DndContext>
      )}

      {/* Add agenda item / session — chairs only. Only one form is shown
          at a time: opening one closes the other. */}
      {isChair && showForm && <AgendaForm onCancel={() => setShowForm(false)} onSubmit={() => setShowForm(false)} />}
      {isChair && showSessionForm && (
        <SessionForm onCancel={() => setShowSessionForm(false)} onSubmit={() => setShowSessionForm(false)} />
      )}
      {isChair && !showForm && !showSessionForm && (
        <div className="flex flex-wrap gap-2 mb-4 presentation-hidden">
          <button
            onClick={() => setShowForm(true)}
            className="border border-stone-300 dark:border-stone-600 rounded px-3 py-1 text-sm font-medium
                       text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800 transition-colors
                       cursor-pointer"
          >
            New Agenda Item
          </button>
          <button
            onClick={() => setShowSessionForm(true)}
            className="border border-stone-300 dark:border-stone-600 rounded px-3 py-1 text-sm font-medium
                       text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800 transition-colors
                       cursor-pointer"
          >
            New Session
          </button>
        </div>
      )}

      {/* Optional chair-authored epilogue rendered below the new-item /
          new-session buttons so the agenda-management controls stay
          visually adjacent to the agenda list above them. */}
      <EditableMarkdownSection
        kind="epilogue"
        value={meeting.epilogue}
        isChair={isChair}
        placeholder="Add an agenda epilogue"
        ariaLabel="Agenda epilogue"
        onSave={(v) => socket?.emit('agenda:setEpilogue', { epilogue: v })}
      />
    </div>
  );
}

// -- Sortable agenda item component --

interface SortableAgendaItemProps {
  item: AgendaItem;
  /** Position in the full entry array — drives zebra striping. */
  index: number;
  /** 1-based position among agenda items (sessions skipped) for the number column. */
  displayNumber: number;
  isChair: boolean;
  /** Whether the current user is one of this item's presenters. */
  isOwnItem: boolean;
  /**
   * True when this item sits strictly before the current one (i.e. it has
   * been covered). Dimmed with reduced opacity and muted text. Never true
   * for the current item itself.
   */
  isPast: boolean;
  /**
   * True when this item is the "current" one — its id equals
   * `meeting.current.agendaItemId`. The row is painted with an orange
   * highlight and the item name uses a higher-contrast, bolder colour so
   * the actively-discussed row stands out from the rest of the list.
   */
  isCurrent: boolean;
  /**
   * True when this item belongs to a session run (either fits within capacity
   * or sits in the overflow tail) — adds a left/right margin so the item sits
   * "inside" the session, visually distinguishing it from session and overflow
   * headers, which are flush with the agenda's outer edge.
   */
  isIndented: boolean;
  /**
   * How much this item contributes to its session's overflow, in minutes.
   * Zero when the item fits within capacity. For the first item that
   * straddles the capacity line this is only the protruding remainder;
   * for items further down the overflow tail it equals the full duration.
   * Summed across a session's items it equals `runTotal − capacity`.
   */
  overflowAmount: number;
  /**
   * True when this is the first item in its session's overflow tail (the
   * item that sits immediately after the auto-inserted overflow
   * subheader). Gates the `(overflows Xm)` text annotation: only the
   * first overflowing item in each run carries the badge so the agenda
   * doesn't repeat the same signal on every overflow row.
   */
  isFirstOverflow: boolean;
  /**
   * ISO timestamp at which the chair advanced onto this item, when this
   * item is the current one. Drives the live elapsed-time display.
   * Undefined for every non-current item so they don't subscribe to the
   * 1-second clock.
   */
  currentItemStartedAt: string | undefined;
  onDelete: (id: string) => void;
}

const SortableAgendaItem = memo(function SortableAgendaItem({
  item,
  index,
  displayNumber,
  isChair,
  isOwnItem,
  isPast,
  isCurrent,
  isIndented,
  overflowAmount,
  isFirstOverflow,
  currentItemStartedAt,
  onDelete,
}: SortableAgendaItemProps) {
  const { meeting } = useMeetingState();
  const socket = useSocket();
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editPresenters, setEditPresenters] = useState<string[]>([]);
  const [editDuration, setEditDuration] = useState('');

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
    // Stays draggable while editing — the chair can reorder an item mid-edit
    // and the in-progress form state survives because the component is keyed
    // by item.id in the parent list, so React keeps the instance across the
    // reorder.
    disabled: !isChair,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  // Shared drag handle used in both display and editing modes. Mirrors the
  // queue's ⠿ handle (QueuePanel's SortableQueueEntry), but with a fixed
  // ns-resize cursor — agenda items have no per-direction restriction logic.
  const dragHandle = isChair ? (
    <span
      className="text-stone-300 dark:text-stone-600 hover:text-stone-500 dark:hover:text-stone-400 cursor-ns-resize select-none text-sm leading-none presentation-hidden"
      aria-label={`Drag to reorder item ${displayNumber}`}
      {...attributes}
      {...listeners}
    >
      ⠿
    </span>
  ) : null;

  /** Open the inline edit form, pre-populated with current values. */
  function startEditing() {
    setEditName(item.name);
    setEditPresenters(item.presenterIds.map((k) => meeting?.users[k]?.handle ?? k));
    setEditDuration(item.duration != null && item.duration > 0 ? String(item.duration) : '');
    setEditing(true);
  }

  /** Submit the edit and close the form. */
  function handleEditSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmedName = editName.trim();
    const presenterUsernames = editPresenters.map(normaliseGithubUsername).filter((s) => s.length > 0);
    if (!trimmedName) return;

    const durationMinutes = parseInt(editDuration, 10);

    socket?.emit('agenda:edit', {
      id: item.id,
      name: trimmedName,
      presenterUsernames,
      duration: durationMinutes > 0 ? durationMinutes : null,
    });
    setEditing(false);
  }

  // Background for the row: orange highlight for the current item wins
  // over zebra striping. Dimming (opacity-60 + muted text) applies to
  // items strictly before the current one, never to the current one.
  const rowBackground = isCurrent
    ? 'bg-orange-100 dark:bg-orange-900/50'
    : index % 2 === 0
      ? 'bg-white dark:bg-stone-900'
      : 'bg-stone-100/50 dark:bg-stone-800/50';
  const dimClasses = isPast ? 'opacity-60 text-stone-500 dark:text-stone-500' : '';
  // Items belonging to a session run (contained or overflow) are indented
  // so the session visually "contains" them. Overflow items stay indented
  // alongside contained items; the boundary between them is signalled by
  // the auto-inserted overflow subsection header rendered above.
  const containedClasses = isIndented ? 'ml-4 md:ml-6' : '';
  // Dedicated marker class on the current row. Used as the JS query hook
  // for the auto-scroll-into-view effect in AgendaPanel — kept separate
  // from the Tailwind utility classes so visual restyling can't break the
  // scroll behaviour, and so the selector intent reads clearly.
  const currentMarker = isCurrent ? 'tcq-agenda-current-item' : '';

  // --- Editing mode: inline form ---
  if (editing) {
    return (
      <li
        ref={setNodeRef}
        style={style}
        className={`flex items-center gap-3 border-b border-stone-100 dark:border-stone-700 pb-2 pt-1 px-2 rounded ${rowBackground} ${dimClasses} ${containedClasses} ${currentMarker} ${isOwnItem ? 'border-l-3 border-l-teal-500 dark:border-l-teal-500' : ''}`}
      >
        {dragHandle}
        <span className="text-lg font-semibold text-stone-600 dark:text-stone-300 tabular-nums min-w-[1.5rem] text-right select-none">
          {displayNumber}
        </span>

        <form onSubmit={handleEditSubmit} className="flex-1 flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            required
            autoFocus
            aria-label="Agenda item name"
            className={`border border-stone-300 dark:border-stone-600 rounded px-2 py-0.5 text-sm flex-1 min-w-[120px]
                       dark:bg-stone-700 dark:text-stone-100
                       focus:outline-none focus:ring-1 focus:ring-teal-500 ${inputValidation}`}
          />
          <div className="min-w-[10rem] max-w-[24rem]">
            <UserCombobox
              mode="multi"
              values={editPresenters}
              onChange={setEditPresenters}
              meetingId={meeting?.id}
              ariaLabel="Presenters"
              placeholder="presenters"
            />
          </div>
          <input
            type="number"
            value={editDuration}
            onChange={(e) => setEditDuration(e.target.value)}
            min="0"
            max="999"
            placeholder="min"
            aria-label={isPast ? 'Duration in minutes' : 'Estimate in minutes'}
            className={`border border-stone-300 dark:border-stone-600 rounded px-2 py-0.5 text-sm w-16
                       dark:bg-stone-700 dark:text-stone-100
                       focus:outline-none focus:ring-1 focus:ring-teal-500 ${inputValidation}`}
          />
          <button
            type="submit"
            className="text-xs text-teal-700 dark:text-teal-400 hover:text-teal-800 dark:hover:text-teal-300 font-medium cursor-pointer"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="text-xs text-stone-600 dark:text-stone-300 hover:text-stone-600 dark:hover:text-stone-300 cursor-pointer"
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
        isDragging ? 'opacity-50 bg-stone-200 dark:bg-stone-700' : rowBackground
      } ${dimClasses} ${containedClasses} ${currentMarker} ${isOwnItem ? 'border-l-3 border-l-teal-500 dark:border-l-teal-500' : ''}`}
    >
      {dragHandle}

      {/* Item number */}
      <span className="text-lg font-semibold text-stone-600 dark:text-stone-300 tabular-nums min-w-[1.5rem] text-right select-none">
        {displayNumber}
      </span>

      <div className="flex-1 min-w-0">
        {/* Item name — the current row uses bolder, higher-contrast text
            so the actively-discussed item reads as emphatic. */}
        <InlineMarkdown
          className={`${isCurrent ? 'font-semibold text-stone-900 dark:text-stone-50' : 'font-medium text-stone-800 dark:text-stone-200'} align-middle`}
        >
          {item.name}
        </InlineMarkdown>

        {/* Presenter badges — one per presenter */}
        {item.presenterIds.map((pid) => (
          <UserBadge
            key={pid}
            user={meeting?.users[pid]}
            size={16}
            className="ml-2 text-sm text-stone-500 dark:text-stone-400"
          />
        ))}

        {/* Duration — labelled as the actual "duration" for past items
            (completed: value has been rewritten to the real elapsed time)
            and as an "estimate" for current and future items. */}
        {item.duration != null && item.duration > 0 && (
          <span
            className="ml-2 text-sm text-stone-600 dark:text-stone-300 align-middle"
            title={isPast ? 'Duration' : 'Estimate'}
            aria-label={`${isPast ? 'Duration' : 'Estimate'}: ${formatShortDuration(item.duration)}`}
          >
            {formatShortDuration(item.duration)}
          </span>
        )}

        {/* Static "(overflows Xm)" annotation — shown once per session
            run, on the first item that sits in the overflow tail. Avoids
            repeating the same signal on every overflow row, since the
            overflow subheader plus this single badge already make the
            boundary clear. */}
        {isFirstOverflow && overflowAmount > 0 && (
          <span
            className="ml-2 text-sm font-medium text-red-700 dark:text-red-400 align-middle tabular-nums select-none"
            aria-label={`Overflows by ${formatShortDuration(overflowAmount)}`}
          >
            (overflows {formatShortDuration(overflowAmount)})
          </span>
        )}

        {/* Live elapsed readout for the current row only. Mounted
            conditionally so non-current rows don't subscribe to the
            1-second clock. */}
        {isCurrent && currentItemStartedAt && <CurrentItemElapsed startedAt={currentItemStartedAt} />}

        {/* Conclusion — only shown for past items that have one. Authored
            by the chair via the next-agenda confirmation dialog. */}
        {isPast && item.conclusion && (
          <div className="text-sm text-stone-600 dark:text-stone-400 mt-0.5">
            <span className="text-xs text-stone-600 dark:text-stone-300 mr-1">Conclusion:</span>
            <InlineMarkdown>{item.conclusion}</InlineMarkdown>
          </div>
        )}
      </div>

      {/* Edit and delete buttons — chairs only. Delete is hidden for the
          current agenda item: discussion is in progress, and the chair
          must advance off it (Next Agenda Item) before it can be removed.
          The server enforces the same rule. */}
      {isChair && (
        <div className="flex gap-3 shrink-0 presentation-hidden">
          <button
            onClick={startEditing}
            className="text-xs text-stone-600 dark:text-stone-300 hover:text-teal-600 dark:hover:text-teal-400 transition-colors cursor-pointer"
            aria-label={`Edit ${item.name}`}
          >
            edit
          </button>
          {!isCurrent && (
            <button
              onClick={() => onDelete(item.id)}
              className="text-xs text-stone-600 dark:text-stone-300 hover:text-red-600 dark:hover:text-red-400 transition-colors cursor-pointer"
              aria-label={`Delete ${item.name}`}
            >
              delete
            </button>
          )}
        </div>
      )}
    </li>
  );
});

// -- Sortable session header --

interface SortableSessionProps {
  session: Session;
  isChair: boolean;
  /** Sum of durations of the contained (fitting) items following this session. */
  used: number;
  /**
   * Sum of durations across the full contiguous run that follows this
   * session, including items past capacity. When this exceeds capacity we
   * show "overflow" instead of "remaining".
   */
  runTotal: number;
  onDelete: (id: string) => void;
}

const SortableSession = memo(function SortableSession({
  session,
  isChair,
  used,
  runTotal,
  onDelete,
}: SortableSessionProps) {
  const socket = useSocket();
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editCapacity, setEditCapacity] = useState('');

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: session.id,
    disabled: !isChair || editing,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  function startEditing() {
    setEditName(session.name);
    setEditCapacity(String(session.capacity));
    setEditing(true);
  }

  function handleEditSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmedName = editName.trim();
    const capacity = parseInt(editCapacity, 10);
    if (!trimmedName || !(capacity > 0)) return;
    socket?.emit('session:edit', { id: session.id, name: trimmedName, capacity });
    setEditing(false);
  }

  const overflowing = runTotal > session.capacity;
  const remaining = session.capacity - used;
  const overflowAmount = runTotal - session.capacity;

  const baseClasses =
    'flex flex-wrap items-center gap-3 border-y border-stone-300 dark:border-stone-600 px-2 py-1.5 bg-stone-100 dark:bg-stone-800';

  if (editing) {
    return (
      <li ref={setNodeRef} style={style} className={baseClasses}>
        <form onSubmit={handleEditSubmit} className="flex-1 flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            required
            autoFocus
            aria-label="Session name"
            className={`border border-stone-300 dark:border-stone-600 rounded px-2 py-0.5 text-sm flex-1 min-w-[120px]
                       dark:bg-stone-700 dark:text-stone-100
                       focus:outline-none focus:ring-1 focus:ring-teal-500 ${inputValidation}`}
          />
          <input
            type="number"
            value={editCapacity}
            onChange={(e) => setEditCapacity(e.target.value)}
            min="1"
            max="9999"
            required
            aria-label="Session capacity in minutes"
            className={`border border-stone-300 dark:border-stone-600 rounded px-2 py-0.5 text-sm w-20
                       dark:bg-stone-700 dark:text-stone-100
                       focus:outline-none focus:ring-1 focus:ring-teal-500 ${inputValidation}`}
          />
          <button
            type="submit"
            className="text-xs text-teal-700 dark:text-teal-400 hover:text-teal-800 dark:hover:text-teal-300 font-medium cursor-pointer"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="text-xs text-stone-600 dark:text-stone-300 hover:text-stone-600 dark:hover:text-stone-300 cursor-pointer"
          >
            Cancel
          </button>
        </form>
      </li>
    );
  }

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={`${baseClasses} ${isDragging ? 'opacity-50' : ''} ${
        isChair ? 'cursor-grab active:cursor-grabbing' : ''
      }`}
      aria-label={isChair ? `Drag to reorder session ${session.name}` : undefined}
      {...(isChair ? { ...attributes, ...listeners } : {})}
    >
      <span
        className="text-base font-bold uppercase tracking-wide text-stone-700 dark:text-stone-200 flex-1 min-w-0 truncate"
        title={session.name}
      >
        {session.name}
      </span>

      <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-sm text-stone-600 dark:text-stone-400 tabular-nums">
        <span>
          capacity{' '}
          <span className="font-medium text-stone-700 dark:text-stone-300">
            {formatShortDuration(session.capacity)}
          </span>
        </span>
        <span>
          used <span className="font-medium text-stone-700 dark:text-stone-300">{formatShortDuration(used)}</span>
        </span>
        {overflowing ? (
          <span className="text-red-700 dark:text-red-400">
            overflow <span className="font-semibold">{formatShortDuration(overflowAmount)}</span>
          </span>
        ) : (
          <span>
            remaining{' '}
            <span className="font-medium text-stone-700 dark:text-stone-300">{formatShortDuration(remaining)}</span>
          </span>
        )}
      </span>

      {isChair && (
        <div className="flex gap-3 shrink-0 presentation-hidden">
          <button
            onClick={startEditing}
            className="text-xs text-stone-600 dark:text-stone-300 hover:text-teal-600 dark:hover:text-teal-400 transition-colors cursor-pointer"
            aria-label={`Edit session ${session.name}`}
          >
            edit
          </button>
          <button
            onClick={() => onDelete(session.id)}
            className="text-xs text-stone-600 dark:text-stone-300 hover:text-red-600 dark:hover:text-red-400 transition-colors cursor-pointer"
            aria-label={`Delete session ${session.name}`}
          >
            delete
          </button>
        </div>
      )}
    </li>
  );
});

// -- Live elapsed indicator for the current item --

interface CurrentItemElapsedProps {
  /** ISO timestamp when the chair advanced onto this item. */
  startedAt: string;
}

/**
 * Mounted only on the current agenda row. Subscribes to the shared
 * 1-second clock and renders a live `(elapsed M:SS)` (or `H:MM:SS`)
 * readout next to the row's duration text. Kept as its own component
 * so non-current rows don't subscribe to the clock and re-render every
 * second.
 */
function CurrentItemElapsed({ startedAt }: CurrentItemElapsedProps) {
  const now = useNow();
  const elapsedMs = Math.max(0, now - new Date(startedAt).getTime());
  return (
    <span
      className="ml-2 text-sm text-stone-700 dark:text-stone-200 align-middle tabular-nums"
      title={`Started ${new Date(startedAt).toLocaleString()}`}
      aria-label={`Elapsed: ${formatElapsed(elapsedMs)}`}
    >
      (elapsed {formatElapsed(elapsedMs)})
    </span>
  );
}

// -- Overflow subsection header --

/**
 * Auto-inserted divider that visually separates a session's contained
 * items from its overflow tail. Indented alongside the items it groups
 * so the reader sees it as a subheader *inside* the session, not as a
 * peer of the top-level session header.
 *
 * Driven entirely by `computeContainment` — appears once per session run
 * whose items exceed capacity, immediately before the first overflowing
 * item. Not draggable and not part of the SortableContext: containment is
 * recomputed from the agenda order on every render.
 */
function OverflowHeader() {
  return (
    <li
      aria-label="Overflow"
      // Inline divider: ── overflow ──. Two flex-grown rules flank the
      // label so it reads as a section break that *belongs to* the items
      // below it, not as a heavy banner.
      className="ml-4 md:ml-6 flex items-center gap-2 px-2"
    >
      <span aria-hidden="true" className="flex-1 border-t border-red-300 dark:border-red-900/60" />
      <span
        // Down-arrows flank the label so the divider also reads as a
        // directional signal: the items below are the overflow.
        className="text-[0.7rem] font-bold uppercase tracking-wide text-red-700 dark:text-red-400 leading-tight
                   flex items-center gap-1"
      >
        <span aria-hidden="true">↓</span>
        overflow
        <span aria-hidden="true">↓</span>
      </span>
      <span aria-hidden="true" className="flex-1 border-t border-red-300 dark:border-red-900/60" />
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
    const usernames = meeting!.chairIds.filter((id) => id !== chairId).map((id) => meeting!.users[id]?.handle ?? id);
    socket?.emit('meeting:updateChairs', { usernames });
    setRemoveConfirm(null);
  }

  /** Add a new chair by username. */
  function commitAdd(rawUsername: string) {
    const username = normaliseGithubUsername(rawUsername);
    if (!username) return;

    const usernames = meeting!.chairIds.map((id) => meeting!.users[id]?.handle ?? id);
    if (!usernames.some((u) => u.toLowerCase() === username.toLowerCase())) {
      usernames.push(username);
    }
    socket?.emit('meeting:updateChairs', { usernames });
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
              className={`inline-flex items-center gap-1 bg-stone-200 dark:bg-stone-700 rounded-full pl-1 py-1 ${canRemove(chairId) ? 'pr-1' : 'pr-2'}`}
            >
              <UserBadge user={chair} size={18} />
              {canRemove(chairId) && (
                <button
                  onClick={() => setRemoveConfirm(chairId)}
                  className="text-red-400 hover:text-red-600 dark:hover:text-red-400 transition-colors
                             cursor-pointer presentation-hidden"
                  aria-label={`Remove chair ${chair?.handle ?? chairId}`}
                >
                  <CircleXIcon />
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
            <CirclePlusIcon />
          </button>
        )}

        {adding && (
          <span className="inline-flex items-center gap-1">
            <UserCombobox
              mode="single"
              meetingId={meeting.id}
              autoFocus
              placeholder="username"
              ariaLabel="New chair username"
              onCommit={commitAdd}
              onCancel={() => setAdding(false)}
              inputClassName="border border-stone-300 dark:border-stone-600 rounded px-2 py-0.5 text-sm w-32
                              dark:bg-stone-700 dark:text-stone-100
                              focus:outline-none focus:ring-1 focus:ring-teal-500"
            />
            <button
              type="button"
              onClick={() => setAdding(false)}
              className="text-xs text-stone-600 dark:text-stone-300 hover:text-stone-600 dark:hover:text-stone-300 cursor-pointer"
            >
              Cancel
            </button>
          </span>
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
                className="text-sm text-stone-600 dark:text-stone-300 hover:text-stone-800 dark:hover:text-stone-100
                           transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={() => handleRemove(removeConfirm)}
                autoFocus
                className="bg-red-600 text-white px-4 py-1.5 rounded text-sm font-medium
                           hover:bg-red-700 transition-colors cursor-pointer
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

// -- Editable markdown section (prologue / epilogue) --

interface EditableMarkdownSectionProps {
  /** Distinguishes prologue from epilogue for aria-labels and section ids. */
  kind: 'prologue' | 'epilogue';
  /** Current value from `meeting.prologue` / `meeting.epilogue`. */
  value: string | undefined;
  isChair: boolean;
  /** Placeholder text rendered inside the dashed-border "add" button. */
  placeholder: string;
  /** Accessible label for the section and its textarea. */
  ariaLabel: string;
  /**
   * Called with the trimmed editor contents on save. Empty string means
   * the user emptied the textarea and saved — the server treats that as
   * a clear (same as the delete button).
   */
  onSave: (value: string) => void;
}

/**
 * Chair-editable, sanitised-block-markdown section. Three resting
 * states:
 *
 *   - **empty + non-chair**: renders nothing.
 *   - **empty + chair**: dashed-border placeholder button.
 *   - **populated**: rendered `<BlockMarkdown>` with chair-only edit /
 *     delete controls in the top-right.
 *
 * The fourth state, **editing**, is chairs-only and replaces the section
 * with a textarea + Save/Cancel. Ctrl/Cmd+Enter saves. Saving with an
 * empty textarea is equivalent to clicking delete.
 *
 * Two confirmation dialogues guard destructive / overwriting actions:
 *
 *   - **Delete**: clicking the chair-only delete control opens a
 *     "Delete prologue?" dialogue; the delete only fires after
 *     confirmation.
 *   - **Overwrite**: if another chair changed the section while the
 *     editor was open (signalled by the conflict toast), pressing Save
 *     opens an "Overwrite their changes?" dialogue. Without an active
 *     conflict, Save submits directly.
 *
 * Concurrent edits surface a persistent warning toast: if the value
 * arriving via socket changes while the editor is open, we raise a
 * non-auto-dismissing toast — chairs can finish their thought, read the
 * warning, and then decide to Save/Cancel/dismiss. The local `conflict`
 * flag is what actually gates Save (an active conflict turns Save into an
 * overwrite confirmation); the toast is just its presentation, kept in
 * sync below.
 */
function EditableMarkdownSection({
  kind,
  value,
  isChair,
  placeholder,
  ariaLabel,
  onSave,
}: EditableMarkdownSectionProps) {
  const { showToast, dismissToast } = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [conflict, setConflict] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [overwriteConfirm, setOverwriteConfirm] = useState(false);
  // Id of the live conflict toast, so we can dismiss it when the conflict
  // resolves (save / cancel / unmount).
  const conflictToastRef = useRef<string | null>(null);
  // Snapshot of the value at the moment editing started. A change in
  // the incoming `value` prop while the editor is open means another
  // chair just modified the same section.
  const baselineRef = useRef<string | undefined>(undefined);

  // Detect concurrent edits while the textarea is open. The conflict is
  // sticky: once flagged, it stays until the user dismisses, cancels, or
  // saves — but we update the baseline so a *further* remote change
  // doesn't re-flash it (its presence already conveys the condition).
  useEffect(() => {
    if (!editing) return;
    if (value !== baselineRef.current) {
      setConflict(true);
      baselineRef.current = value;
    }
  }, [editing, value]);

  // Mirror the `conflict` flag onto a persistent warning toast. Raised when the
  // conflict appears, dismissed when it clears. A manual close of the toast
  // clears `conflict` too (via onDismiss) — same as dismissing the old inline
  // banner, so a subsequent Save no longer warns.
  useEffect(() => {
    if (conflict && conflictToastRef.current === null) {
      conflictToastRef.current = showToast({
        message: `Another chair has updated the ${kind} while you were editing. Saving will overwrite their changes.`,
        variant: 'warning',
        durationMs: null,
        onDismiss: () => {
          conflictToastRef.current = null;
          setConflict(false);
        },
      });
    } else if (!conflict && conflictToastRef.current !== null) {
      const id = conflictToastRef.current;
      conflictToastRef.current = null;
      dismissToast(id);
    }
  }, [conflict, kind, showToast, dismissToast]);

  // Tidy up if the section unmounts while the conflict toast is still up.
  useEffect(() => {
    return () => {
      if (conflictToastRef.current !== null) {
        dismissToast(conflictToastRef.current);
        conflictToastRef.current = null;
      }
    };
  }, [dismissToast]);

  function startEditing() {
    setDraft(value ?? '');
    baselineRef.current = value;
    setConflict(false);
    setOverwriteConfirm(false);
    setEditing(true);
  }

  function cancelEditing() {
    setEditing(false);
    setDraft('');
    setConflict(false);
    setOverwriteConfirm(false);
    baselineRef.current = undefined;
  }

  /** Actually commit the current draft and exit edit mode. */
  function commitDraft() {
    onSave(draft.trim());
    setEditing(false);
    setDraft('');
    setConflict(false);
    setOverwriteConfirm(false);
    baselineRef.current = undefined;
  }

  function handleSaveClick(e?: FormEvent) {
    e?.preventDefault();
    // If a conflict is active, the chair is about to knowingly overwrite
    // another chair's changes — confirm first. Without a conflict signal,
    // Save commits directly.
    if (conflict) {
      setOverwriteConfirm(true);
      return;
    }
    commitDraft();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSaveClick();
    }
  }

  /** Title-cased section name used in dialogue copy ("Prologue" / "Epilogue"). */
  const kindTitle = kind === 'prologue' ? 'Prologue' : 'Epilogue';

  // --- Editing mode (chairs only) ---
  if (editing) {
    // Defensive: if chair status was lost while the editor was open,
    // hide it (the user can no longer save anyway — server would reject).
    if (!isChair) return null;
    return (
      <section aria-label={ariaLabel} className="mb-4 presentation-hidden">
        <form onSubmit={handleSaveClick} className="flex flex-col gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
            aria-label={ariaLabel}
            className="border border-stone-300 dark:border-stone-600 rounded px-2 py-1 text-sm w-full min-h-[6rem]
                       dark:bg-stone-700 dark:text-stone-100 font-mono
                       focus:outline-none focus:ring-1 focus:ring-teal-500"
          />
          <div className="flex items-center gap-3">
            <button
              type="submit"
              className="text-xs text-teal-700 dark:text-teal-400 hover:text-teal-800 dark:hover:text-teal-300 font-medium cursor-pointer"
            >
              Save
            </button>
            <button
              type="button"
              onClick={cancelEditing}
              className="text-xs text-stone-600 dark:text-stone-300 hover:text-stone-600 dark:hover:text-stone-300 cursor-pointer"
            >
              Cancel
            </button>
            <span className="text-xs text-stone-600 dark:text-stone-300">
              {/* Hint mirrors the queue-edit shortcut for muscle-memory consistency. */}
              Ctrl/Cmd+Enter to save
            </span>
          </div>
        </form>

        {overwriteConfirm && (
          <ConfirmDialogue
            title={`Overwrite ${kindTitle}`}
            body={
              <>
                Another chair has updated the {kind} while you were editing. Saving will overwrite their changes with
                yours.
              </>
            }
            confirmLabel="Save anyway"
            confirmVariant="amber"
            onCancel={() => setOverwriteConfirm(false)}
            onConfirm={commitDraft}
          />
        )}
      </section>
    );
  }

  // --- Empty / placeholder ---
  if (value === undefined || value.length === 0) {
    if (!isChair) return null;
    return (
      <button
        type="button"
        onClick={startEditing}
        aria-label={placeholder}
        className="mb-4 w-full border-2 border-dashed border-stone-300 dark:border-stone-600 rounded p-4 text-center
                   text-sm text-stone-500 dark:text-stone-400
                   hover:bg-stone-100 dark:hover:bg-stone-800 transition-colors cursor-pointer presentation-hidden"
      >
        {placeholder}
      </button>
    );
  }

  // --- Populated display ---
  return (
    <section aria-label={ariaLabel} className="mb-4 relative">
      <BlockMarkdown className="text-sm text-stone-700 dark:text-stone-300">{value}</BlockMarkdown>
      {isChair && (
        <div className="absolute top-1 right-1 flex gap-3 shrink-0 presentation-hidden">
          <button
            type="button"
            onClick={startEditing}
            className="text-xs text-stone-600 dark:text-stone-300 hover:text-teal-600 dark:hover:text-teal-400 transition-colors cursor-pointer"
            aria-label={`Edit ${kind}`}
          >
            edit
          </button>
          <button
            type="button"
            onClick={() => setDeleteConfirm(true)}
            className="text-xs text-stone-600 dark:text-stone-300 hover:text-red-600 dark:hover:text-red-400 transition-colors cursor-pointer"
            aria-label={`Delete ${kind}`}
          >
            delete
          </button>
        </div>
      )}

      {deleteConfirm && (
        <ConfirmDialogue
          title={`Delete ${kindTitle}`}
          body={
            <>
              Delete the {kind}? This clears it for everyone. You can re-add it later, but the current content will be
              lost.
            </>
          }
          confirmLabel="Delete"
          confirmVariant="red"
          onCancel={() => setDeleteConfirm(false)}
          onConfirm={() => {
            setDeleteConfirm(false);
            onSave('');
          }}
        />
      )}
    </section>
  );
}

interface ConfirmDialogueProps {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  /** Background colour for the confirm button — red for destructive, amber for overwrite. */
  confirmVariant: 'red' | 'amber';
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Modal confirmation dialogue shared by the delete and overwrite flows
 * on the agenda prologue/epilogue. Layout and click-out-to-cancel
 * behaviour mirror the "Remove chair" modal in `ChairsSection`.
 */
function ConfirmDialogue({ title, body, confirmLabel, confirmVariant, onCancel, onConfirm }: ConfirmDialogueProps) {
  const confirmClasses =
    confirmVariant === 'red'
      ? 'bg-red-600 hover:bg-red-700 focus:ring-red-500'
      : 'bg-amber-700 hover:bg-amber-800 focus:ring-amber-500';
  return (
    <div
      className="fixed inset-0 top-[3rem] bg-black/30 flex items-center justify-center z-40"
      onClick={onCancel}
      role="dialog"
      aria-label={title}
    >
      <div
        className="bg-white dark:bg-stone-900 rounded-lg shadow-lg dark:shadow-stone-950/50 p-6 max-w-sm mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold text-stone-800 dark:text-stone-200 mb-2">{title}</h3>
        <p className="text-sm text-stone-600 dark:text-stone-400 mb-4">{body}</p>
        <div className="flex gap-3 justify-end">
          <button
            type="button"
            onClick={onCancel}
            className="text-sm text-stone-600 dark:text-stone-300 hover:text-stone-800 dark:hover:text-stone-100
                       transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            autoFocus
            className={`${confirmClasses} text-white px-4 py-1.5 rounded text-sm font-medium transition-colors cursor-pointer
                       focus:outline-none focus:ring-2 focus:ring-offset-2 dark:focus:ring-offset-stone-900`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
