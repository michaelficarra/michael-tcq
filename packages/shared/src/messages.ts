import type { MeetingState } from './types.js';

export interface ServerToClientEvents {
  state: (state: MeetingState) => void;
}

export interface ClientToServerEvents {
  join: (meetingId: string) => void;
}
