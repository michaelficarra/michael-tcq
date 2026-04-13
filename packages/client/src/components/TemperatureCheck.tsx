/**
 * Temperature check panel — displays during an active temperature check.
 *
 * Shows a button for each custom option with its emoji, label, and
 * reaction count. Clicking a button toggles the user's reaction.
 * Hovering shows a tooltip with the names of users who reacted.
 *
 * Chairs also see a "Copy Results" button that copies a summary
 * of the results to the clipboard, sorted by count descending.
 */

import { useMeetingState, useIsChair } from '../contexts/MeetingContext.js';
import { useSocket } from '../contexts/SocketContext.js';

export function TemperatureCheck() {
  const { meeting, user } = useMeetingState();
  const isChair = useIsChair();
  const socket = useSocket();

  if (!meeting || !meeting.trackTemperature || meeting.temperatureOptions.length === 0) {
    return null;
  }

  /** Toggle a reaction for the current user on the given option. */
  function handleReact(optionId: string) {
    socket?.emit('temperature:react', { optionId });
  }

  /**
   * Copy the temperature check results to the clipboard.
   * Each option is listed on a separate line with its emoji, label,
   * and count, sorted by count descending.
   */
  function handleCopyResults() {
    if (!meeting) return;

    // Build a sorted summary: count reactions per option, sort descending
    const results = meeting.temperatureOptions.map((option) => {
      const count = meeting.reactions.filter((r) => r.optionId === option.id).length;
      return { emoji: option.emoji, label: option.label, count };
    }).sort((a, b) => b.count - a.count);

    const text = results
      .map((r) => `${r.emoji} ${r.label}: ${r.count}`)
      .join('\n');

    navigator.clipboard.writeText(text).catch(() => {
      // Silently fail if clipboard access is denied
    });
  }

  return (
    <div className="mt-3">
      {/* Reaction buttons */}
      <div
        className="flex flex-wrap gap-3"
        role="group"
        aria-label="Temperature check reactions"
      >
        {meeting.temperatureOptions.map((option) => {
          // Count how many users reacted to this option
          const reactionsForOption = meeting.reactions.filter(
            (r) => r.optionId === option.id,
          );
          const count = reactionsForOption.length;

          // Check if the current user has reacted to this option
          const isSelected = user && reactionsForOption.some(
            (r) => r.user.ghUsername.toLowerCase() === user.ghUsername.toLowerCase(),
          );

          // Build the tooltip showing who reacted
          const names = reactionsForOption.map((r) => r.user.name).join(', ');

          return (
            <button
              key={option.id}
              onClick={() => handleReact(option.id)}
              title={names || option.label}
              aria-label={`${option.label}: ${count}`}
              aria-pressed={!!isSelected}
              className={`flex flex-col items-center px-3 py-2 rounded-lg border
                         transition-colors cursor-pointer min-w-[5rem]
                         ${isSelected
                           ? 'border-teal-400 bg-teal-50'
                           : 'border-stone-200 bg-white hover:bg-stone-50'
                         }`}
            >
              {/* Label above the emoji */}
              <span className="text-[10px] font-medium text-stone-500 mb-0.5 leading-tight">
                {option.label}
              </span>
              {/* Emoji and count */}
              <span className="text-lg leading-none">
                {option.emoji}
              </span>
              <span className="text-xs font-semibold text-stone-600 mt-0.5">
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Copy Results button — chairs only */}
      {isChair && (
        <button
          onClick={handleCopyResults}
          className="mt-3 border border-stone-300 rounded px-3 py-1 text-sm
                     text-stone-700 hover:bg-stone-100 transition-colors cursor-pointer presentation-hidden"
        >
          Copy Results
        </button>
      )}
    </div>
  );
}
