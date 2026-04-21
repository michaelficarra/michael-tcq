import { z } from 'zod';

export interface User {
  ghid: number;
  ghUsername: string;
  name: string;
  organisation: string;
}

export interface AgendaItem {
  id: string;
  name: string;
  ownerId: string; // user key (lowercase ghUsername)
  timebox?: number; // duration in minutes
}

/**
 * Source of truth for the set of queue entry types. The `QueueEntryType`
 * alias is derived via `z.infer` and the `QUEUE_ENTRY_TYPES` constant in
 * `./constants.ts` is derived via `.options` — single definition, no drift.
 */
export const QueueEntryTypeSchema = z.enum(['point-of-order', 'question', 'reply', 'topic']);
export type QueueEntryType = z.infer<typeof QueueEntryTypeSchema>;

export interface QueueEntry {
  id: string;
  type: QueueEntryType;
  topic: string;
  userId: string; // user key
}

/**
 * A single option in a poll. Each poll can have a custom set of
 * options (minimum 2). The emoji is the visual identifier; the
 * label is the human-readable description.
 */
export interface PollOption {
  id: string;
  emoji: string;
  label: string;
}

/**
 * A user's reaction to a poll option.
 * Each user can select at most one of each option (toggle behaviour).
 */
export interface Reaction {
  /** The ID of the PollOption this reaction is for. */
  optionId: string;
  userId: string; // user key
}

// -- Log entry types --

/** A speaker turn within a topic group. */
export interface TopicSpeaker {
  userId: string; // user key
  type: QueueEntryType;
  topic: string;
  /** ISO timestamp when this speaker started. */
  startTime: string;
  /** Duration in ms, set when the next speaker is advanced. Absent for the current speaker. */
  duration?: number;
}

interface LogEntryBase {
  /** ISO timestamp when this event occurred. */
  timestamp: string;
}

export interface MeetingStartedLog extends LogEntryBase {
  type: 'meeting-started';
  chairId: string;
}

export interface AgendaItemStartedLog extends LogEntryBase {
  type: 'agenda-item-started';
  chairId: string;
  itemName: string;
  itemOwnerId: string;
}

export interface AgendaItemFinishedLog extends LogEntryBase {
  type: 'agenda-item-finished';
  chairId: string;
  itemName: string;
  /** Duration in ms from when the item started to when it was advanced. */
  duration: number;
  /** Distinct users who spoke during this item (excluding Point of Order speakers). */
  participantIds: string[];
  /**
   * Text serialisation of the remaining queue entries at the time the
   * agenda item was advanced, if the queue was non-empty.
   * Format: "Type: topic (username)" per line.
   */
  remainingQueue?: string;
}

export interface TopicDiscussedLog extends LogEntryBase {
  type: 'topic-discussed';
  chairId: string;
  topicName: string;
  speakers: TopicSpeaker[];
  /** Duration in ms from the first speaker to when the topic was finalised. */
  duration: number;
}

export interface PollRanLog extends LogEntryBase {
  type: 'poll-ran';
  startChairId: string;
  endChairId: string;
  /** The poll topic/question, if one was provided. */
  topic?: string;
  /** Duration in ms from poll start to poll stop. */
  duration: number;
  /** Number of distinct users who voted. */
  totalVoters: number;
  /** Results: each option's label, emoji, and count, sorted by count descending. */
  results: { emoji: string; label: string; count: number }[];
}

export type LogEntry =
  | MeetingStartedLog
  | AgendaItemStartedLog
  | AgendaItemFinishedLog
  | TopicDiscussedLog
  | PollRanLog;

/**
 * The active poll for a meeting. Present when a poll is running;
 * absent when no poll is active.
 */
export interface ActivePoll {
  /** The options for the poll. Each has an emoji, a label, and a unique ID. */
  options: PollOption[];
  /** Reactions to the poll options. */
  reactions: Reaction[];
  /** ISO timestamp when the poll was started. */
  startTime: string;
  /** The user key of the chair who started the poll. */
  startChairId: string;
  /** The topic/question for the poll, if one was provided. */
  topic?: string;
  /** Whether the poll allows selecting multiple options. */
  multiSelect: boolean;
}

