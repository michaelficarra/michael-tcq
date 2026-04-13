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
 * A single option in a temperature check. Each check can have a
 * custom set of options (minimum 2). The emoji is the visual
 * identifier; the label is the human-readable description.
 */
export interface TemperatureOption {
  id: string;
  emoji: string;
  label: string;
}

/**
 * A user's reaction to a temperature check option.
 * Each user can select at most one of each option (toggle behaviour).
 */
export interface Reaction {
  /** The ID of the TemperatureOption this reaction is for. */
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

  /** Whether a temperature check is currently active. */
  trackTemperature: boolean;

  /**
   * The options for the current temperature check. Set when the check
   * is started; cleared when it's stopped. Each option has an emoji,
   * a label, and a unique ID.
   */
  temperatureOptions: TemperatureOption[];

  /** Reactions to the current temperature check options. */
  reactions: Reaction[];

  /**
   * Monotonically increasing version counter. Bumped on every mutation.
   * Used by advancement events (queue:next, meeting:nextAgendaItem) to
   * prevent double-advancement from concurrent chair clicks — the client
   * sends the version it saw, and the server rejects if it's stale.
   */
  version: number;
}
