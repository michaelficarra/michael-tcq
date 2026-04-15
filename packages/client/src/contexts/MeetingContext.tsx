/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useReducer, type Dispatch, type ReactNode } from 'react';
import type { MeetingState, User } from '@tcq/shared';
import { userKey } from '@tcq/shared';

// -- State --

export interface MeetingContextState {
  /** The full meeting state received from the server, or null if not yet loaded. */
  meeting: MeetingState | null;

  /** The currently authenticated user (from mock auth or GitHub OAuth). */
  user: User | null;

  /** Whether the socket is connected to the server. */
  connected: boolean;

  /** Error message from the server (e.g. "Meeting not found"). */
  error: string | null;
}

const initialState: MeetingContextState = {
  meeting: null,
  user: null,
  connected: false,
  error: null,
};

// -- Actions --

export type MeetingAction =
  | { type: 'state'; meeting: MeetingState }
  | { type: 'setUser'; user: User }
  | { type: 'setConnected'; connected: boolean }
  | { type: 'setError'; error: string }
  | { type: 'optimisticAgendaReorder'; oldIndex: number; newIndex: number }
  | { type: 'optimisticQueueReorder'; oldIndex: number; newIndex: number };

function meetingReducer(state: MeetingContextState, action: MeetingAction): MeetingContextState {
  switch (action.type) {
    case 'state':
      // Full state replacement from the server — clears any previous error
      return { ...state, meeting: action.meeting, error: null };
    case 'setUser':
      return { ...state, user: action.user };
    case 'setConnected':
      return { ...state, connected: action.connected };
    case 'setError':
      return { ...state, error: action.error };
    case 'optimisticAgendaReorder': {
      if (!state.meeting) return state;
      const agenda = [...state.meeting.agenda];
      const [item] = agenda.splice(action.oldIndex, 1);
      agenda.splice(action.newIndex, 0, item);
      return { ...state, meeting: { ...state.meeting, agenda } };
    }
    case 'optimisticQueueReorder': {
      if (!state.meeting) return state;
      const queuedSpeakerIds = [...state.meeting.queuedSpeakerIds];
      const [id] = queuedSpeakerIds.splice(action.oldIndex, 1);
      queuedSpeakerIds.splice(action.newIndex, 0, id);
      return { ...state, meeting: { ...state.meeting, queuedSpeakerIds } };
    }
  }
}

// -- Context --

// Exported so that TestMeetingProvider can inject state directly.
export const MeetingStateContext = createContext<MeetingContextState>(initialState);
export const MeetingDispatchContext = createContext<Dispatch<MeetingAction>>(() => {});

/** Read the current meeting state from context. */
export function useMeetingState(): MeetingContextState {
  return useContext(MeetingStateContext);
}

/** Get the dispatch function for meeting actions. */
export function useMeetingDispatch(): Dispatch<MeetingAction> {
  return useContext(MeetingDispatchContext);
}

/**
 * Check whether the current user is a chair for the current meeting.
 * Returns false if either user or meeting is not yet loaded.
 */
export function useIsChair(): boolean {
  const { meeting, user } = useMeetingState();
  if (!meeting || !user) return false;
  // Compare by username (case-insensitive) since chairs are specified
  // by GitHub username, and it's the stable identifier throughout the app.
  return meeting.chairIds.includes(userKey(user));
}

/** Provider component that wraps the meeting page. */
export function MeetingProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(meetingReducer, initialState);

  return (
    <MeetingStateContext.Provider value={state}>
      <MeetingDispatchContext.Provider value={dispatch}>
        {children}
      </MeetingDispatchContext.Provider>
    </MeetingStateContext.Provider>
  );
}
