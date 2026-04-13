/**
 * Speaker entry controls — the row of buttons for entering the speaker queue.
 *
 * Clicking a button immediately adds the user to the queue with a
 * placeholder topic, then calls onEntryAdded with the new entry's ID
 * so the parent can trigger inline editing.
 *
 * Four entry types are shown as coloured buttons:
 * - New Topic (blue)
 * - Discuss Current Topic / Reply (cyan) — only shown when there's a current topic
 * - Clarifying Question (green)
 * - Point of Order (red)
 */

import type { QueueEntryType } from '@tcq/shared';
import { useMeetingState } from '../contexts/MeetingContext.js';
import { useSocket } from '../contexts/SocketContext.js';

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
  /** Called with the new entry's ID after it's been added to the queue. */
  onEntryAdded: (entryId: string) => void;
}

export function SpeakerControls({ onEntryAdded }: SpeakerControlsProps) {
  const { meeting } = useMeetingState();
  const socket = useSocket();

  if (!meeting) return null;

  /**
   * Immediately add the user to the queue with placeholder text.
   * Listen for the next state broadcast to find the new entry's ID
   * and pass it to the parent so it can trigger inline editing.
   */
  function handleTypeClick(type: QueueEntryType, placeholder: string) {
    if (!socket) return;

    // Capture current entry IDs so we can identify the new one
    const currentIds = new Set(meeting!.queuedSpeakers.map((e) => e.id));
    socket.once('state', (newState) => {
      const newEntry = newState.queuedSpeakers.find((e) => !currentIds.has(e.id));
      if (newEntry) {
        onEntryAdded(newEntry.id);
      }
    });

    socket.emit('queue:add', { type, topic: placeholder });
  }

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
              onClick={() => handleTypeClick(config.type, config.placeholder)}
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
