/**
 * Poll reactions panel — displays during an active poll.
 *
 * Shows a button for each custom option with its emoji, label, and
 * reaction count. Clicking a button toggles the user's reaction.
 * Hovering shows a tooltip with the names of users who reacted.
 *
 * Chairs also see a "Copy Results" button that copies a summary
 * of the results to the clipboard, sorted by count descending.
 */

import { userKey } from '@tcq/shared';
import { useMeetingState, useIsChair } from '../contexts/MeetingContext.js';
import { useSocket } from '../contexts/SocketContext.js';
import { CountUpTimer } from './CountUpTimer.js';

export function PollReactions() {
  const { meeting, user } = useMeetingState();
  const isChair = useIsChair();
  const socket = useSocket();

  if (!meeting || !meeting.trackPoll || meeting.pollOptions.length === 0) {
    return null;
  }

  /** Toggle a reaction for the current user on the given option. */
  function handleReact(optionId: string) {
    socket?.emit('poll:react', { optionId });
  }

  /**
   * Copy the poll results to the clipboard.
   * Each option is listed on a separate line with its emoji, label,
   * and count, sorted by count descending.
   */
  function handleCopyResults() {
    if (!meeting) return;

    // Build a sorted summary: count reactions per option, sort descending
    const results = meeting.pollOptions.map((option) => {
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
    <div>
      {/* Poll topic and timer */}
      <div className="flex items-center gap-3 mb-4">
        {meeting.pollTopic && (
          <p className="text-stone-800 dark:text-stone-200 font-medium max-w-[50vw]">{meeting.pollTopic}</p>
        )}
        {meeting.pollStartTime && (
          <CountUpTimer since={meeting.pollStartTime} />
        )}
      </div>

      {/* Reaction buttons */}
      <div
        className="flex flex-wrap gap-3 justify-center"
        role="group"
        aria-label="Poll reactions"
      >
        {meeting.pollOptions.map((option) => {
          // Count how many users reacted to this option
          const reactionsForOption = meeting.reactions.filter(
            (r) => r.optionId === option.id,
          );
          const count = reactionsForOption.length;

          // Check if the current user has reacted to this option
          const isSelected = user && reactionsForOption.some(
            (r) => r.userId === userKey(user),
          );

          // Build the tooltip showing who reacted
          const names = reactionsForOption.map((r) => meeting.users[r.userId]?.name ?? r.userId).join(', ');

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
                           ? 'border-teal-400 dark:border-teal-600 bg-teal-50 dark:bg-teal-900/30'
                           : 'border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 hover:bg-stone-50 dark:hover:bg-stone-800'
                         }`}
            >
              {/* Label above the emoji */}
              <span className="text-[10px] font-medium text-stone-500 dark:text-stone-400 mb-0.5 leading-tight">
                {option.label}
              </span>
              {/* Emoji and count */}
              <span className="text-lg leading-none">
                {option.emoji}
              </span>
              <span className="text-xs font-semibold text-stone-600 dark:text-stone-400 mt-0.5">
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Chair actions — Copy Results and Stop Poll */}
      {isChair && (
        <div className="flex gap-2 mt-5 justify-center">
          <button
            onClick={handleCopyResults}
            className="border border-stone-300 dark:border-stone-600 rounded px-3 py-1 text-sm
                       text-stone-700 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800 transition-colors cursor-pointer"
          >
            Copy Results
          </button>
          <button
            onClick={() => socket?.emit('poll:stop')}
            className="bg-red-600 hover:bg-red-700 dark:bg-red-700 dark:hover:bg-red-800 text-white rounded px-3 py-1 text-sm
                       transition-colors cursor-pointer"
          >
            Stop Poll
          </button>
        </div>
      )}
    </div>
  );
}
