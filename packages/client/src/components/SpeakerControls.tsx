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
 * A fifth button to the right opens the user's canned responses dropdown
 * (see useCannedResponses). Clicking a canned response immediately adds
 * a finished topic entry to the queue, skipping the pending/initial-edit
 * state.
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { QueueEntryType } from '@tcq/shared';
import { useMeetingState, useIsChair } from '../contexts/MeetingContext.js';
import { ChevronDownIcon } from './icons.js';
import { usePreferences } from '../contexts/PreferencesContext.js';
import { useCannedResponses } from '../hooks/useCannedResponses.js';

/** Configuration for each entry type button. */
const ENTRY_TYPES: {
  type: QueueEntryType;
  label: string;
  /** Tailwind classes for the button background. */
  bgClass: string;
  /** Whether this type requires a current topic to be visible. */
  requiresTopic: boolean;
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
  },
  {
    type: 'point-of-order',
    label: 'Point of Order',
    bgClass: 'bg-rose-700 enabled:hover:bg-rose-800',
    requiresTopic: false,
  },
];

interface SpeakerControlsProps {
  /** Called to add an entry to the queue (in the pending initial-edit state). */
  onAddEntry: (type: QueueEntryType) => void;
  /** Called when the user selects one of their saved canned responses. The
   *  parent emits a finished topic add (no pending state, no auto-edit). */
  onCannedResponse: (text: string) => void;
}

export function SpeakerControls({ onAddEntry, onCannedResponse }: SpeakerControlsProps) {
  const { meeting } = useMeetingState();
  const isChair = useIsChair();

  if (!meeting) return null;

  // The canned-response button mirrors the New Topic gate (closed queue
  // disables both for non-chairs). Compute once and pass through.
  const cannedDisabled = meeting.queue.closed && !isChair;

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
              className={`text-white text-sm font-medium px-3 py-1.5 rounded
                         transition-colors
                         focus:outline-none focus:ring-2 focus:ring-offset-2 dark:focus:ring-offset-stone-900 focus:ring-blue-500
                         ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
                         ${config.bgClass}`}
            >
              {config.label}
            </button>
          );
        })}
        <CannedResponseButton disabled={cannedDisabled} onSelect={onCannedResponse} />
      </div>
    </div>
  );
}

/** The smiley-and-triangle button that opens the canned-responses dropdown.
 *  Lives in the same file so it can sit naturally inside the entry-types
 *  flex row and share the closed-queue gate logic with the other buttons. */
interface CannedResponseButtonProps {
  disabled: boolean;
  onSelect: (text: string) => void;
}

function CannedResponseButton({ disabled, onSelect }: CannedResponseButtonProps) {
  const { responses } = useCannedResponses();
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

  function handleSelect(text: string) {
    setOpen(false);
    onSelect(text);
  }

  function handleEdit() {
    setOpen(false);
    openPreferences('canned');
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={toggleMenu}
        disabled={disabled}
        aria-label="Canned responses"
        aria-haspopup="menu"
        aria-expanded={open}
        // Match the height/padding of the other entry buttons so the row
        // stays visually aligned, but use a neutral background — the
        // button isn't a queue-entry type, it's a meta control.
        className={`text-sm font-medium px-1 py-1 rounded inline-flex items-center gap-1
                    border border-stone-300 dark:border-stone-600
                    bg-white dark:bg-stone-800 text-stone-700 dark:text-stone-200
                    transition-colors
                    focus:outline-none focus:ring-2 focus:ring-offset-2 dark:focus:ring-offset-stone-900 focus:ring-blue-500
                    ${
                      disabled
                        ? 'opacity-50 cursor-not-allowed'
                        : 'cursor-pointer enabled:hover:bg-stone-100 dark:enabled:hover:bg-stone-700'
                    }`}
      >
        <span aria-hidden="true" className="text-xl leading-none">
          📝
        </span>
        <ChevronDownIcon className="w-5 h-5" />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={dropdownRef}
            role="menu"
            aria-label="Canned responses"
            className="fixed z-[70] min-w-48 max-w-64 rounded border border-stone-200 dark:border-stone-700
                       bg-white dark:bg-stone-800 shadow-lg py-1"
            style={{ top: pos.top, left: pos.left }}
          >
            {responses.length === 0 ? (
              <p className="px-3 py-1.5 text-xs italic text-stone-500 dark:text-stone-400">No canned responses yet.</p>
            ) : (
              responses.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  role="menuitem"
                  title={r.text}
                  onClick={() => handleSelect(r.text)}
                  className="block w-full text-left px-3 py-1.5 text-sm text-stone-700 dark:text-stone-200
                             hover:bg-stone-100 dark:hover:bg-stone-700 transition-colors cursor-pointer
                             whitespace-nowrap overflow-hidden text-ellipsis"
                >
                  {r.text}
                </button>
              ))
            )}
            <div role="separator" className="my-1 border-t border-stone-200 dark:border-stone-700" />
            <button
              type="button"
              role="menuitem"
              onClick={handleEdit}
              className="block w-full text-left px-3 py-1.5 text-sm text-stone-600 dark:text-stone-400
                         hover:bg-stone-100 dark:hover:bg-stone-700 transition-colors cursor-pointer italic"
            >
              Edit canned responses&hellip;
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}
