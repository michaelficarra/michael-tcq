/**
 * Protection against acting on the wrong thing when the Poll Requests
 * section changes under the user, mirroring `useAdvanceAction`'s two
 * layers for Next Speaker / Next Agenda Item:
 *
 * - **Debounce** (DEBOUNCE_MS): rapid repeated poll-request actions
 *   (Approve, Dismiss, Withdraw) are ignored, and `disabled` is true for
 *   the window so the buttons visibly grey out.
 * - **Cooldown** (COOLDOWN_MS): when the visible pending-request list
 *   changes by someone *else's* hand — a request added, revised (a new id
 *   from the same requester), or removed by a chair or an agenda advance —
 *   `coolingDown` is true for a beat. The Poll Requests section sits above
 *   the speaker and queue controls, so any change to it shifts Next
 *   Speaker and every queue entry's Edit/Delete down or up the page. The
 *   caller disables those controls (and the poll-request actions
 *   themselves) while cooling down, so a chair can't hit the wrong
 *   Delete because a request just came in.
 *
 *   Changes we caused ourselves don't cool down: a dismiss/approve/
 *   withdraw we fired through `guard`, our own new or revised request,
 *   and requests cleared by an agenda advance we triggered.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { userKey } from '@tcq/shared';
import { useMeetingState } from '../contexts/MeetingContext.js';

const DEBOUNCE_MS = 400;
const COOLDOWN_MS = 2000;

/** User-facing explanation shown next to disabled actions while cooling down. */
export const POLL_REQUEST_COOLDOWN_REASON = 'Poll requests just changed';

export interface PollRequestGuard {
  /** True while the debounce or cooldown window is active. */
  disabled: boolean;
  /**
   * True during the cooldown after someone else changed the visible list.
   * Callers disable layout-sensitive controls below the list while set.
   */
  coolingDown: boolean;
  /** Run `fn` for request `id` unless the guard is active. */
  guard: (id: string, fn: () => void) => void;
}

export function usePollRequestGuard(): PollRequestGuard {
  const { meeting, user } = useMeetingState();
  const pollRequests = meeting?.pollRequests;
  const me = user ? userKey(user) : null;
  const agendaItemId = meeting?.current.agendaItemId;
  const lastAdvancementBy = meeting?.operational.lastAdvancementBy;

  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [debounceActive, setDebounceActive] = useState(false);
  const lastFireRef = useRef(0);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pendingTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  // Ids whose removal we initiated (dismiss/approve). Their disappearance
  // is expected and must not pause us.
  const ownRemovalsRef = useRef<Set<string>>(new Set());

  // Previous snapshot of the list: id → requesterId. `undefined` until the
  // first state is seen so the initial load never triggers a cooldown.
  const prevRef = useRef<Map<string, string> | undefined>(undefined);
  const prevAgendaItemRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const prev = prevRef.current;
    const prevAgendaItem = prevAgendaItemRef.current;
    const next = new Map((pollRequests ?? []).map((r) => [r.id, r.requesterId] as const));
    prevRef.current = next;
    prevAgendaItemRef.current = agendaItemId;
    if (prev === undefined) return;

    const added = [...next].filter(([id]) => !prev.has(id));
    const removed = [...prev].filter(([id]) => !next.has(id));
    // We replaced our own request if one of ours left and one of ours arrived.
    const ownReplacement = added.some(([, r]) => r === me) && removed.some(([, r]) => r === me);
    // Requests cleared as part of an agenda advance we triggered.
    const selfAdvanced = agendaItemId !== prevAgendaItem && me !== null && lastAdvancementBy === me;

    let foreignChange = added.some(([, requesterId]) => requesterId !== me);
    for (const [id, requesterId] of removed) {
      if (ownRemovalsRef.current.delete(id)) continue; // we dismissed/approved/withdrew it
      if (requesterId === me && ownReplacement) continue; // we revised it
      if (selfAdvanced) continue;
      foreignChange = true;
    }
    if (!foreignChange) return;

    // Defer the setState out of the effect body. Not cancelled on re-run:
    // a burst of deltas must not drop a legitimately triggered cooldown.
    const deadline = Date.now() + COOLDOWN_MS;
    const timer = setTimeout(() => {
      pendingTimersRef.current.delete(timer);
      setCooldownUntil((cur) => Math.max(cur, deadline));
    }, 0);
    pendingTimersRef.current.add(timer);
  }, [pollRequests, me, agendaItemId, lastAdvancementBy]);

  // Single timer that ends the cooldown; keyed on the deadline so an
  // extended window reschedules and unrelated renders leave it alone.
  useEffect(() => {
    if (cooldownUntil === 0) return;
    const pending = pendingTimersRef.current;
    const deadline = cooldownUntil;
    const timer = setTimeout(
      () => {
        pending.delete(timer);
        // Only clear the window this timer was armed for. If a later
        // change extended the deadline in the same batch, a stale timer
        // must not drop it.
        setCooldownUntil((cur) => (cur === deadline ? 0 : cur));
      },
      Math.max(cooldownUntil - Date.now(), 0),
    );
    pending.add(timer);
    return () => {
      clearTimeout(timer);
      pending.delete(timer);
    };
  }, [cooldownUntil]);

  useEffect(() => {
    const pending = pendingTimersRef.current;
    return () => {
      clearTimeout(debounceTimerRef.current);
      for (const t of pending) clearTimeout(t);
      pending.clear();
    };
  }, []);

  const guard = useCallback(
    (id: string, fn: () => void) => {
      const now = Date.now();
      if (now < cooldownUntil) return;
      if (now - lastFireRef.current < DEBOUNCE_MS) return;
      lastFireRef.current = now;

      ownRemovalsRef.current.add(id);
      fn();

      setDebounceActive(true);
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(() => setDebounceActive(false), DEBOUNCE_MS);
    },
    [cooldownUntil],
  );

  const coolingDown = cooldownUntil > 0;
  return { disabled: coolingDown || debounceActive, coolingDown, guard };
}
