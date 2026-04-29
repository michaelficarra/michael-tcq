/**
 * Form for adding a new agenda item.
 *
 * Fields: name (required), presenter GitHub username(s) — comma-separated,
 * at least one — (required), estimated duration in minutes (optional).
 * Matches the layout from the original screenshots: a horizontal row of
 * labelled inputs with Create/Cancel buttons.
 */

import { useState, useRef, useEffect, type FormEvent } from 'react';
import { normaliseGithubUsername } from '@tcq/shared';
import { useSocket } from '../contexts/SocketContext.js';
import { useMeetingState } from '../contexts/MeetingContext.js';

interface AgendaFormProps {
  onCancel: () => void;
  onSubmit: () => void;
}

export function AgendaForm({ onCancel, onSubmit }: AgendaFormProps) {
  const socket = useSocket();
  const { user } = useMeetingState();

  const [name, setName] = useState('');
  // Default the presenters field to the current user's username
  const [presenters, setPresenters] = useState(user?.ghUsername ?? '');
  const [estimate, setEstimate] = useState('');

  // Focus the name input when the form opens
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();

    const trimmedName = name.trim();
    const presenterUsernames = presenters
      .split(',')
      .map(normaliseGithubUsername)
      .filter((s) => s.length > 0);
    if (!trimmedName || presenterUsernames.length === 0) return;

    // Parse estimate: empty string or non-positive = no estimate
    const estimateMinutes = parseInt(estimate, 10);
    const durationValue = estimateMinutes > 0 ? estimateMinutes : undefined;

    socket?.emit('agenda:add', {
      name: trimmedName,
      presenterUsernames,
      duration: durationValue,
    });

    onSubmit();
  }

  return (
    <form onSubmit={handleSubmit} className="border-t border-stone-200 dark:border-stone-700 pt-4">
      <h3 className="text-sm font-semibold text-stone-700 dark:text-stone-300 mb-3">New Agenda Item</h3>

      <div className="flex flex-wrap gap-3 items-start">
        {/* Name field */}
        <div className="flex-1 min-w-[200px]">
          <label htmlFor="agenda-name" className="block text-xs font-medium text-stone-600 dark:text-stone-400 mb-1">
            Agenda Item Name
          </label>
          <input
            ref={nameRef}
            id="agenda-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className="w-full border border-stone-300 dark:border-stone-600 rounded px-3 py-1.5 text-sm
                       dark:bg-stone-700 dark:text-stone-100
                       focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
          />
        </div>

        {/* Presenters field */}
        <div className="min-w-[200px]">
          <label
            htmlFor="agenda-presenters"
            className="block text-xs font-medium text-stone-600 dark:text-stone-400 mb-1"
          >
            Presenters
          </label>
          <input
            id="agenda-presenters"
            type="text"
            value={presenters}
            onChange={(e) => setPresenters(e.target.value)}
            required
            className="w-full border border-stone-300 dark:border-stone-600 rounded px-3 py-1.5 text-sm
                       dark:bg-stone-700 dark:text-stone-100
                       focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
          />
          <p className="text-xs text-stone-400 dark:text-stone-500 mt-0.5">GitHub username(s), comma-separated</p>
        </div>

        {/* Estimate field */}
        <div className="w-24">
          <label
            htmlFor="agenda-estimate"
            className="block text-xs font-medium text-stone-600 dark:text-stone-400 mb-1"
          >
            Estimate
          </label>
          <input
            id="agenda-estimate"
            type="number"
            min="0"
            max="999"
            value={estimate}
            onChange={(e) => setEstimate(e.target.value)}
            placeholder=""
            className="w-full border border-stone-300 dark:border-stone-600 rounded px-3 py-1.5 text-sm
                       dark:bg-stone-700 dark:text-stone-100
                       focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
          />
          <p className="text-xs text-stone-400 dark:text-stone-500 mt-0.5">Minutes</p>
        </div>

        {/* Buttons — vertically centred relative to the input row */}
        <div className="flex gap-2 self-center">
          <button
            type="submit"
            className="bg-teal-500 text-white px-4 py-1.5 rounded text-sm font-medium
                       hover:bg-teal-600 transition-colors cursor-pointer
                       focus:outline-none focus:ring-2 focus:ring-teal-500 focus:ring-offset-2 dark:focus:ring-offset-stone-900"
          >
            Create
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="bg-rose-400 text-white px-4 py-1.5 rounded text-sm font-medium
                       hover:bg-rose-500 transition-colors cursor-pointer
                       focus:outline-none focus:ring-2 focus:ring-rose-400 focus:ring-offset-2 dark:focus:ring-offset-stone-900"
          >
            Cancel
          </button>
        </div>
      </div>
    </form>
  );
}
