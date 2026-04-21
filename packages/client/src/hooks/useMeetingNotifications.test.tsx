import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { MeetingState, User } from '@tcq/shared';
import { TestMeetingProvider } from '../test/TestMeetingProvider.js';
import { PreferencesProvider, type NotificationPrefs } from '../contexts/PreferencesContext.js';
import { makeMeeting as buildMeeting } from '../test/makeMeeting.js';
import { useMeetingNotifications } from './useMeetingNotifications.js';

const alice: User = { ghid: 1, ghUsername: 'alice', name: 'Alice', organisation: '' };
const bob: User = { ghid: 2, ghUsername: 'bob', name: 'Bob', organisation: '' };

function makeMeeting(overrides: Partial<MeetingState> = {}): MeetingState {
  return buildMeeting(overrides, { id: 'm', users: { alice, bob }, chairIds: ['alice'] });
}

/** Seed the PreferencesContext's initial state synchronously via localStorage. */
function seedPreferences(opts: { enabled: boolean; prefs?: Partial<NotificationPrefs> } = { enabled: false }) {
  localStorage.setItem('tcq-notifications-enabled', String(opts.enabled));
  if (opts.prefs) {
    const full: NotificationPrefs = {
      onMyTurnToSpeak: true,
      onMyAgendaItemNext: true,
      onMeetingStarted: true,
      onAgendaAdvance: true,
      onPollStarted: true,
      onClarifyingQuestionOnMyTopic: true,
      onPointOfOrder: false,
      onAgendaItemOverrun: false,
      ...opts.prefs,
    };
    localStorage.setItem('tcq-notification-prefs', JSON.stringify(full));
  }
}

function HookRunner() {
  useMeetingNotifications();
  return null;
}

/** Renders a scene with the hook, using an already-seeded PreferencesProvider. */
function Scene({
  meeting,
  user = alice,
  children,
}: {
  meeting: MeetingState | null;
  user?: User | null;
  children?: ReactNode;
}) {
  return (
    <PreferencesProvider>
      <TestMeetingProvider meeting={meeting} user={user}>
        <HookRunner />
        {children}
      </TestMeetingProvider>
    </PreferencesProvider>
  );
}

