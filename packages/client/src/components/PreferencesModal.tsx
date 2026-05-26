/**
 * Preferences modal — exposes the keyboard-shortcuts toggle, notification
 * settings, the saved-topics editor, and a light/dark/system theme
 * selector. Reached from the hamburger menu, the saved-topics
 * dropdown's "Edit…" entry, or via the `,` keyboard shortcut.
 *
 * Persists changes to localStorage immediately (no Save button).
 *
 * Built on a native modal <dialog> opened with showModal(): focus trapping,
 * focus restoration, Esc / Android-back dismissal, and top-layer stacking
 * come for free from the platform. Light dismiss (click outside) is declared
 * with `closedby="any"`, with a JS coordinate fallback for browsers that lack
 * it (notably Safari). `showPreferences` from PreferencesContext stays the
 * single source of truth: an effect mirrors it onto showModal()/close(), and
 * the dialog's `close` event mirrors any platform-driven close back into it.
 * The ::backdrop tint and entry/exit animation live in index.css.
 */

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
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
import type { QueueEntryType } from '@tcq/shared';
import { QUEUE_ENTRY_TYPES, QUEUE_ENTRY_LABELS, QUEUE_ENTRY_EMOJI } from '@tcq/shared';
import { usePreferences, type Theme, type NotificationPrefs } from '../contexts/PreferencesContext.js';
import { notificationsSupported } from '../lib/notifications.js';
import { useSavedTopics, type SavedTopic } from '../hooks/useSavedTopics.js';

const THEME_OPTIONS: { value: Theme; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
];

const NOTIFICATION_OPTIONS: { key: keyof NotificationPrefs; label: string }[] = [
  { key: 'onMyTurnToSpeak', label: 'When your queue entry is next' },
  { key: 'onMyAgendaItemNext', label: 'When your agenda item is next' },
  { key: 'onMeetingStarted', label: 'When the meeting has started' },
  { key: 'onAgendaAdvance', label: 'When the agenda advances' },
  { key: 'onPollStarted', label: 'When a poll has started' },
  { key: 'onClarifyingQuestionOnMyTopic', label: 'When a clarifying question is raised on your topic' },
  { key: 'onPointOfOrder', label: 'When a point of order is raised' },
  { key: 'onAgendaItemOverrun', label: 'When the current agenda item exceeds its time estimate' },
];

// Stable references so useSensor's internal useMemo doesn't invalidate every render.
const POINTER_SENSOR_OPTIONS = {
  activationConstraint: { distance: 5 },
};
const KEYBOARD_SENSOR_OPTIONS = {
  coordinateGetter: sortableKeyboardCoordinates,
};

