import type { QueueEntryType, PollOption } from './types.js';

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

/**
 * Default poll options. Used when the chair starts a poll without
 * customising the options. The IDs are stable strings so they can
 * be referenced in tests and defaults.
 */
export const DEFAULT_POLL_OPTIONS: readonly PollOption[] = [
  { id: 'strong-positive', emoji: '❤️', label: 'Strong Positive' },
  { id: 'positive', emoji: '👍', label: 'Positive' },
  { id: 'following', emoji: '👀', label: 'Following' },
  { id: 'confused', emoji: '❓', label: 'Confused' },
  { id: 'indifferent', emoji: '🤷', label: 'Indifferent' },
  { id: 'unconvinced', emoji: '😕', label: 'Unconvinced' },
] as const;
