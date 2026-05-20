/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useReducer, type Dispatch, type ReactNode } from 'react';
import type { MeetingDeltaAction, MeetingState, User } from '@tcq/shared';
import { applyDelta, userKey } from '@tcq/shared';

// -- State --

export interface MeetingContextState {
  /** The full meeting state received from the server, or null if not yet loaded. */
  meeting: MeetingState | null;

  /** The currently authenticated user (from mock auth or GitHub OAuth). */
  user: User | null;

  /** Whether the socket is connected to the server. */
  connected: boolean;

  /**
   * Current number of socket connections in the meeting room, as reported
   * by the server. Tabs from the same user count separately. 0 before the
   * first `activeConnections` event arrives.
   */
  activeConnections: number;

  /** Error message from the server (e.g. "Meeting not found"). */
  error: string | null;

  /**
   * Highest `operational.version` we've successfully applied. Set from
   * the bootstrap `state` event and incremented as delta events arrive.
   * `null` before any state has loaded. Used by the socket listener to
   * detect a missed delta — if an arriving delta's version isn't exactly
   * `lastSeenVersion + 1`, the listener requests a `state:resync` and
   * drops the delta.
   */
  lastSeenVersion: number | null;

  /**
   * Cloud Run revision (`K_REVISION`) of the server process this socket
   * is bound to. Reported by the server via `server:revision` once per
   * socket, and used as the authoritative baseline for the staleness
   * check that polls `/api/version`. `null` before the event arrives or
   * when the server isn't running on Cloud Run (local dev, tests).
   */
  serverRevision: string | null;
}

const initialState: MeetingContextState = {
  meeting: null,
  user: null,
  connected: false,
  activeConnections: 0,
  error: null,
  lastSeenVersion: null,
  serverRevision: null,
};

// -- Actions --

export type MeetingAction =
  | { type: 'state'; meeting: MeetingState }
  | { type: 'setUser'; user: User }
  | { type: 'setConnected'; connected: boolean }
  | { type: 'setActiveConnections'; count: number }
  | { type: 'setError'; error: string }
  | { type: 'setServerRevision'; revision: string | null }
  | { type: 'optimisticAgendaReorder'; oldIndex: number; newIndex: number }
  | { type: 'optimisticQueueReorder'; oldIndex: number; newIndex: number }
  // Versioned delta actions — one per `ServerToClientEvents` delta event.
  // Defined in `@tcq/shared` so the same union backs both the React
  // reducer and the integration-test surrogate that verifies client and
  // server stay byte-identical after every mutation.
  | MeetingDeltaAction;

export function meetingReducer(state: MeetingContextState, action: MeetingAction): MeetingContextState {
  switch (action.type) {
    case 'state':
      // Full state replacement from the server — clears any previous error
      // and re-seeds the version cursor from the bootstrap snapshot. Used
      // for initial join, automatic reconnect, and `state:resync` replies.
      return {
        ...state,
        meeting: action.meeting,
        lastSeenVersion: action.meeting.operational.version,
        error: null,
      };
    case 'setUser':
      return { ...state, user: action.user };
    case 'setConnected':
      return { ...state, connected: action.connected };
    case 'setActiveConnections':
      return { ...state, activeConnections: action.count };
    case 'setError':
      return { ...state, error: action.error };
    case 'setServerRevision':
      return { ...state, serverRevision: action.revision };
    case 'optimisticAgendaReorder': {
      if (!state.meeting) return state;
      const agenda = [...state.meeting.agenda];
      const [item] = agenda.splice(action.oldIndex, 1);
      agenda.splice(action.newIndex, 0, item);
      return { ...state, meeting: { ...state.meeting, agenda } };
    }
    case 'optimisticQueueReorder': {
      if (!state.meeting) return state;
      const orderedIds = [...state.meeting.queue.orderedIds];
      const [id] = orderedIds.splice(action.oldIndex, 1);
      orderedIds.splice(action.newIndex, 0, id);
      return {
        ...state,
        meeting: { ...state.meeting, queue: { ...state.meeting.queue, orderedIds } },
      };
    }
    // Versioned delta cases — apply via `applyDelta` and bump
    // `lastSeenVersion` to the delta's version.
    case 'chairs:updated':
    case 'agenda:added':
    case 'agenda:edited':
    case 'agenda:deleted':
    case 'agenda:reordered':
    case 'agenda:prologueSet':
    case 'agenda:epilogueSet':
    case 'queue:added':
    case 'queue:edited':
    case 'queue:removed':
    case 'queue:reordered':
    case 'queue:closedChanged':
    case 'speaker:advanced':
    case 'agenda:advanced':
    case 'poll:started':
    case 'poll:stopped':
    case 'poll:reacted':
      if (!state.meeting) return state;
      return {
        ...state,
        meeting: applyDelta(state.meeting, action),
        lastSeenVersion: action.delta.version,
      };
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
      <MeetingDispatchContext.Provider value={dispatch}>{children}</MeetingDispatchContext.Provider>
    </MeetingStateContext.Provider>
  );
}
