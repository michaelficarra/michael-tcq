/**
 * Form for adding a new agenda item.
 *
 * Fields: name (required), owner GitHub username (required), timebox in
 * minutes (optional). Matches the layout from the original screenshots:
 * a horizontal row of labelled inputs with Create/Cancel buttons.
 */

import { useState, useRef, useEffect, type FormEvent } from 'react';
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
  // Default the owner field to the current user's username
  const [ownerUsername, setOwnerUsername] = useState(user?.ghUsername ?? '');
  const [timebox, setTimebox] = useState('');

  // Focus the name input when the form opens
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();

    const trimmedName = name.trim();
    const trimmedOwner = ownerUsername.trim();
    if (!trimmedName || !trimmedOwner) return;

    // Parse timebox: empty string or non-positive = no timebox
    const timeboxMinutes = parseInt(timebox, 10);
    const timeboxValue = timeboxMinutes > 0 ? timeboxMinutes : undefined;

    socket?.emit('agenda:add', {
      name: trimmedName,
      ownerUsername: trimmedOwner,
      timebox: timeboxValue,
    });

    onSubmit();
  }

  return (
    <form onSubmit={handleSubmit} className="border-t border-stone-200 pt-4">
      <h3 className="text-sm font-semibold text-stone-700 mb-3">New Agenda Item</h3>

      <div className="flex flex-wrap gap-3 items-start">
        {/* Name field */}
        <div className="flex-1 min-w-[200px]">
          <label htmlFor="agenda-name" className="block text-xs font-medium text-stone-600 mb-1">
            Agenda Item Name
          </label>
          <input
            ref={nameRef}
            id="agenda-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className="w-full border border-stone-300 rounded px-3 py-1.5 text-sm
                       focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
          />
        </div>

        {/* Owner field */}
        <div className="min-w-[160px]">
          <label htmlFor="agenda-owner" className="block text-xs font-medium text-stone-600 mb-1">
            Owner
          </label>
          <input
            id="agenda-owner"
            type="text"
            value={ownerUsername}
            onChange={(e) => setOwnerUsername(e.target.value)}
            required
            className="w-full border border-stone-300 rounded px-3 py-1.5 text-sm
                       focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
          />
          <p className="text-xs text-stone-400 mt-0.5">GitHub username (omit the @)</p>
        </div>

        {/* Timebox field */}
        <div className="w-24">
          <label htmlFor="agenda-timebox" className="block text-xs font-medium text-stone-600 mb-1">
            Timebox
          </label>
          <input
            id="agenda-timebox"
            type="number"
            min="0"
            max="999"
            value={timebox}
            onChange={(e) => setTimebox(e.target.value)}
            placeholder=""
            className="w-full border border-stone-300 rounded px-3 py-1.5 text-sm
                       focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
          />
          <p className="text-xs text-stone-400 mt-0.5">Minutes</p>
        </div>

        {/* Buttons — vertically centred relative to the input row */}
        <div className="flex gap-2 self-center">
          <button
            type="submit"
            className="bg-teal-500 text-white px-4 py-1.5 rounded text-sm font-medium
                       hover:bg-teal-600 transition-colors
                       focus:outline-none focus:ring-2 focus:ring-teal-500 focus:ring-offset-2"
          >
            Create
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="bg-rose-400 text-white px-4 py-1.5 rounded text-sm font-medium
                       hover:bg-rose-500 transition-colors
                       focus:outline-none focus:ring-2 focus:ring-rose-400 focus:ring-offset-2"
          >
            Cancel
          </button>
        </div>
      </div>
    </form>
  );
}