export function PreferencesModal() {
  const {
    showPreferences,
    closePreferences,
    shortcutsEnabled,
    setShortcutsEnabled,
    theme,
    setTheme,
    notificationsEnabled,
    setNotificationsEnabled,
    notificationPrefs,
    setNotificationPrefs,
    focusSection,
    clearFocusSection,
  } = usePreferences();

  const supported = notificationsSupported();

  const dialogRef = useRef<HTMLDialogElement | null>(null);
  // Section refs so we can scroll a deep-linked section into view on open.
  const savedTopicsSectionRef = useRef<HTMLElement | null>(null);

  // The <dialog> element is always mounted (so showModal() has a stable
  // target), but its *contents* are rendered only while open or animating
  // closed — see `isClosing`. A dismissed modal must contribute no form
  // controls to the DOM: Playwright's getByLabel/getByText match hidden
  // elements, so leaving the controls mounted would let them collide with
  // unrelated label/text queries across the suite.
  //
  // `isClosing` is adjusted during render (React's "store info from previous
  // renders" pattern) rather than in an effect, so the contents stay mounted
  // on the very render that hides the modal — otherwise they'd unmount before
  // the exit transition could play.
  const [isClosing, setIsClosing] = useState(false);
  const [wasOpen, setWasOpen] = useState(showPreferences);
  if (wasOpen !== showPreferences) {
    setWasOpen(showPreferences);
    setIsClosing(!showPreferences);
  }
  const renderContents = showPreferences || isClosing;

  // Mirror the React open/close state onto the native dialog. showModal()
  // puts the dialog in the top layer (focus trap, Esc/back-gesture handling,
  // ::backdrop); close() runs the exit animation via the CSS transition.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (showPreferences && !dialog.open) dialog.showModal();
    else if (!showPreferences && dialog.open) dialog.close();
  }, [showPreferences]);

  // Once the exit transition finishes, drop the contents from the DOM. The
  // timeout is a safety net for environments where no `transitionend` fires
  // (e.g. transitions disabled), so the contents can't get stuck mounted.
  useEffect(() => {
    if (!isClosing) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      setIsClosing(false);
    };
    const onTransitionEnd = (e: TransitionEvent) => {
      if (e.target === dialog) finish();
    };
    dialog.addEventListener('transitionend', onTransitionEnd);
    const timer = window.setTimeout(finish, 300);
    return () => {
      dialog.removeEventListener('transitionend', onTransitionEnd);
      window.clearTimeout(timer);
    };
  }, [isClosing]);

  // Set up the dialog once it's mounted: enable declarative light-dismiss,
  // mirror platform-driven closes back into React, and register the
  // outside-click fallback for browsers without `closedby` (e.g. Safari).
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    // `closedby="any"` = light dismiss + close requests. Set imperatively
    // because React's typings don't yet know the attribute.
    dialog.setAttribute('closedby', 'any');

    // Esc, the Android back gesture, light dismiss, and our fallback all
    // surface as a `close` event — funnel them back into the source of truth.
    const onClose = () => closePreferences();
    dialog.addEventListener('close', onClose);

    // Fallback light dismiss for browsers lacking `closedby`: a click whose
    // coordinates fall on the backdrop (outside the dialog's content box, and
    // with the dialog itself as the target) closes it.
    const supportsClosedBy = 'closedBy' in HTMLDialogElement.prototype;
    const onClick = (e: MouseEvent) => {
      if (e.target !== dialog) return;
      const r = dialog.getBoundingClientRect();
      const inside =
        r.top <= e.clientY && e.clientY <= r.top + r.height && r.left <= e.clientX && e.clientX <= r.left + r.width;
      if (!inside) dialog.close();
    };
    if (!supportsClosedBy) dialog.addEventListener('click', onClick);

    return () => {
      dialog.removeEventListener('close', onClose);
      if (!supportsClosedBy) dialog.removeEventListener('click', onClick);
    };
  }, [closePreferences]);

  // When opened with a focusSection (e.g. from the saved-topics
  // dropdown), scroll that section into view once and then clear the
  // flag so a later re-render doesn't re-scroll.
  useEffect(() => {
    if (!showPreferences || focusSection == null) return;
    if (focusSection === 'saved-topics') {
      savedTopicsSectionRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
    clearFocusSection();
  }, [showPreferences, focusSection, clearFocusSection]);

  // The dialog stays mounted even when closed so showModal() has an element
  // to act on and the exit transition can play; a closed <dialog> is
  // display:none, so it stays out of the layout and the a11y tree. Its
  // contents render only while `renderContents` (open or animating closed).
  return (
    <dialog
      ref={dialogRef}
      aria-label="Preferences"
      className="tcq-dialog w-[min(28rem,calc(100vw-2rem))] max-h-[calc(100vh-6rem)] overflow-y-auto rounded-lg
                 border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 p-6 text-left
                 shadow-lg dark:shadow-stone-950/50"
    >
      {renderContents && (
        <>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-stone-800 dark:text-stone-200">Preferences</h2>
            <button
              onClick={() => dialogRef.current?.close()}
              className="text-stone-600 dark:text-stone-300 hover:text-stone-600 dark:hover:text-stone-300 cursor-pointer text-lg"
              aria-label="Close"
            >
              ✕
            </button>
          </div>

          <section className="mb-4">
            <label className="inline-flex items-center gap-2 text-sm font-medium text-stone-700 dark:text-stone-300 cursor-pointer">
              Keyboard shortcuts
              <input
                type="checkbox"
                checked={shortcutsEnabled}
                onChange={(e) => setShortcutsEnabled(e.target.checked)}
                className="cursor-pointer"
              />
            </label>
          </section>

          <section className="mb-4">
            <label
              className={`inline-flex items-center gap-2 text-sm font-medium text-stone-700 dark:text-stone-300 ${supported ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}
            >
              Notifications
              <input
                type="checkbox"
                checked={notificationsEnabled}
                onChange={(e) => setNotificationsEnabled(e.target.checked)}
                disabled={!supported}
                className={supported ? 'cursor-pointer' : 'cursor-not-allowed'}
              />
            </label>
            {!supported && (
              <p className="text-xs text-stone-500 dark:text-stone-500 mt-1">
                Your browser doesn&rsquo;t support notifications.
              </p>
            )}
            <div className="mt-2 ml-5 flex flex-col gap-1">
              {NOTIFICATION_OPTIONS.map((option) => (
                <label
                  key={option.key}
                  className={`inline-flex items-center gap-2 text-sm text-stone-600 dark:text-stone-400 ${notificationsEnabled ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'}`}
                >
                  <input
                    type="checkbox"
                    checked={notificationPrefs[option.key]}
                    onChange={(e) => setNotificationPrefs({ ...notificationPrefs, [option.key]: e.target.checked })}
                    disabled={!notificationsEnabled}
                    className={notificationsEnabled ? 'cursor-pointer' : 'cursor-not-allowed'}
                  />
                  {option.label}
                </label>
              ))}
            </div>
          </section>

          <SavedTopicsSection sectionRef={savedTopicsSectionRef} />

          <section>
            <label className="flex items-center gap-3 text-sm text-stone-700 dark:text-stone-300">
              <span className="font-medium">Colour scheme</span>
              <select
                value={theme}
                onChange={(e) => setTheme(e.target.value as Theme)}
                className="border border-stone-300 dark:border-stone-600 rounded px-2 py-1 text-sm
                         bg-white dark:bg-stone-800 text-stone-700 dark:text-stone-200 cursor-pointer
                         focus:outline-none focus:ring-1 focus:ring-teal-500"
              >
                {THEME_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </section>
        </>
      )}
    </dialog>
  );
}

