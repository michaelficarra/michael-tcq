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

export type ReactionType = '❤️' | '👍' | '👀' | '❓' | '🤷' | '😕';

export interface Reaction {
  reaction: ReactionType;
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
  reactions: Reaction[];
  trackTemperature: boolean;

  /**
   * Monotonically increasing version counter. Bumped on every mutation.
   * Used by advancement events (queue:next, meeting:nextAgendaItem) to
   * prevent double-advancement from concurrent chair clicks — the client
   * sends the version it saw, and the server rejects if it's stale.
   */
  version: number;
}
