import type { QueueEntryType, PollOption } from './types.js';
import { QueueEntryTypeSchema } from './types.js';

/**
 * Queue entry types in priority order (highest first). Derived from
 * `QueueEntryTypeSchema.options` so the list can't drift from the schema.
 */
export const QUEUE_ENTRY_TYPES = QueueEntryTypeSchema.options;

/** Human-readable labels for each queue entry type. */
export const QUEUE_ENTRY_LABELS: Record<QueueEntryType, string> = {
  'point-of-order': 'Point of Order',
  question: 'Clarifying Question',
  reply: 'Reply',
  topic: 'New Topic',
};

/** Maps each queue entry type to its numeric priority (lower number = higher priority). */
export const QUEUE_ENTRY_PRIORITY: Record<QueueEntryType, number> = {
  'point-of-order': 0,
  question: 1,
  reply: 2,
  topic: 3,
};

/**
 * Default topic text for each queue entry type. Stamped by the server as
 * the initial topic on an interactive (pending) add — the entry needs a
 * well-formed topic string even though the value isn't shown while the
 * `pending` flag is true (clients render a typing-indicator instead).
 * The author's Save replaces this; Escape/Cancel removes the entry
 * entirely, so the default is never user-visible in the normal flow. It
 * remains as a defensive fallback in case a pending row leaks past the
 * usual paths.
 */
export const QUEUE_ENTRY_DEFAULT_TOPICS: Record<QueueEntryType, string> = {
  'point-of-order': 'Point of order',
  question: 'Clarifying question',
  reply: 'Reply',
  topic: 'New topic',
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
