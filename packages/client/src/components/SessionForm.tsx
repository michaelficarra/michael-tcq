/**
 * Form for adding a new session header.
 *
 * Fields: name (required) and capacity in minutes (required, positive
 * integer). Modelled on `AgendaForm` for visual consistency — same
 * border, spacing, and button styling.
 */

import { useState, useRef, useEffect, type FormEvent } from 'react';
import { useSocket } from '../contexts/SocketContext.js';

interface SessionFormProps {
  onCancel: () => void;
  onSubmit: () => void;
}

export function SessionForm({ onCancel, onSubmit }: SessionFormProps) {
  const socket = useSocket();

  const [name, setName] = useState('');
  const [capacity, setCapacity] = useState('');

  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();

    const trimmedName = name.trim();
    const capacityMinutes = parseInt(capacity, 10);
    if (!trimmedName || !(capacityMinutes > 0)) return;

    socket?.emit('session:add', {
      name: trimmedName,
      capacity: capacityMinutes,
    });

    onSubmit();
  }

  return (
    <form onSubmit={handleSubmit} className="border-t border-stone-200 dark:border-stone-700 pt-4">
      <h3 className="text-sm font-semibold text-stone-700 dark:text-stone-300 mb-3">New Session</h3>

      <div className="flex flex-wrap gap-3 items-start">
        {/* Name field */}
        <div className="flex-1 min-w-[200px]">
          <label htmlFor="session-name" className="block text-xs font-medium text-stone-600 dark:text-stone-400 mb-1">
            Session Name
          </label>
          <input
            ref={nameRef}
            id="session-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className="w-full border border-stone-300 dark:border-stone-600 rounded px-3 py-1.5 text-sm
                       dark:bg-stone-700 dark:text-stone-100
                       focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
          />
        </div>

        {/* Capacity field */}
        <div className="w-28">
          <label
            htmlFor="session-capacity"
            className="block text-xs font-medium text-stone-600 dark:text-stone-400 mb-1"
          >
            Capacity
          </label>
          <input
            id="session-capacity"
            type="number"
            min="1"
            max="9999"
            value={capacity}
            onChange={(e) => setCapacity(e.target.value)}
            required
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