/**
 * The current speaker holding the floor. Generated when an agenda item
 * starts (source 'agenda') or when a queue entry is advanced (source
 * 'queue'). For agenda-sourced speakers, no queue entry backs this —
 * the struct is the sole representation of the speaker turn.
 */
export interface CurrentSpeaker {
  /** Unique ID for this speaker turn. Used for advancement preconditions. */
  id: string;
  /** User key of the speaker. */
  userId: string;
  /** Entry type describing the speaker turn. Agenda-sourced turns are always 'topic'. */
  type: QueueEntryType;
  /** The topic / message for this speaker turn. */
  topic: string;
  /** Origin of this speaker turn. */
  source: 'agenda' | 'queue';
  /** ISO timestamp when this speaker took the floor. */
  startTime: string;
}

/**
 * The current topic under discussion. Set when a 'topic'-type speaker is
 * advanced; cleared when the agenda item changes. Independent of the
 * current speaker: clarifying questions / replies / points of order
 * don't change the topic.
 */
export interface CurrentTopic {
  /**
   * Turn id of the speaker who introduced this topic. Equal to the
   * `CurrentSpeaker.id` active at the moment the topic was set — the UI
   * uses this to decide whether the current speaker is still the topic
   * introducer (don't show the topic section separately) or a later
   * question/reply/point-of-order (do show it).
   */
  speakerId: string;
  /** User key of the topic owner (whoever introduced the topic). */
  userId: string;
  /** The topic name. */
  topic: string;
  /** ISO timestamp when this topic was introduced. */
  startTime: string;
}

/** Queue state for the current agenda item. */
export interface MeetingQueueState {
  /** All queue entries for the current agenda item, keyed by entry ID. */
  entries: Record<string, QueueEntry>;
  /** Ordered list of queue entry IDs for speakers waiting to speak. */
  orderedIds: string[];
  /** Whether the queue is closed to new entries from non-chair users. */
  closed: boolean;
}

/**
 * Current context for the in-progress agenda item. Present fields depend
 * on progress: none of them are set before the meeting starts; agendaItemId
 * is set once the first agenda item is advanced to; speaker is set while
 * someone holds the floor; topic is set once a 'topic'-type turn has run.
 */
export interface CurrentContext {
  /** ID of the current agenda item, if the meeting is in progress. */
  agendaItemId?: string;
  /** ISO timestamp when the current agenda item started. */
  agendaItemStartTime?: string;
  /** Who is currently holding the floor, if anyone. */
  speaker?: CurrentSpeaker;
  /** What topic is being discussed, if any. */
  topic?: CurrentTopic;
  /**
   * Speakers in the current (not-yet-finalised) topic group. Accumulated
   * as speakers are advanced; finalised into a TopicDiscussedLog entry
   * when a new topic starts or the agenda item changes.
   */
  topicSpeakers: TopicSpeaker[];
}

/**
 * Operational / ephemeral plumbing that isn't part of the user-facing
 * domain: used by the server for lifecycle and by the client for
 * advancement-cooldown heuristics.
 */
export interface OperationalState {
  /**
   * User key of the chair who triggered the most recent speaker or agenda
   * advancement. Clients use this to distinguish self-initiated advances
   * (no cooldown) from those triggered by another chair (cooldown applied).
   */
  lastAdvancementBy?: string;
  /**
   * ISO timestamp of the most recent client connection. Used to determine
   * when to expire stale meetings (90 days after the last connection).
   */
  lastConnectionTime?: string;
}

export interface MeetingState {
  id: string;
  /** Lookup map of all users who have participated in this meeting, keyed by lowercase ghUsername. */
  users: Record<string, User>;
  chairIds: string[];
  agenda: AgendaItem[];
  /** Queue state: entries, ordering, and the closed flag. */
  queue: MeetingQueueState;
  /** Current-agenda-item context: speaker, topic, and timing. */
  current: CurrentContext;
  /** The active poll, if one is running. */
  poll?: ActivePoll;
  /** Operational plumbing (advancement attribution, last-connection tracking). */
  operational: OperationalState;
  /** Append-only log of meeting events, displayed in the Logs tab. */
  log: LogEntry[];
}
