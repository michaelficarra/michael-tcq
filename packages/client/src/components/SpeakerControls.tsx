/**
 * Speaker entry controls — the row of buttons for entering the speaker queue.
 *
 * Clicking a button calls onAddEntry with the type and placeholder text.
 * The parent handles emitting the socket event and triggering auto-edit.
 *
 * Four entry types are shown as coloured buttons:
 * - New Topic (blue)
 * - Discuss Current Topic / Reply (cyan) — only shown when there's a current topic
 * - Clarifying Question (green)
 * - Point of Order (red)
 */

import type { QueueEntryType } from '@tcq/shared';
import { useMeetingState } from '../contexts/MeetingContext.js';

/** Configuration for each entry type button. */
const ENTRY_TYPES: {
  type: QueueEntryType;
  label: string;
  /** Placeholder topic text used when immediately entering the queue. */
  placeholder: string;
  /** Tailwind classes for the button background. */
  bgClass: string;
  /** Whether this type requires a current topic to be visible. */
  requiresTopic: boolean;
}[] = [
  {
    type: 'topic',
    label: 'New Topic',
    placeholder: 'New topic',
    bgClass: 'bg-blue-500 hover:bg-blue-600',
    requiresTopic: false,
  },
  {
    type: 'reply',
    label: 'Discuss Current Topic',
    placeholder: 'Reply',
    bgClass: 'bg-cyan-500 hover:bg-cyan-600',
    requiresTopic: true,
  },
  {
    type: 'question',
    label: 'Clarifying Question',
    placeholder: 'Clarifying question',
    bgClass: 'bg-green-500 hover:bg-green-600',
    requiresTopic: false,
  },
  {
    type: 'point-of-order',
    label: 'Point of Order',
    placeholder: 'Point of order',
    bgClass: 'bg-rose-500 hover:bg-rose-600',
    requiresTopic: false,
  },
];

interface SpeakerControlsProps {
  /** Called to add an entry to the queue with a placeholder topic. */
  onAddEntry: (type: QueueEntryType, placeholder: string) => void;
}

export function SpeakerControls({ onAddEntry }: SpeakerControlsProps) {
  const { meeting } = useMeetingState();

  if (!meeting) return null;

  return (
    <div>
      {/* Entry type buttons */}
      <div className="flex flex-wrap gap-2 mb-3" role="group" aria-label="Queue entry types">
        {ENTRY_TYPES.map((config) => {
          // Hide the Reply button when there's no current topic
          if (config.requiresTopic && !meeting.currentTopic) return null;

          return (
            <button
              key={config.type}
              onClick={() => onAddEntry(config.type, config.placeholder)}
              className={`text-white text-sm font-medium px-3 py-1.5 rounded
                         transition-colors cursor-pointer
                         focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500
                         ${config.bgClass}`}
            >
              {config.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
