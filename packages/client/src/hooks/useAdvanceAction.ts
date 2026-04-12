/**
 * Hook that provides advancement actions (Next Speaker, Next Agenda Item)
 * with automatic retry on stale version.
 *
 * When two chairs click an advancement button at the same time, the
 * second request will be rejected because its version is stale. The
 * server responds via an ack callback with the current version, and
 * this hook automatically retries with the updated version.
 *
 * Retries are limited to prevent infinite loops in case of persistent
 * errors (e.g. the meeting was deleted).
 */

import { useCallback } from 'react';
import type { AdvanceResponse } from '@tcq/shared';
import { useSocket, type TypedSocket } from '../contexts/SocketContext.js';
import { useMeetingState } from '../contexts/MeetingContext.js';

/** Maximum number of retries before giving up. */
const MAX_RETRIES = 3;

type AdvanceEvent = 'queue:next' | 'meeting:nextAgendaItem';

/**
 * Emit an advancement event with automatic retry on stale version.
 * Uses the ack callback from the server to determine whether to retry.
 */
function emitWithRetry(
  socket: TypedSocket,
  event: AdvanceEvent,
  version: number,
  retriesLeft: number,
): void {
  socket.emit(event, { version }, (response: AdvanceResponse) => {
    if (response.ok) return; // Success — nothing more to do

    // If the server returned a new version, retry with it
    if (response.version != null && retriesLeft > 0) {
      emitWithRetry(socket, event, response.version, retriesLeft - 1);
    }
    // Otherwise the error is non-retryable (not a chair, no more items, etc.)
    // — the server already sent an error event or updated state
  });
}

/**
 * Returns a function that emits an advancement event with the current
 * meeting version, retrying automatically if the version is stale.
 */
export function useAdvanceAction(event: AdvanceEvent): () => void {
  const socket = useSocket();
  const { meeting } = useMeetingState();

  return useCallback(() => {
    if (!socket || !meeting) return;
    emitWithRetry(socket, event, meeting.version, MAX_RETRIES);
  }, [socket, meeting, event]);
}
