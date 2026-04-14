export interface User {
  ghid: number;
  ghUsername: string;
  name: string;
  organisation: string;
}

export interface AgendaItem {
  id: string;
  name: string;
  owner: User;
  timebox?: number; // duration in minutes
}

export type QueueEntryType = 'point-of-order' | 'question' | 'reply' | 'topic';

export interface QueueEntry {
  id: string;
  type: QueueEntryType;
  topic: string;
  user: User;
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
  user: User;
}

// -- Log entry types --

/** A speaker turn within a topic group. */
export interface TopicSpeaker {
  user: User;
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
  chair: User;
}

export interface AgendaItemStartedLog extends LogEntryBase {
  type: 'agenda-item-started';
  chair: User;
  itemName: string;
  itemOwner: User;
}

export interface AgendaItemFinishedLog extends LogEntryBase {
  type: 'agenda-item-finished';
  chair: User;
  itemName: string;
  /** Duration in ms from when the item started to when it was advanced. */
  duration: number;
  /** Distinct users who spoke during this item (excluding Point of Order speakers). */
  participants: User[];
  /**
   * Text serialisation of the remaining queue entries at the time the
   * agenda item was advanced, if the queue was non-empty.
   * Format: "Type: topic (username)" per line.
   */
  remainingQueue?: string;
}

export interface TopicDiscussedLog extends LogEntryBase {
  type: 'topic-discussed';
  chair: User;
  topicName: string;
  speakers: TopicSpeaker[];
  /** Duration in ms from the first speaker to when the topic was finalised. */
  duration: number;
}

export interface PollRanLog extends LogEntryBase {
  type: 'poll-ran';
  startChair: User;
  endChair: User;
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

export interface MeetingState {
  id: string;
  chairs: User[];
  agenda: AgendaItem[];
  currentAgendaItem?: AgendaItem;
  currentSpeaker?: QueueEntry;
  currentTopic?: QueueEntry;
  queuedSpeakers: QueueEntry[];

  /** Whether a poll is currently active. */
  trackPoll: boolean;

  /**
   * The options for the current poll. Set when the poll is started;
   * cleared when it's stopped. Each option has an emoji, a label,
   * and a unique ID.
   */
  pollOptions: PollOption[];

  /** Reactions to the current poll options. */
  reactions: Reaction[];

  /**
   * Monotonically increasing version counter. Bumped on every mutation.
   * Used by advancement events (queue:next, meeting:nextAgendaItem) to
   * prevent double-advancement from concurrent chair clicks — the client
   * sends the version it saw, and the server rejects if it's stale.
   */
  version: number;

  /**
   * ISO timestamp of the most recent client connection to this meeting.
   * Used to determine when to expire stale meetings (90 days after
   * the last connection).
   */
  lastConnectionTime?: string;

  /** Append-only log of meeting events, displayed in the Logs tab. */
  log: LogEntry[];

  /**
   * Speakers in the current (not yet finalised) topic group.
   * Accumulated as speakers are advanced; finalised into a
   * TopicDiscussedLog entry when a new topic starts or the
   * agenda item changes.
   */
  currentTopicSpeakers: TopicSpeaker[];

  /** ISO timestamp when the current agenda item started. Used to compute duration on finish. */
  currentAgendaItemStartTime?: string;

  /** ISO timestamp when the current poll was started. */
  pollStartTime?: string;

  /** The chair who started the current poll. */
  pollStartChair?: User;
}
