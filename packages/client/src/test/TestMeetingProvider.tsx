/**
 * Test helper that provides a MeetingContext with pre-populated state.
 * Used in component tests to avoid needing a real Socket.IO connection.
 */

import type { ReactNode } from 'react';
import type { MeetingState, User } from '@tcq/shared';
import {
  MeetingStateContext,
  MeetingDispatchContext,
  type MeetingContextState,
} from '../contexts/MeetingContext.js';

interface TestMeetingProviderProps {
  meeting: MeetingState | null;
  user?: User | null;
  connected?: boolean;
  children: ReactNode;
}

/**
 * Wraps children with MeetingContext populated with the given state.
 * Dispatch is a no-op since tests verify rendered output, not dispatches.
 */
export function TestMeetingProvider({
  meeting,
  user = null,
  connected = true,
  children,
}: TestMeetingProviderProps) {
  const state: MeetingContextState = { meeting, user, connected };

  return (
    <MeetingStateContext value={state}>
      <MeetingDispatchContext value={() => {}}>
        {children}
      </MeetingDispatchContext>
    </MeetingStateContext>
  );
}
