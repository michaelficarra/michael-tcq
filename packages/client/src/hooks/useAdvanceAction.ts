/**
 * Hook that provides advancement actions (Next Speaker, Next Agenda Item).
 *
 * Emits the appropriate payload based on the event type. If the server
 * rejects (e.g. because another chair already advanced), the client will
 * receive an updated state broadcast and the user can click again.
 *
 * Includes two layers of protection against accidental double-advancement:
 * - **Debounce** (DEBOUNCE_MS ms): rapid repeated calls are ignored.
 * - **Cooldown** (COOLDOWN_MS ms): the Next Speaker action is temporarily
 *   disabled when (a) the speaker changed by another user's hand, or (b) the
 *   entry that was next-up was *deleted* out of the queue. Either way the
 *   chair gets a beat to see the new state before advancing. Self-initiated
 *   speaker advancements skip the cooldown (the debounce suffices).
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

  // Epoch-ms deadline until which the action is in cooldown; 0 means no
  // cooldown is active. Held in state so the UI re-renders on both edges.
  const [cooldownUntil, setCooldownUntil] = useState(0);

  const [debounceActive, setDebounceActive] = useState(false);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Track previous values so we can detect changes between renders.
  // `undefined` means we haven't seen any state yet (initial render).
  const prevSpeakerRef = useRef<string | null | undefined>(undefined);
  const prevHeadRef = useRef<string | null | undefined>(undefined);

  // Every deferred timer this hook schedules, so they can all be cleared on
  // unmount — otherwise their callbacks leak across tests (fake timers) and
  // could fire `setState` after the component is gone.
  const pendingTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  // Extract values for the effect's dep array. The eslint react-hooks rule
  // can't reason through nested optional chaining, so we lift what the
  // effect observes. `queue` is needed to look up entry membership.
  const currentSpeakerId = meeting?.current.speaker?.id ?? null;
  const queue = meeting?.queue;
  const queueHeadId = queue?.orderedIds[0] ?? null;
  const lastAdvancementBy = meeting?.operational.lastAdvancementBy;

  // Detect, from incoming server state, the two situations that should
  // pause the Next Speaker action:
  //  1. The current speaker changed by someone else's hand (another chair
  //     advanced, or a reconnect resync) — give the chair a beat to see
  //     who is now speaking before advancing again.
  //  2. The entry that was next-up was *deleted* out of the queue (e.g.
  //     its owner removed it) while the chair may already be reaching for
  //     the button — without the pause the click would advance to whoever
  //     shifted into first place. Reordering is excluded (the entry is
  //     still in the queue) and so is advancement (the speaker changes,
  //     so it falls under case 1).
  useEffect(() => {
    if (event !== 'queue:next') return;

    const prevSpeaker = prevSpeakerRef.current;
    const prevHead = prevHeadRef.current;

    prevSpeakerRef.current = currentSpeakerId;
    prevHeadRef.current = queueHeadId;

    // First state seen — record only, don't trigger cooldown.
    if (prevSpeaker === undefined || prevHead === undefined) return;

    let shouldCooldown = false;
    if (currentSpeakerId !== prevSpeaker) {
      // Speaker advanced. Skip the cooldown when we initiated it
      // ourselves — the debounce already guards against double-fires.
      const selfInitiated = user != null && lastAdvancementBy === userKey(user);
      shouldCooldown = !selfInitiated;
    } else if (prevHead !== null && prevHead !== queueHeadId && queue && !(prevHead in queue.entries)) {
      // Speaker unchanged, but the entry that was next-up is now gone from
      // the queue entirely — it was deleted. A reorder leaves it present
      // (just not first); a fresh queue going from empty to populated has
      // `prevHead === null` and is not a deletion.
      shouldCooldown = true;
    }

    if (!shouldCooldown) return;

    // Defer the `setState` out of the effect body (the lint rule against
    // cascading renders). This timer is intentionally not cancelled when
    // the effect re-runs — a burst of deltas must not be able to drop a
    // cooldown that was legitimately triggered — only on unmount.
    const deadline = Date.now() + COOLDOWN_MS;
    const timer = setTimeout(() => {
      pendingTimersRef.current.delete(timer);
      setCooldownUntil((prev) => Math.max(prev, deadline));
    }, 0);
    pendingTimersRef.current.add(timer);
  }, [currentSpeakerId, queueHeadId, queue, event, user, lastAdvancementBy]);

  // Single timer that ends the cooldown when the deadline passes. Keyed on
  // `cooldownUntil` so it reschedules when the window is extended and is
  // left untouched by unrelated re-renders — a per-render timer could be
  // cleared before it fired, stranding the button permanently disabled.
  useEffect(() => {
    if (cooldownUntil === 0) return;
    const pending = pendingTimersRef.current;
    const timer = setTimeout(
      () => {
        pending.delete(timer);
        setCooldownUntil(0);
      },
      Math.max(cooldownUntil - Date.now(), 0),
    );
    pending.add(timer);
    return () => {
      clearTimeout(timer);
      pending.delete(timer);
    };
  }, [cooldownUntil]);

  // Clear every outstanding timer on unmount so callbacks don't fire
  // `setState` on a gone component (happens in tests that unmount before a
  // debounce or cooldown elapses).
  useEffect(() => {
    const pending = pendingTimersRef.current;
    return () => {
      clearTimeout(debounceTimerRef.current);
      for (const timer of pending) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const fire = useCallback(
    (extras?: AdvanceExtras) => {
      if (!socket || !meeting) return;
      if (Date.now() < cooldownUntil) return;

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
    [socket, meeting, event, cooldownUntil],
  );

  return { fire, disabled: cooldownUntil > 0 || debounceActive };
}
