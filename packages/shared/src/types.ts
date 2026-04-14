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
}
