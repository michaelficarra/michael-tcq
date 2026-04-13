/**
 * Temperature check panel — displays during an active temperature check.
 *
 * Shows a row of six reaction buttons with emoji, label, and count.
 * Clicking a reaction toggles it (adds if not present, removes if
 * already selected). Hovering shows a tooltip with the names of
 * users who reacted.
 *
 * The six reaction types (from the PRD):
 *   ❤️ Strong Positive
 *   👍 Positive
 *   👀 Following
 *   ❓ Confused
 *   🤷 Indifferent
 *   😕 Unconvinced
 */

import { REACTION_TYPES } from '@tcq/shared';
import type { ReactionType } from '@tcq/shared';
import { useMeetingState } from '../contexts/MeetingContext.js';
import { useSocket } from '../contexts/SocketContext.js';

/** Human-readable label for each reaction type. */
const REACTION_LABELS: Record<ReactionType, string> = {
  '❤️': 'Strong Positive',
  '👍': 'Positive',
  '👀': 'Following',
  '❓': 'Confused',
  '🤷': 'Indifferent',
  '😕': 'Unconvinced',
};

export function TemperatureCheck() {
  const { meeting, user } = useMeetingState();
  const socket = useSocket();

  if (!meeting || !meeting.trackTemperature) return null;

  /** Toggle a reaction for the current user. */
  function handleReact(reaction: ReactionType) {
    socket?.emit('temperature:react', { reaction });
  }

  return (
    <div
      className="flex flex-wrap gap-3 mt-3"
      role="group"
      aria-label="Temperature check reactions"
    >
      {REACTION_TYPES.map((reactionType) => {
        // Count how many users have this reaction
        const reactionsOfType = meeting.reactions.filter(
          (r) => r.reaction === reactionType,
        );
        const count = reactionsOfType.length;

        // Check if the current user has this reaction (for visual highlighting)
        const isSelected = user && reactionsOfType.some(
          (r) => r.user.ghUsername.toLowerCase() === user.ghUsername.toLowerCase(),
        );

        // Build the tooltip showing who reacted
        const names = reactionsOfType.map((r) => r.user.name).join(', ');

        return (
          <button
            key={reactionType}
            onClick={() => handleReact(reactionType)}
            title={names || REACTION_LABELS[reactionType]}
            aria-label={`${REACTION_LABELS[reactionType]}: ${count}`}
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
              {REACTION_LABELS[reactionType]}
            </span>
            {/* Emoji and count */}
            <span className="text-lg leading-none">
              {reactionType}
            </span>
            <span className="text-xs font-semibold text-stone-600 mt-0.5">
              {count}
            </span>
          </button>
        );
      })}
    </div>
  );
}
