/**
 * Speaker entry controls — the row of buttons for entering the speaker queue.
 *
 * Clicking a button calls onAddEntry with the type. The parent handles
 * emitting the socket event (in the "pending initial-edit" state) and
 * triggering auto-edit. The default topic that participants see if the
 * author cancels comes from the server via `QUEUE_ENTRY_DEFAULT_TOPICS`.
 *
 * Four entry types are shown as coloured buttons:
 * - New Topic (blue)
 * - Discuss Current Topic / Reply (cyan) — only shown when there's a current topic
 * - Clarifying Question (green)
 * - Point of Order (red)
 *
 * A fifth button to the right opens the user's saved topics dropdown
 * (see useSavedTopics). Clicking a saved topic immediately adds a finished
 * entry to the queue at the saved topic's configured priority, skipping the
 * pending/initial-edit state. Entries whose priority isn't currently addable
 * (e.g. a Reply with no active topic) are disabled in the dropdown.
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { QueueEntryType, MeetingState } from '@tcq/shared';
import { QUEUE_ENTRY_EMOJI } from '@tcq/shared';
import { useMeetingState, useIsChair } from '../contexts/MeetingContext.js';
import { ChevronDownIcon } from './icons.js';
import { usePreferences } from '../contexts/PreferencesContext.js';
import { useSavedTopics, type SavedTopic } from '../hooks/useSavedTopics.js';

/** Configuration for each entry type button. The decorative emoji defaults to
 *  the shared `QUEUE_ENTRY_EMOJI` map (so the buttons and the neutral-surface
 *  dropdown stay in sync); `emojiOverride` lets a coloured button swap in a
 *  glyph that reads better on its fill. */
const ENTRY_TYPES: {
  type: QueueEntryType;
  label: string;
  /** Tailwind classes for the button background. */
  bgClass: string;
  /** Whether this type requires a current topic to be visible. */
  requiresTopic: boolean;
  /** Glyph for the button only, when the shared neutral-surface emoji doesn't
   *  read well on the coloured fill. Falls back to QUEUE_ENTRY_EMOJI. */
  emojiOverride?: string;
}[] = [
  {
    type: 'topic',
    label: 'New Topic',
    bgClass: 'bg-blue-700 enabled:hover:bg-blue-800',
    requiresTopic: false,
  },
  {
    type: 'reply',
    label: 'Discuss Current Topic',
    bgClass: 'bg-cyan-700 enabled:hover:bg-cyan-800',
    requiresTopic: true,
  },
  {
    type: 'question',
    label: 'Clarifying Question',
    bgClass: 'bg-green-700 enabled:hover:bg-green-800',
    requiresTopic: false,
    // White outline ❔ reads better than the shared red ❓ on the green fill.
    emojiOverride: '❔',
  },
  {
    type: 'point-of-order',
    label: 'Point of Order',
    bgClass: 'bg-rose-700 enabled:hover:bg-rose-800',
    requiresTopic: false,
  },
];

/**
 * Whether a saved-topic of `type` can currently be added, and if not, a short
 * reason for the dropdown's tooltip. Mirrors the gates in `addQueueEntry` /
 * `addSavedTopic`: Point of Order is always permitted; a closed queue blocks
 * everything else for non-chairs; a Reply needs an active topic.
 */
function savedTopicTypeBlock(
  type: QueueEntryType,
  meeting: MeetingState,
  isChair: boolean,
): { disabled: boolean; reason?: string } {
  if (type === 'point-of-order') return { disabled: false };
  if (meeting.queue.closed && !isChair) return { disabled: true, reason: 'The queue is closed' };
  if (type === 'reply' && !meeting.current.topic) return { disabled: true, reason: 'No active topic to reply to' };
  return { disabled: false };
}

interface SpeakerControlsProps {
  /** Called to add an entry to the queue (in the pending initial-edit state). */
  onAddEntry: (type: QueueEntryType) => void;
  /** Called when the user selects one of their saved topics. The parent emits
   *  a finished add at the saved topic's configured priority (no pending state,
   *  no auto-edit). */
  onSavedTopic: (text: string, type: QueueEntryType) => void;
}

export function SpeakerControls({ onAddEntry, onSavedTopic }: SpeakerControlsProps) {
  const { meeting } = useMeetingState();
  const isChair = useIsChair();

  if (!meeting) return null;

  return (
    <div>
      {/* Entry type buttons */}
      <div className="flex flex-wrap gap-2 mb-3 presentation-hidden" role="group" aria-label="Queue entry types">
        {ENTRY_TYPES.map((config) => {
          // Hide the Reply button when there's no current topic
          if (config.requiresTopic && !meeting.current.topic) return null;

          // Point of Order is a procedural interruption and is always
          // permitted, even when the queue is closed to non-chairs.
          const disabled = meeting.queue.closed && !isChair && config.type !== 'point-of-order';

          return (
            <button
              key={config.type}
              onClick={() => onAddEntry(config.type)}
              disabled={disabled}
              className={`inline-flex items-center gap-1.5 text-white text-sm font-medium pl-2.5 pr-3 py-1.5 rounded
                         transition-colors
                         focus:outline-none focus:ring-2 focus:ring-offset-2 dark:focus:ring-offset-stone-900 focus:ring-blue-500
                         ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
                         ${config.bgClass}`}
            >
              {/* Oversized emoji: enlarged glyph, but leading-5 caps the line
                  box at the label's height so the button doesn't grow taller —
                  the glyph just overflows into the existing vertical padding. */}
              <span aria-hidden="true" className="text-[1.375rem] leading-5">
                {config.emojiOverride ?? QUEUE_ENTRY_EMOJI[config.type]}
              </span>
              {config.label}
            </button>
          );
        })}
        <SavedTopicButton onSelect={onSavedTopic} typeBlock={(type) => savedTopicTypeBlock(type, meeting, isChair)} />
      </div>
    </div>
  );
}

