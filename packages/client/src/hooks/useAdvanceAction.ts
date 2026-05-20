/**
 * Hook that provides advancement actions (Next Speaker, Next Agenda Item).
 *
 * Emits the appropriate payload based on the event type. If the server
 * rejects (e.g. because another chair already advanced), the client will
 * receive an updated state broadcast and the user can click again.
 *
 * Includes two layers of protection against accidental double-advancement:
 * - **Debounce** (DEBOUNCE_MS ms): rapid repeated calls are ignored.
 * - **Cooldown** (COOLDOWN_MS ms): after a speaker change attributed to another
 *   user, or a change to the next queue entry (insertion/removal/reorder),
 *   the action is temporarily disabled so the chair can see what's coming up
 *   before advancing. Self-initiated speaker advancements skip the cooldown
 *   (the debounce suffices); changes to the next queue entry always cool down
 *   even when self-initiated, because the chair may have already started
 *   reaching for the button.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AdvanceResponse } from '@tcq/shared';
import { userKey } from '@tcq/shared';
import { useSocket } from '../contexts/SocketContext.js';
import { useMeetingState } from '../contexts/MeetingContext.js';

type AdvanceEvent = 'queue:next' | 'meeting:nextAgendaItem';

const DEBOUNCE_MS = 400;
const COOLDOWN_MS = 2000;

/**
 * Optional extras the caller can attach to a `meeting:nextAgendaItem` fire.
 * Only `conclusion` is supported today; ignored for `queue:next`.
 */
export interface AdvanceExtras {
  /** Conclusion text for the outgoing agenda item (next-agenda only). */
  conclusion?: string;
}

/**
 * Returns a `fire` function that emits an advancement event with the current
 * meeting state as a precondition payload, and a `disabled` flag that is
 * `true` while the debounce or cooldown period is active. For
 * `meeting:nextAgendaItem`, `fire` accepts optional extras (e.g. the
 * chair-authored conclusion) which are forwarded into the emit payload.
 */
export function useAdvanceAction(event: AdvanceEvent): { fire: (extras?: AdvanceExtras) => void; disabled: boolean } {
  const socket = useSocket();
  const { meeting, user } = useMeetingState();

  const lastFireRef = useRef<number>(0);

  // Timestamp (epoch ms) until which the action is in cooldown.
  // Checked by fire() directly; the `cooldown` state mirrors it for the UI.
  const cooldownUntilRef = useRef<number>(0);

  // Drive the `disabled` return value for UI feedback.
  const [cooldown, setCooldown] = useState(false);
  const [debounceActive, setDebounceActive] = useState(false);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Track previous values so we can detect changes between renders.
  // `undefined` means we haven't seen any state yet (initial render).
  const prevSpeakerRef = useRef<string | null | undefined>(undefined);
  const prevNextEntryRef = useRef<string | null | undefined>(undefined);

  // Extract primitive values for the effect's dep array. The eslint
  // react-hooks rule can't reason through nested optional chaining, so
  // we lift the primitives the effect actually observes.
  const currentSpeakerId = meeting?.current.speaker?.id ?? null;
  const nextQueueEntryId = meeting?.queue.orderedIds[0] ?? null;
  const lastAdvancementBy = meeting?.operational.lastAdvancementBy;

  // Detect speaker advancement or changes to the next queue entry from any
  // source (server state broadcast). setState is called via setTimeout to
  // avoid synchronous setState in the effect body (which triggers cascading
  // renders).
  useEffect(() => {
    if (event !== 'queue:next') return;

    const prevSpeaker = prevSpeakerRef.current;
    const prevNext = prevNextEntryRef.current;

    if (prevSpeaker === undefined || prevNext === undefined) {
      // First render — just record, don't trigger cooldown.
      prevSpeakerRef.current = currentSpeakerId;
      prevNextEntryRef.current = nextQueueEntryId;
      return;
    }

    const speakerChanged = currentSpeakerId !== prevSpeaker;
    const nextChanged = nextQueueEntryId !== prevNext;

    if (!speakerChanged && !nextChanged) return;

    prevSpeakerRef.current = currentSpeakerId;
    prevNextEntryRef.current = nextQueueEntryId;

    // Self-initiated speaker advancement skips cooldown — the debounce
    // alone is sufficient to prevent accidental double-fires. (The next
    // entry also shifts on self-advance, but that's the expected outcome,
    // not a surprise the chair needs time to absorb.)
    if (speakerChanged) {
      const selfInitiated = user != null && lastAdvancementBy === userKey(user);
      if (selfInitiated) return;
    }

    cooldownUntilRef.current = Date.now() + COOLDOWN_MS;

    const enableTimer = setTimeout(() => setCooldown(true), 0);
    const disableTimer = setTimeout(() => {
      cooldownUntilRef.current = 0;
      setCooldown(false);
    }, COOLDOWN_MS);

    return () => {
      clearTimeout(enableTimer);
      clearTimeout(disableTimer);
    };
  }, [currentSpeakerId, nextQueueEntryId, event, user, lastAdvancementBy]);

  // Clear the debounce timer on unmount so it doesn't fire `setDebounceActive`
  // on an unmounted component (happens in tests that click the button and
  // unmount before DEBOUNCE_MS elapses).
  useEffect(() => {
    return () => {
      clearTimeout(debounceTimerRef.current);
    };
  }, []);

  const fire = useCallback(
    (extras?: AdvanceExtras) => {
      if (!socket || !meeting) return;
      if (Date.now() < cooldownUntilRef.current) return;

      // Debounce only applies to speaker advancement — agenda advancement
      // has its own confirmation dialog and doesn't need rapid-click protection.
      if (event === 'queue:next') {
        const now = Date.now();
        if (now - lastFireRef.current < DEBOUNCE_MS) return;
        lastFireRef.current = now;
      }

      if (event === 'queue:next') {
        socket.emit(
          event,
          { currentSpeakerEntryId: meeting.current.speaker?.id ?? null },
          (response: AdvanceResponse) => {
            if (!response.ok && response.error) {
              console.warn(`[useAdvanceAction] ${event} rejected:`, response.error);
            }
          },
        );
      } else {
        socket.emit(
          event,
          {
            currentAgendaItemId: meeting.current.agendaItemId ?? null,
            ...(extras?.conclusion !== undefined ? { conclusion: extras.conclusion } : {}),
          },
          (response: AdvanceResponse) => {
            if (!response.ok && response.error) {
              console.warn(`[useAdvanceAction] ${event} rejected:`, response.error);
            }
          },
        );
      }

      // Disable the button for the debounce period so the user gets
      // visual feedback that rapid clicks are being ignored.
      if (event === 'queue:next') {
        setDebounceActive(true);
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = setTimeout(() => setDebounceActive(false), DEBOUNCE_MS);
      }
    },
    [socket, meeting, event],
  );

  return { fire, disabled: cooldown || debounceActive };
}