// ----- Saved topics editor -----

interface SavedTopicsSectionProps {
  sectionRef: React.RefObject<HTMLElement | null>;
}

function SavedTopicsSection({ sectionRef }: SavedTopicsSectionProps) {
  const { topics, add, update, setType, remove, reorder, max } = useSavedTopics();
  const atCap = topics.length >= max;
  // When the user adds a new row, focus its input so they can type
  // immediately. Tracked here rather than inside the row component so
  // the focus survives the re-render that adding a row triggers.
  const [autoFocusId, setAutoFocusId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, POINTER_SENSOR_OPTIONS),
    useSensor(KeyboardSensor, KEYBOARD_SENSOR_OPTIONS),
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    reorder(String(active.id), String(over.id));
  }

  function handleAdd() {
    // Seed an empty row and focus it. The row's commit handler removes
    // the entry if the user blurs without typing anything, so an
    // abandoned add doesn't leave junk in the list.
    const newId = add('');
    if (newId) setAutoFocusId(newId);
  }

  return (
    <section ref={sectionRef} className="mb-4" aria-labelledby="saved-topics-heading">
      <h3 id="saved-topics-heading" className="text-sm font-medium text-stone-700 dark:text-stone-300 mb-2">
        Saved topics
      </h3>
      <p className="text-xs text-stone-500 dark:text-stone-500 mb-2">
        Pre-written queue topics you can post with one click. The dropdown beside each sets the priority it joins the
        queue as.
      </p>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis, restrictToParentElement]}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={topics.map((r) => r.id)} strategy={verticalListSortingStrategy}>
          <ul className="flex flex-col gap-1" aria-label="Saved topics">
            {topics.map((r) => (
              <SortableSavedTopicRow
                key={r.id}
                topic={r}
                autoFocus={r.id === autoFocusId}
                onAutoFocusConsumed={() => setAutoFocusId(null)}
                onCommit={(text) => {
                  // Empty commit removes the row — typical for a freshly
                  // added entry the user backed out of.
                  if (text.trim() === '') remove(r.id);
                  else update(r.id, text);
                }}
                onTypeChange={(type) => setType(r.id, type)}
                onDelete={() => remove(r.id)}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
      <button
        type="button"
        onClick={handleAdd}
        disabled={atCap}
        className={`mt-2 border border-stone-300 dark:border-stone-600 rounded px-3 py-1 text-xs font-medium
                    text-stone-600 dark:text-stone-400 transition-colors
                    ${atCap ? 'opacity-50 cursor-not-allowed' : 'hover:bg-stone-100 dark:hover:bg-stone-800 cursor-pointer'}`}
      >
        Add saved topic
      </button>
    </section>
  );
}

interface SortableSavedTopicRowProps {
  topic: SavedTopic;
  autoFocus: boolean;
  onAutoFocusConsumed: () => void;
  onCommit: (text: string) => void;
  onTypeChange: (type: QueueEntryType) => void;
  onDelete: () => void;
}

function SortableSavedTopicRow({
  topic,
  autoFocus,
  onAutoFocusConsumed,
  onCommit,
  onTypeChange,
  onDelete,
}: SortableSavedTopicRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: topic.id });
  const [draft, setDraft] = useState(topic.text);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Keep the input in sync when the persisted value changes underneath
  // (e.g. another tab updates it). Avoid clobbering an in-progress edit
  // by only re-syncing while the input isn't focused.
  useEffect(() => {
    if (document.activeElement !== inputRef.current) setDraft(topic.text);
  }, [topic.text]);

  useEffect(() => {
    if (autoFocus) {
      inputRef.current?.focus();
      onAutoFocusConsumed();
    }
  }, [autoFocus, onAutoFocusConsumed]);

  function handleBlur() {
    if (draft === topic.text) return;
    onCommit(draft);
  }

  function handleKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      inputRef.current?.blur();
    } else if (e.key === 'Escape') {
      // Stop propagation so the modal's document-level listener doesn't
      // close the dialog when the user only wants to revert this row.
      e.preventDefault();
      e.stopPropagation();
      setDraft(topic.text);
      inputRef.current?.blur();
    }
  }

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };

  return (
    <li
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-1 bg-white dark:bg-stone-900 rounded px-1 py-0.5"
    >
      <span
        className="text-stone-300 dark:text-stone-600 hover:text-stone-500 dark:hover:text-stone-400 cursor-ns-resize select-none text-sm leading-none px-1"
        aria-label="Drag to reorder"
        {...attributes}
        {...listeners}
      >
        ⠿
      </span>
      <input
        ref={inputRef}
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        aria-label="Saved topic text"
        placeholder="Saved topic text"
        className="flex-1 min-w-0 border border-stone-300 dark:border-stone-600 rounded px-2 py-0.5 text-sm
                   bg-white dark:bg-stone-800 text-stone-700 dark:text-stone-200
                   focus:outline-none focus:ring-1 focus:ring-teal-500"
      />
      {/* Priority selector. Shows the entry-type emoji only to stay compact;
          the human label rides along as each option's accessible name/title. */}
      <select
        value={topic.type}
        onChange={(e) => onTypeChange(e.target.value as QueueEntryType)}
        aria-label="Saved topic priority"
        title={QUEUE_ENTRY_LABELS[topic.type]}
        className="shrink-0 border border-stone-300 dark:border-stone-600 rounded px-1 py-0.5 text-sm
                   bg-white dark:bg-stone-800 text-stone-700 dark:text-stone-200
                   focus:outline-none focus:ring-1 focus:ring-teal-500 cursor-pointer"
      >
        {/* Reversed so the dropdown reads New Topic → … → Point of Order. */}
        {[...QUEUE_ENTRY_TYPES].reverse().map((type) => (
          <option key={type} value={type} aria-label={QUEUE_ENTRY_LABELS[type]} title={QUEUE_ENTRY_LABELS[type]}>
            {QUEUE_ENTRY_EMOJI[type]}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={onDelete}
        aria-label="Delete saved topic"
        className="text-stone-400 hover:text-red-600 dark:text-stone-500 dark:hover:text-red-400 cursor-pointer px-1 text-sm"
      >
        ✕
      </button>
    </li>
  );
}