/** The recycle-and-chevron button that opens the saved-topics dropdown.
 *  Lives in the same file so it can sit naturally inside the entry-types
 *  flex row. The button stays enabled even when the queue is closed — Point
 *  of Order saved topics and the Edit link must stay reachable — so the
 *  closed-queue gate is applied per-item via `typeBlock` instead. */
interface SavedTopicButtonProps {
  onSelect: (text: string, type: QueueEntryType) => void;
  /** Whether a saved-topic of the given type can currently be added, plus a
   *  reason for the tooltip when it can't. */
  typeBlock: (type: QueueEntryType) => { disabled: boolean; reason?: string };
}

function SavedTopicButton({ onSelect, typeBlock }: SavedTopicButtonProps) {
  const { topics } = useSavedTopics();
  const { openPreferences } = usePreferences();
  const [open, setOpen] = useState(false);
  // Anchor coordinates and width are measured on toggle so the portaled
  // dropdown can position itself flush with the button. Same approach the
  // HamburgerMenu uses to escape parents that clip or cap z-index.
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const dropdownRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  function toggleMenu() {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPos({ top: rect.bottom + 6, left: rect.left });
    setOpen(true);
  }

  // Dismiss on Escape anywhere in the document.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // Dismiss on pointerdown outside the button or the portaled dropdown.
  // pointerdown (not click) so the same gesture both closes the menu and
  // reaches the underlying element.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node | null;
      if (!target) return;
      if (buttonRef.current?.contains(target)) return;
      if (dropdownRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  function handleSelect(topic: SavedTopic) {
    setOpen(false);
    onSelect(topic.text, topic.type);
  }

  function handleEdit() {
    setOpen(false);
    openPreferences('saved-topics');
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={toggleMenu}
        aria-label="Saved topics"
        aria-haspopup="menu"
        aria-expanded={open}
        // Match the height/padding of the other entry buttons so the row
        // stays visually aligned, but use a neutral background — the
        // button isn't a queue-entry type, it's a meta control.
        className="text-sm font-medium px-1 py-1 rounded inline-flex items-center gap-1
                   border border-stone-300 dark:border-stone-600
                   bg-white dark:bg-stone-800 text-stone-700 dark:text-stone-200
                   transition-colors cursor-pointer enabled:hover:bg-stone-100 dark:enabled:hover:bg-stone-700
                   focus:outline-none focus:ring-2 focus:ring-offset-2 dark:focus:ring-offset-stone-900 focus:ring-blue-500"
      >
        {/* Matches the enlarged queue-button emoji (see note there). */}
        <span aria-hidden="true" className="text-[1.375rem] leading-5">
          ♻️
        </span>
        <ChevronDownIcon className="w-5 h-5" />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={dropdownRef}
            role="menu"
            aria-label="Saved topics"
            className="fixed z-[70] min-w-48 max-w-64 rounded border border-stone-200 dark:border-stone-700
                       bg-white dark:bg-stone-800 shadow-lg py-1"
            style={{ top: pos.top, left: pos.left }}
          >
            {topics.length === 0 ? (
              <p className="px-3 py-1.5 text-xs italic text-stone-500 dark:text-stone-400">No saved topics yet.</p>
            ) : (
              topics.map((r) => {
                // A saved topic can't be used if its priority isn't currently
                // addable (e.g. a Reply with no active topic, or anything but a
                // Point of Order while the queue is closed). Disable it and
                // explain why, so the runtime guard in the parent is only ever
                // hit on a network-delay race.
                const { disabled: itemDisabled, reason } = typeBlock(r.type);
                return (
                  <button
                    key={r.id}
                    type="button"
                    role="menuitem"
                    aria-disabled={itemDisabled}
                    disabled={itemDisabled}
                    title={itemDisabled && reason ? reason : r.text}
                    onClick={() => handleSelect(r)}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-sm text-stone-700 dark:text-stone-200
                               transition-colors
                               ${
                                 itemDisabled
                                   ? 'opacity-50 cursor-not-allowed'
                                   : 'hover:bg-stone-100 dark:hover:bg-stone-700 cursor-pointer'
                               }`}
                  >
                    {/* Leading priority emoji so the type is visible at a glance. */}
                    <span aria-hidden="true" className="shrink-0">
                      {QUEUE_ENTRY_EMOJI[r.type]}
                    </span>
                    <span className="min-w-0 flex-1 text-left whitespace-nowrap overflow-hidden text-ellipsis">
                      {r.text}
                    </span>
                  </button>
                );
              })
            )}
            <div role="separator" className="my-1 border-t border-stone-200 dark:border-stone-700" />
            <button
              type="button"
              role="menuitem"
              onClick={handleEdit}
              className="block w-full text-left px-3 py-1.5 text-sm text-stone-600 dark:text-stone-400
                         hover:bg-stone-100 dark:hover:bg-stone-700 transition-colors cursor-pointer italic"
            >
              Edit saved topics&hellip;
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}
