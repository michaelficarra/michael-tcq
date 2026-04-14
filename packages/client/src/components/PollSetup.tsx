/**
 * Poll setup form — shown to chairs when they click "Poll".
 * Allows adding, removing, and editing the response options before
 * starting the poll.
 *
 * Each option has an emoji (entered via text input — users can use
 * their OS emoji picker: Cmd+Ctrl+Space on Mac, Win+. on Windows)
 * and a label. Minimum 2 options required.
 *
 * Defaults to the six standard options from the PRD.
 */

import { useState, type FormEvent } from 'react';
import { DEFAULT_POLL_OPTIONS } from '@tcq/shared';
import { useSocket } from '../contexts/SocketContext.js';

/** A draft option being configured before the poll starts. */
interface DraftOption {
  /** Temporary client-side key for React rendering. */
  key: number;
  emoji: string;
  label: string;
}

/** Counter for generating unique keys for draft options. */
let nextKey = 0;

/** Create the default set of draft options from the shared constants. */
function createDefaults(): DraftOption[] {
  return DEFAULT_POLL_OPTIONS.map((opt) => ({
    key: nextKey++,
    emoji: opt.emoji,
    label: opt.label,
  }));
}

interface PollSetupProps {
  onCancel: () => void;
  onStarted: () => void;
}

export function PollSetup({ onCancel, onStarted }: PollSetupProps) {
  const socket = useSocket();
  const [topic, setTopic] = useState('');
  const [multiSelect, setMultiSelect] = useState(true);
  const [options, setOptions] = useState<DraftOption[]>(createDefaults);

  /** Update a single option's field. */
  function updateOption(key: number, field: 'emoji' | 'label', value: string) {
    setOptions((prev) =>
      prev.map((opt) => (opt.key === key ? { ...opt, [field]: value } : opt)),
    );
  }

  /** Remove an option by its key. */
  function removeOption(key: number) {
    setOptions((prev) => prev.filter((opt) => opt.key !== key));
  }

  /** Add a new blank option at the end. */
  function addOption() {
    setOptions((prev) => [...prev, { key: nextKey++, emoji: '', label: '' }]);
  }

  /** Start the poll with the configured options. */
  function handleSubmit(e: FormEvent) {
    e.preventDefault();

    // Filter to valid options (non-empty emoji and label)
    const validOptions = options.filter(
      (opt) => opt.emoji.trim() && opt.label.trim(),
    );

    if (validOptions.length < 2) return;

    socket?.emit('poll:start', {
      topic: topic.trim() || undefined,
      multiSelect,
      options: validOptions.map((opt) => ({
        emoji: opt.emoji.trim(),
        label: opt.label.trim(),
      })),
    });

    onStarted();
  }

  // Count valid options for the minimum-2 check
  const validCount = options.filter(
    (opt) => opt.emoji.trim() && opt.label.trim(),
  ).length;

  return (
    <form onSubmit={handleSubmit} className="p-6">
      <h3 className="text-lg font-semibold text-stone-800 dark:text-stone-200 mb-3">
        Create Poll
      </h3>

      {/* Poll topic (optional) */}
      <input
        type="text"
        value={topic}
        onChange={(e) => setTopic(e.target.value)}
        placeholder="Poll topic (optional)"
        aria-label="Poll topic"
        className="w-full border border-stone-300 dark:border-stone-600 rounded px-2 py-1 text-sm mb-3
                   dark:bg-stone-700 dark:text-stone-100
                   focus:outline-none focus:ring-1 focus:ring-teal-500"
      />

      {/* Selection mode */}
      <label className="flex items-center gap-2 text-sm text-stone-600 dark:text-stone-400 mb-3 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={multiSelect}
          onChange={(e) => setMultiSelect(e.target.checked)}
          className="accent-teal-600"
        />
        Allow selecting multiple options
      </label>

      {/* Option list */}
      <div className="space-y-2 mb-3">
        {options.map((opt) => (
          <div key={opt.key} className="flex items-center gap-2">
            {/* Emoji input — small field for a single emoji */}
            <input
              type="text"
              value={opt.emoji}
              onChange={(e) => updateOption(opt.key, 'emoji', e.target.value)}
              placeholder="😀"
              aria-label="Option emoji"
              className="border border-stone-300 dark:border-stone-600 rounded px-2 py-1 text-center text-lg w-12
                         dark:bg-stone-700 dark:text-stone-100
                         focus:outline-none focus:ring-1 focus:ring-teal-500"
            />

            {/* Label input */}
            <input
              type="text"
              value={opt.label}
              onChange={(e) => updateOption(opt.key, 'label', e.target.value)}
              placeholder="Label"
              aria-label="Option label"
              className="border border-stone-300 dark:border-stone-600 rounded px-2 py-1 text-sm flex-1
                         dark:bg-stone-700 dark:text-stone-100
                         focus:outline-none focus:ring-1 focus:ring-teal-500"
            />

            {/* Remove button — disabled if we'd go below 2 */}
            <button
              type="button"
              onClick={() => removeOption(opt.key)}
              disabled={options.length <= 2}
              className="text-xs text-stone-400 dark:text-stone-500 hover:text-red-600 dark:hover:text-red-400 transition-colors
                         cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
              aria-label="Remove option"
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      {/* Add option button */}
      <button
        type="button"
        onClick={addOption}
        className="text-sm text-blue-600 hover:text-blue-800 transition-colors cursor-pointer mb-3"
      >
        + Add Option
      </button>

      {/* Submit / Cancel */}
      <div className="flex gap-2 border-t border-stone-100 dark:border-stone-700 pt-3">
        <button
          type="submit"
          disabled={validCount < 2}
          className="bg-teal-500 text-white px-4 py-1.5 rounded text-sm font-medium
                     hover:bg-teal-600 transition-colors cursor-pointer
                     disabled:opacity-50 disabled:cursor-not-allowed
                     focus:outline-none focus:ring-2 focus:ring-teal-500 focus:ring-offset-2 dark:focus:ring-offset-stone-900"
        >
          Start Poll
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="text-sm text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-300 transition-colors cursor-pointer"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
