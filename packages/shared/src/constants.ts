import type { QueueEntryType, ReactionType } from './types.js';

/** Queue entry types in priority order (highest first). */
export const QUEUE_ENTRY_TYPES: readonly QueueEntryType[] = [
  'point-of-order',
  'question',
  'reply',
  'topic',
] as const;

/** Maps each queue entry type to its numeric priority (lower number = higher priority). */
export const QUEUE_ENTRY_PRIORITY: Record<QueueEntryType, number> = {
  'point-of-order': 0,
  question: 1,
  reply: 2,
  topic: 3,
};

export const REACTION_TYPES: readonly ReactionType[] = [
  '❤️',
  '👍',
  '👀',
  '❓',
  '🤷',
  '😕',
] as const;
