/**
 * Speaker entry controls — the row of buttons for entering the speaker
 * queue, plus the inline form that appears when a button is clicked.
 *
 * Four entry types are shown as coloured buttons:
 * - New Topic (blue)
 * - Discuss Current Topic / Reply (cyan) — only shown when there's a current topic
 * - Clarifying Question (green)
 * - Point of Order (red)
 *
 * Clicking a button opens an inline form with a text input and
 * Enter Queue / Cancel buttons. Submitting emits a `queue:add` event.
 */

import { useState, useRef, useEffect, type FormEvent } from 'react';
import type { QueueEntryType } from '@tcq/shared';
import { useMeetingState } from '../contexts/MeetingContext.js';
import { useSocket } from '../contexts/SocketContext.js';

/** Configuration for each entry type button. */
const ENTRY_TYPES: {
  type: QueueEntryType;
  label: string;
  /** Label shown in the inline form header. */
  formLabel: string;
  /** Tailwind classes for the button background. */
  bgClass: string;
  /** Whether this type requires a current topic to be visible. */
  requiresTopic: boolean;
}[] = [
  {
    type: 'topic',
    label: 'New Topic',
    formLabel: 'New Topic',
    bgClass: 'bg-blue-500 hover:bg-blue-600',
    requiresTopic: false,
  },
  {
    type: 'reply',
    label: 'Discuss Current Topic',
    formLabel: 'Reply to',
    bgClass: 'bg-cyan-500 hover:bg-cyan-600',
    requiresTopic: true,
  },
  {
    type: 'question',
    label: 'Clarifying Question',
    formLabel: 'Clarifying Question',
    bgClass: 'bg-green-500 hover:bg-green-600',
    requiresTopic: false,
  },
  {
    type: 'point-of-order',
    label: 'Point of Order',
    formLabel: 'Point of Order',
    bgClass: 'bg-rose-500 hover:bg-rose-600',
    requiresTopic: false,
  },
];

export function SpeakerControls() {
  const { meeting } = useMeetingState();
  const socket = useSocket();

  // Which entry type's form is currently open, or null if none
  const [activeType, setActiveType] = useState<QueueEntryType | null>(null);
  const [topic, setTopic] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the input when the form opens
  useEffect(() => {
    if (activeType) {
      inputRef.current?.focus();
    }
  }, [activeType]);

  if (!meeting) return null;

  /** Handle clicking one of the entry type buttons. */
  function handleTypeClick(type: QueueEntryType) {
    setActiveType(type);
    setTopic('');
  }

  /** Handle closing the form without submitting. */
  function handleCancel() {
    setActiveType(null);
    setTopic('');
  }

  /** Handle submitting the queue entry form. */
  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!activeType) return;

    const trimmed = topic.trim();
    if (!trimmed) return;

    socket?.emit('queue:add', { type: activeType, topic: trimmed });
    setActiveType(null);
    setTopic('');
  }

  // Look up the active entry type config for the form header
  const activeConfig = ENTRY_TYPES.find((t) => t.type === activeType);

  // Build the form label — for replies, include the current topic name
  const formLabel = activeConfig
    ? activeConfig.type === 'reply' && meeting.currentTopic
      ? `Reply to ${meeting.currentTopic.topic}`
      : activeConfig.formLabel
    : '';

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
              onClick={() => handleTypeClick(config.type)}
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

      {/* Inline form — shown when a button is clicked */}
      {activeType && activeConfig && (
        <form onSubmit={handleSubmit} className="mb-3">
          <label htmlFor="queue-topic" className="block text-sm font-medium text-stone-700 mb-1">
            {formLabel}
          </label>
          <div className="flex gap-2">
            <input
              ref={inputRef}
              id="queue-topic"
              type="text"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="short topic description"
              required
              className="flex-1 border border-stone-300 rounded px-3 py-1.5 text-sm
                         focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
            />
            <button
              type="submit"
              className="bg-teal-500 text-white px-4 py-1.5 rounded text-sm font-medium
                         hover:bg-teal-600 transition-colors cursor-pointer
                         focus:outline-none focus:ring-2 focus:ring-teal-500 focus:ring-offset-2"
            >
              Enter Queue
            </button>
            <button
              type="button"
              onClick={handleCancel}
              className="bg-rose-400 text-white px-4 py-1.5 rounded text-sm font-medium
                         hover:bg-rose-500 transition-colors cursor-pointer
                         focus:outline-none focus:ring-2 focus:ring-rose-400 focus:ring-offset-2"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
