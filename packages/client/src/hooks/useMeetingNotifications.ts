/**
 * Browser notifications for meeting state transitions.
 *
 * The server broadcasts the full MeetingState on every change, so there are no
 * granular events to subscribe to. This hook diffs the previous snapshot
 * against the current one inside a useEffect and fires a Notification when one
 * of the four configured transitions occurs.
 *
 * Only mounted on the meeting page (where MeetingContext exists).
 */

import { useEffect, useRef } from 'react';
import type { MeetingState } from '@tcq/shared';
import { userKey } from '@tcq/shared';
import { useMeetingState } from '../contexts/MeetingContext.js';
import { usePreferences } from '../contexts/PreferencesContext.js';
import { showNotification } from '../lib/notifications.js';
import { isAgendaItem } from '@tcq/shared';
import type { AgendaItem } from '@tcq/shared';

/**
 * The agenda item immediately after the current one, or `undefined` if
 * none. Session headers are skipped — they're not agenda items and should
 * never be the next thing to advance to.
 */
function nextAgendaItem(state: MeetingState): AgendaItem | undefined {
  if (state.agenda.length === 0) return undefined;
  let searchFrom: number;
  if (state.current.agendaItemId) {
    const idx = state.agenda.findIndex((e) => isAgendaItem(e) && e.id === state.current.agendaItemId);
    if (idx === -1) return undefined;
    searchFrom = idx + 1;
  } else {
    searchFrom = 0;
  }
  for (let i = searchFrom; i < state.agenda.length; i++) {
    const entry = state.agenda[i];
    if (isAgendaItem(entry)) return entry;
  }
  return undefined;
}

/** IDs of queue entries with type 'point-of-order'. */
function pointOfOrderIds(state: MeetingState): Set<string> {
  const ids = new Set<string>();
  for (const id of state.queue.orderedIds) {
    if (state.queue.entries[id]?.type === 'point-of-order') ids.add(id);
  }
  return ids;
}