let notificationCtor: ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.clear();
  notificationCtor = vi.fn();
  // Stub global Notification: capture constructor calls, permission granted by default.
  vi.stubGlobal(
    'Notification',
    Object.assign(notificationCtor, {
      permission: 'granted' as NotificationPermission,
      requestPermission: vi.fn(async () => 'granted' as NotificationPermission),
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useMeetingNotifications', () => {
  it('does not fire on the first state load', () => {
    seedPreferences({ enabled: true });
    const initial = makeMeeting({ current: { topicSpeakers: [], agendaItemId: 'a' } });
    render(<Scene meeting={initial} />);
    expect(notificationCtor).not.toHaveBeenCalled();
  });

  it('fires "Agenda advanced" when currentAgendaItemId changes after the meeting has started', () => {
    seedPreferences({ enabled: true });
    const agenda = [
      { id: 'a', name: 'Opening', ownerId: 'alice' },
      { id: 'b', name: 'Discussion', ownerId: 'bob' },
    ];
    const prev = makeMeeting({ agenda, current: { topicSpeakers: [], agendaItemId: 'a' } });
    const { rerender } = render(<Scene meeting={prev} />);

    const next = makeMeeting({ agenda, current: { topicSpeakers: [], agendaItemId: 'b' } });
    rerender(<Scene meeting={next} />);

    expect(notificationCtor).toHaveBeenCalledWith(
      'Agenda advanced',
      expect.objectContaining({ body: expect.stringContaining('Discussion') }),
    );
    // Mutually exclusive with "Meeting started" — that title shouldn't fire.
    const startedCalls = notificationCtor.mock.calls.filter(([title]) => title === 'Meeting started');
    expect(startedCalls).toHaveLength(0);
  });

  it('fires "Meeting started" (not "Agenda advanced") on the first agenda item transition', () => {
    seedPreferences({ enabled: true });
    const agenda = [{ id: 'a', name: 'Opening', ownerId: 'alice' }];
    const prev = makeMeeting({ agenda });
    const { rerender } = render(<Scene meeting={prev} />);

    const next = makeMeeting({ agenda, current: { topicSpeakers: [], agendaItemId: 'a' } });
    rerender(<Scene meeting={next} />);

    expect(notificationCtor).toHaveBeenCalledWith(
      'Meeting started',
      expect.objectContaining({ body: expect.stringContaining('Opening') }),
    );
    const advancedCalls = notificationCtor.mock.calls.filter(([title]) => title === 'Agenda advanced');
    expect(advancedCalls).toHaveLength(0);
  });

  it('fires "Poll started" when a poll becomes active', () => {
    seedPreferences({ enabled: true });
    // Bob is the chair who started the poll; alice (the current user) is a
    // participant and should be notified.
    const prev = makeMeeting();
    const { rerender } = render(<Scene meeting={prev} user={alice} />);

    const next = makeMeeting({
      poll: {
        options: [],
        reactions: [],
        startTime: new Date().toISOString(),
        startChairId: 'bob',
        topic: 'Should we break?',
        multiSelect: true,
      },
    });
    rerender(<Scene meeting={next} user={alice} />);

    expect(notificationCtor).toHaveBeenCalledWith(
      'Poll started',
      expect.objectContaining({ body: expect.stringContaining('Should we break?') }),
    );
  });

  it('does NOT fire "Poll started" for the chair who started it', () => {
    seedPreferences({ enabled: true });
    // Alice (the current user) is the chair starting the poll — she shouldn't
    // be notified about her own action.
    const prev = makeMeeting();
    const { rerender } = render(<Scene meeting={prev} user={alice} />);

    const next = makeMeeting({
      poll: {
        options: [],
        reactions: [],
        startTime: new Date().toISOString(),
        startChairId: 'alice',
        topic: 'Should we break?',
        multiSelect: true,
      },
    });
    rerender(<Scene meeting={next} user={alice} />);

    const pollCalls = notificationCtor.mock.calls.filter(([title]) => title === 'Poll started');
    expect(pollCalls).toHaveLength(0);
  });

  it('fires "Clarifying question" when someone queues one on your current topic', () => {
    seedPreferences({ enabled: true });
    // Alice is the current-topic author via t1; no prior question entries.
    const aliceTopic = { speakerId: 't1', userId: 'alice', topic: 'my topic', startTime: '2026-01-01T00:00:00.000Z' };
    const prev = makeMeeting({
      current: { topicSpeakers: [], topic: aliceTopic },
    });
    const { rerender } = render(<Scene meeting={prev} user={alice} />);

    const next = makeMeeting({
      queue: {
        entries: { q1: { id: 'q1', type: 'question', topic: 'why?', userId: 'bob' } },
        orderedIds: ['q1'],
        closed: false,
      },
      current: { topicSpeakers: [], topic: aliceTopic },
    });
    rerender(<Scene meeting={next} user={alice} />);

    expect(notificationCtor).toHaveBeenCalledWith(
      'Clarifying question',
      expect.objectContaining({ body: expect.stringContaining('Bob') }),
    );
  });

  it('does NOT fire "Clarifying question" when the current topic is not yours', () => {
    seedPreferences({ enabled: true });
    // Bob is the current-topic author; a question from another user shouldn't
    // notify Alice because the topic isn't hers.
    const bobTopic = { speakerId: 't1', userId: 'bob', topic: "bob's", startTime: '2026-01-01T00:00:00.000Z' };
    const prev = makeMeeting({
      current: { topicSpeakers: [], topic: bobTopic },
    });
    const { rerender } = render(<Scene meeting={prev} user={alice} />);

    const next = makeMeeting({
      queue: {
        entries: { q1: { id: 'q1', type: 'question', topic: 'why?', userId: 'carol' } },
        orderedIds: ['q1'],
        closed: false,
      },
      current: { topicSpeakers: [], topic: bobTopic },
    });
    rerender(<Scene meeting={next} user={alice} />);

    const qCalls = notificationCtor.mock.calls.filter(([title]) => title === 'Clarifying question');
    expect(qCalls).toHaveLength(0);
  });

  it('fires "You\'re up next" when the head of the queue becomes your entry', () => {
    seedPreferences({ enabled: true });
    const prev = makeMeeting({
      queue: {
        entries: { q1: { id: 'q1', type: 'topic', topic: 'bob topic', userId: 'bob' } },
        orderedIds: ['q1'],
        closed: false,
      },
    });
    const { rerender } = render(<Scene meeting={prev} />);

    const next = makeMeeting({
      queue: {
        entries: {
          q1: { id: 'q1', type: 'topic', topic: 'bob topic', userId: 'bob' },
          q2: { id: 'q2', type: 'topic', topic: 'my turn', userId: 'alice' },
        },
        orderedIds: ['q2', 'q1'],
        closed: false,
      },
    });
    rerender(<Scene meeting={next} />);

    expect(notificationCtor).toHaveBeenCalledWith("You're up next", expect.objectContaining({ body: 'my turn' }));
  });

  it('fires "Your agenda item is next" when the upcoming agenda item is yours', () => {
    seedPreferences({ enabled: true });
    const prev = makeMeeting({
      agenda: [{ id: 'a', name: 'Opening', ownerId: 'bob' }],
      current: { topicSpeakers: [], agendaItemId: 'a' },
    });
    const { rerender } = render(<Scene meeting={prev} />);

    const agenda = [
      { id: 'a', name: 'Opening', ownerId: 'bob' },
      { id: 'b', name: 'My item', ownerId: 'alice' },
    ];
    const next = makeMeeting({ agenda, current: { topicSpeakers: [], agendaItemId: 'a' } });
    rerender(<Scene meeting={next} />);

    expect(notificationCtor).toHaveBeenCalledWith(
      'Your agenda item is next',
      expect.objectContaining({ body: 'My item' }),
    );
  });

  it('fires "Point of order" when someone else raises one', () => {
    seedPreferences({ enabled: true, prefs: { onPointOfOrder: true } });
    const prev = makeMeeting({});
    const { rerender } = render(<Scene meeting={prev} />);

    const next = makeMeeting({
      queue: {
        entries: { q1: { id: 'q1', type: 'point-of-order', topic: 'order please', userId: 'bob' } },
        orderedIds: ['q1'],
        closed: false,
      },
    });
    rerender(<Scene meeting={next} />);

    expect(notificationCtor).toHaveBeenCalledWith(
      'Point of order',
      expect.objectContaining({ body: expect.stringContaining('Bob') }),
    );
  });

  it('does NOT fire "Point of order" when you raised it yourself', () => {
    seedPreferences({ enabled: true, prefs: { onPointOfOrder: true } });
    const prev = makeMeeting({});
    const { rerender } = render(<Scene meeting={prev} />);

    const next = makeMeeting({
      queue: {
        entries: { q1: { id: 'q1', type: 'point-of-order', topic: 'mine', userId: 'alice' } },
        orderedIds: ['q1'],
        closed: false,
      },
    });
    rerender(<Scene meeting={next} />);

    const pooCalls = notificationCtor.mock.calls.filter(([title]) => title === 'Point of order');
    expect(pooCalls).toHaveLength(0);
  });

  it('fires nothing when notifications are disabled', () => {
    seedPreferences({ enabled: false });
    const agenda = [
      { id: 'a', name: 'A', ownerId: 'alice' },
      { id: 'b', name: 'B', ownerId: 'alice' },
    ];
    const prev = makeMeeting({ agenda, current: { topicSpeakers: [], agendaItemId: 'a' } });
    const { rerender } = render(<Scene meeting={prev} />);

    const next = makeMeeting({ agenda, current: { topicSpeakers: [], agendaItemId: 'b' } });
    rerender(<Scene meeting={next} />);

    expect(notificationCtor).not.toHaveBeenCalled();
  });

  it('respects per-event toggles (agenda-advance off)', () => {
    seedPreferences({ enabled: true, prefs: { onAgendaAdvance: false } });
    const agenda = [
      { id: 'a', name: 'A', ownerId: 'bob' },
      { id: 'b', name: 'B', ownerId: 'bob' },
    ];
    const prev = makeMeeting({ agenda, current: { topicSpeakers: [], agendaItemId: 'a' } });
    const { rerender } = render(<Scene meeting={prev} />);

    const next = makeMeeting({ agenda, current: { topicSpeakers: [], agendaItemId: 'b' } });
    rerender(<Scene meeting={next} />);

    const advanceCalls = notificationCtor.mock.calls.filter(([title]) => title === 'Agenda advanced');
    expect(advanceCalls).toHaveLength(0);
  });

  it('fires "Time limit reached" when the current agenda item crosses its timebox', () => {
    vi.useFakeTimers();
    try {
      seedPreferences({ enabled: true, prefs: { onAgendaItemOverrun: true } });
      const now = new Date('2026-04-19T10:00:00Z').getTime();
      vi.setSystemTime(now);
      const agenda = [{ id: 'a', name: 'Opening', ownerId: 'alice', timebox: 5 }]; // 5-minute timebox
      const meeting = makeMeeting({
        agenda,
        current: {
          topicSpeakers: [],
          agendaItemId: 'a',
          agendaItemStartTime: new Date(now).toISOString(),
        },
      });

      render(<Scene meeting={meeting} />);

      // Nothing has fired yet — timer is pending.
      expect(notificationCtor).not.toHaveBeenCalled();

      // Advance 5 minutes + a tick. The timer should fire.
      vi.advanceTimersByTime(5 * 60_000 + 1);

      expect(notificationCtor).toHaveBeenCalledWith(
        'Time limit reached',
        expect.objectContaining({ body: expect.stringContaining('Opening') }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not fire "Time limit reached" retroactively when the item was already overrun at load', () => {
    vi.useFakeTimers();
    try {
      seedPreferences({ enabled: true, prefs: { onAgendaItemOverrun: true } });
      const now = new Date('2026-04-19T10:30:00Z').getTime();
      vi.setSystemTime(now);
      const agenda = [{ id: 'a', name: 'Opening', ownerId: 'alice', timebox: 5 }];
      // Start time was 30 minutes ago — deadline is 25 minutes in the past.
      const meeting = makeMeeting({
        agenda,
        current: {
          topicSpeakers: [],
          agendaItemId: 'a',
          agendaItemStartTime: new Date(now - 30 * 60_000).toISOString(),
        },
      });

      render(<Scene meeting={meeting} />);

      // Advance a full hour — nothing should fire because the overrun had
      // already happened before the page loaded.
      vi.advanceTimersByTime(60 * 60_000);
      const overrunCalls = notificationCtor.mock.calls.filter(([title]) => title === 'Time limit reached');
      expect(overrunCalls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not fire "Time limit reached" when the onAgendaItemOverrun pref is off', () => {
    vi.useFakeTimers();
    try {
      seedPreferences({ enabled: true }); // default: onAgendaItemOverrun false
      const now = new Date('2026-04-19T10:00:00Z').getTime();
      vi.setSystemTime(now);
      const agenda = [{ id: 'a', name: 'Opening', ownerId: 'alice', timebox: 5 }];
      const meeting = makeMeeting({
        agenda,
        current: {
          topicSpeakers: [],
          agendaItemId: 'a',
          agendaItemStartTime: new Date(now).toISOString(),
        },
      });

      render(<Scene meeting={meeting} />);
      vi.advanceTimersByTime(5 * 60_000 + 1);

      const overrunCalls = notificationCtor.mock.calls.filter(([title]) => title === 'Time limit reached');
      expect(overrunCalls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('self-heals the top-level toggle when permission is revoked', () => {
    seedPreferences({ enabled: true });
    const prev = makeMeeting({});
    const { rerender } = render(<Scene meeting={prev} />);

    // Simulate the user revoking permission in browser settings.
    (Notification as unknown as { permission: NotificationPermission }).permission = 'denied';

    const next = makeMeeting({
      queue: {
        entries: { q1: { id: 'q1', type: 'topic', topic: 'anything', userId: 'bob' } },
        orderedIds: ['q1'],
        closed: false,
      },
    });
    rerender(<Scene meeting={next} />);

    // No event notifications fired.
    expect(notificationCtor).not.toHaveBeenCalled();
    // Preference self-healed to off — persisted to localStorage.
    expect(localStorage.getItem('tcq-notifications-enabled')).toBe('false');
  });
});
