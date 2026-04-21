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

/** The agenda item immediately after the current one, or `undefined` if none. */
function nextAgendaItem(state: MeetingState) {
  if (state.agenda.length === 0) return undefined;
  if (!state.currentAgendaItemId) return state.agenda[0];
  const currentIdx = state.agenda.findIndex((item) => item.id === state.currentAgendaItemId);
  if (currentIdx === -1) return undefined;
  return state.agenda[currentIdx + 1];
}

/** IDs of queue entries with type 'point-of-order'. */
function pointOfOrderIds(state: MeetingState): Set<string> {
  const ids = new Set<string>();
  for (const id of state.queuedSpeakerIds) {
    if (state.queueEntries[id]?.type === 'point-of-order') ids.add(id);
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
      const prevHead = prev.queuedSpeakerIds[0];
      const nextHead = meeting.queuedSpeakerIds[0];
      if (prevHead !== nextHead && nextHead) {
        const entry = meeting.queueEntries[nextHead];
        if (entry && entry.userId === me) {
          showNotification("You're up next", { body: entry.topic });
        }
      }
    }

    // 2. Your agenda item is next (upcoming item changed, and it's yours).
    if (notificationPrefs.onMyAgendaItemNext) {
      const prevNext = nextAgendaItem(prev);
      const next = nextAgendaItem(meeting);
      if (next && next.id !== prevNext?.id && next.ownerId === me) {
        showNotification('Your agenda item is next', { body: next.name });
      }
    }

    // 3. Meeting started / agenda advanced. Both are currentAgendaItemId
    //    transitions, but the first one (from undefined → set) is treated as
    //    "meeting started" and subsequent changes are "agenda advanced" — they
    //    are mutually exclusive so the user never gets both for one event.
    if (prev.currentAgendaItemId !== meeting.currentAgendaItemId && meeting.currentAgendaItemId) {
      const current = meeting.agenda.find((item) => item.id === meeting.currentAgendaItemId);
      if (current) {
        if (!prev.currentAgendaItemId) {
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
    if (notificationPrefs.onClarifyingQuestionOnMyTopic && meeting.currentTopicEntryId) {
      const topic = meeting.queueEntries[meeting.currentTopicEntryId];
      if (topic && topic.userId === me) {
        // Find any newly-added 'question' entries that aren't yours.
        const prevIds = new Set(Object.keys(prev.queueEntries));
        for (const id of meeting.queuedSpeakerIds) {
          if (prevIds.has(id)) continue;
          const entry = meeting.queueEntries[id];
          if (!entry || entry.type !== 'question' || entry.userId === me) continue;
          const authorName = meeting.users[entry.userId]?.name ?? entry.userId;
          showNotification('Clarifying question', { body: `${authorName} · ${entry.topic}` });
        }
      }
    }

    // 4. A point of order has been raised by someone other than you.
    if (notificationPrefs.onPointOfOrder) {
      const prevIds = pointOfOrderIds(prev);
      for (const id of pointOfOrderIds(meeting)) {
        if (prevIds.has(id)) continue;
        const entry = meeting.queueEntries[id];
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
  const currentAgendaId = meeting?.currentAgendaItemId;
  const currentAgendaItem = currentAgendaId ? meeting?.agenda.find((a) => a.id === currentAgendaId) : undefined;
  const currentTimebox = currentAgendaItem?.timebox;
  const currentItemName = currentAgendaItem?.name;
  const currentItemStartTime = meeting?.currentAgendaItemStartTime;

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