export function useMeetingNotifications(): void {
  const { meeting, user } = useMeetingState();
  const { notificationsEnabled, setNotificationsEnabled, notificationPrefs } = usePreferences();
  const prevRef = useRef<MeetingState | null>(null);

  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = meeting;

    // Skip when there's nothing to diff yet (first load, or not joined).
    if (!prev || !meeting || !user) return;
    if (!notificationsEnabled) return;

    // Permission was granted when the top-level toggle was enabled; if it's
    // since been revoked in browser settings, self-heal the preference back
    // to off so the UI stops claiming notifications are on.
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
      void setNotificationsEnabled(false);
      return;
    }

    const me = userKey(user);

    // 1. Your queue entry is now next (head of the queue changed, and it's yours).
    if (notificationPrefs.onMyTurnToSpeak) {
      const prevHead = prev.queue.orderedIds[0];
      const nextHead = meeting.queue.orderedIds[0];
      if (prevHead !== nextHead && nextHead) {
        const entry = meeting.queue.entries[nextHead];
        if (entry && entry.userId === me) {
          showNotification("You're up next", { body: entry.topic });
        }
      }
    }

    // 2. Your agenda item is next (upcoming item changed, and you are one
    //    of its presenters). Fires on each co-presenter's client independently.
    if (notificationPrefs.onMyAgendaItemNext) {
      const prevNext = nextAgendaItem(prev);
      const next = nextAgendaItem(meeting);
      if (next && next.id !== prevNext?.id && next.presenterIds.includes(me)) {
        showNotification('Your agenda item is next', { body: next.name });
      }
    }

    // 3. Meeting started / agenda advanced. Both are current.agendaItemId
    //    transitions, but the first one (from undefined → set) is treated as
    //    "meeting started" and subsequent changes are "agenda advanced" — they
    //    are mutually exclusive so the user never gets both for one event.
    if (prev.current.agendaItemId !== meeting.current.agendaItemId && meeting.current.agendaItemId) {
      const current = meeting.agenda.find(
        (entry): entry is AgendaItem => isAgendaItem(entry) && entry.id === meeting.current.agendaItemId,
      );
      if (current) {
        if (!prev.current.agendaItemId) {
          if (notificationPrefs.onMeetingStarted) {
            showNotification('Meeting started', { body: `First item: ${current.name}` });
          }
        } else if (notificationPrefs.onAgendaAdvance) {
          showNotification('Agenda advanced', { body: `Now discussing: ${current.name}` });
        }
      }
    }

    // 3a. A poll was just started (meeting.poll transitioned from absent to present).
    // Suppress for the chair who initiated it — they pressed the button and
    // don't need to be notified about their own action.
    if (notificationPrefs.onPollStarted && !prev.poll && meeting.poll && meeting.poll.startChairId !== me) {
      const body = meeting.poll.topic ? `Topic: ${meeting.poll.topic}` : 'A poll is now open.';
      showNotification('Poll started', { body });
    }

    // 3b. A clarifying question was raised while you are the current topic author.
    if (notificationPrefs.onClarifyingQuestionOnMyTopic && meeting.current.topic?.userId === me) {
      // Find any newly-added 'question' entries that aren't yours.
      const prevIds = new Set(Object.keys(prev.queue.entries));
      for (const id of meeting.queue.orderedIds) {
        if (prevIds.has(id)) continue;
        const entry = meeting.queue.entries[id];
        if (!entry || entry.type !== 'question' || entry.userId === me) continue;
        const authorName = meeting.users[entry.userId]?.name ?? entry.userId;
        showNotification('Clarifying question', { body: `${authorName} · ${entry.topic}` });
      }
    }

    // 4. A point of order has been raised by someone other than you.
    if (notificationPrefs.onPointOfOrder) {
      const prevIds = pointOfOrderIds(prev);
      for (const id of pointOfOrderIds(meeting)) {
        if (prevIds.has(id)) continue;
        const entry = meeting.queue.entries[id];
        if (!entry || entry.userId === me) continue;
        const authorName = meeting.users[entry.userId]?.name ?? entry.userId;
        showNotification('Point of order', { body: `${authorName} · ${entry.topic}` });
      }
    }
  }, [meeting, user, notificationsEnabled, setNotificationsEnabled, notificationPrefs]);

  // 5. Agenda item overrun — schedule a timer to fire when the current agenda
  //    item crosses its timebox. Unlike the other notifications, this is a
  //    time-based event rather than a state diff, so it uses setTimeout. Any
  //    change to the item id, its name, its timebox, or the start time tears
  //    down and reschedules; permission / preference changes do the same.
  const currentAgendaId = meeting?.current.agendaItemId;
  const currentAgendaItem = currentAgendaId
    ? meeting?.agenda.find((e): e is AgendaItem => isAgendaItem(e) && e.id === currentAgendaId)
    : undefined;
  const currentTimebox = currentAgendaItem?.timebox;
  const currentItemName = currentAgendaItem?.name;
  const currentItemStartTime = meeting?.current.agendaItemStartTime;

  useEffect(() => {
    if (!notificationsEnabled) return;
    if (!notificationPrefs.onAgendaItemOverrun) return;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    if (!currentTimebox || !currentItemStartTime || !currentItemName) return;

    const startMs = Date.parse(currentItemStartTime);
    if (Number.isNaN(startMs)) return;
    const deadlineMs = startMs + currentTimebox * 60_000;
    const delay = deadlineMs - Date.now();
    // Don't fire retroactively: if the item was already overrun when the page
    // loaded (or when the timer becomes enabled), skip — the user likely knows.
    if (delay <= 0) return;

    const timeoutId = window.setTimeout(() => {
      showNotification('Time limit reached', {
        body: `"${currentItemName}" has passed its ${currentTimebox}-minute timebox.`,
      });
    }, delay);

    return () => window.clearTimeout(timeoutId);
  }, [
    currentItemName,
    currentItemStartTime,
    currentTimebox,
    notificationsEnabled,
    notificationPrefs.onAgendaItemOverrun,
  ]);
}
