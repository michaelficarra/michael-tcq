/**
 * Hook that provides advancement actions (Next Speaker, Next Agenda Item).
 *
 * Emits the appropriate payload based on the event type. If the server
 * rejects (e.g. because another chair already advanced), the client will
 * receive an updated state broadcast and the user can click again.
 */

import { useCallback } from 'react';
import type { AdvanceResponse } from '@tcq/shared';
import { useSocket } from '../contexts/SocketContext.js';
import { useMeetingState } from '../contexts/MeetingContext.js';

type AdvanceEvent = 'queue:next' | 'meeting:nextAgendaItem';

/**
 * Returns a function that emits an advancement event with the current
 * meeting state as a precondition payload.
 */
export function useAdvanceAction(event: AdvanceEvent): () => void {
  const socket = useSocket();
  const { meeting } = useMeetingState();

  return useCallback(() => {
    if (!socket || !meeting) return;

    if (event === 'queue:next') {
      socket.emit(event, { currentSpeakerEntryId: meeting.currentSpeakerEntryId ?? null }, (response: AdvanceResponse) => {
        if (!response.ok && response.error) {
          console.warn(`[useAdvanceAction] ${event} rejected:`, response.error);
        }
      });
    } else {
      socket.emit(event, { currentAgendaItemId: meeting.currentAgendaItemId ?? null }, (response: AdvanceResponse) => {
        if (!response.ok && response.error) {
          console.warn(`[useAdvanceAction] ${event} rejected:`, response.error);
        }
      });
    }
  }, [socket, meeting, event]);
}
