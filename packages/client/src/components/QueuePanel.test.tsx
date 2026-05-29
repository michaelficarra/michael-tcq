import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type {
  CurrentContext,
  CurrentSpeaker,
  CurrentTopic,
  MeetingQueueState,
  MeetingState,
  QueueEntry,
  User,
} from '@tcq/shared';
import { QueuePanel } from './QueuePanel.js';
import { TestMeetingProvider } from '../test/TestMeetingProvider.js';
import { PreferencesProvider } from '../contexts/PreferencesContext.js';
import { makeMeeting as buildMeeting } from '../test/makeMeeting.js';
import { SocketContext, type TypedSocket } from '../contexts/SocketContext.js';

const chairUser: User = {
  provider: 'github',
  accountId: 'alice',
  handle: 'alice',
  name: 'Alice',
  organisation: 'ACME',
  avatarUrl: 'https://github.com/alice.png?size=80',
};

const otherUser: User = {
  provider: 'github',
  accountId: 'bob',
  handle: 'bob',
  name: 'Bob',
  organisation: 'Corp',
  avatarUrl: 'https://github.com/bob.png?size=80',
};

const TEST_TIME = '2026-01-01T00:00:00.000Z';

/** Build a queue subobject from entries + ordering. */
const queueOf = (entries: Record<string, QueueEntry>, orderedIds: string[], closed = false): MeetingQueueState => ({
  entries,
  orderedIds,
  closed,
});

/** Snapshot a queue-sourced CurrentSpeaker from a QueueEntry. */
const speakerOf = (entry: QueueEntry): CurrentSpeaker => ({
  id: entry.id,
  type: entry.type,
  topic: entry.topic,
  userId: entry.userId,
  source: 'queue',
  startTime: TEST_TIME,
});

/** Snapshot a CurrentTopic from the QueueEntry that introduced it. */
const topicOf = (entry: QueueEntry): CurrentTopic => ({
  speakerId: entry.id,
  userId: entry.userId,
  topic: entry.topic,
  startTime: TEST_TIME,
});

const currentOf = (overrides: Partial<CurrentContext> = {}): CurrentContext => ({ topicSpeakers: [], ...overrides });

function makeMeeting(overrides?: Partial<MeetingState>): MeetingState {
  return buildMeeting(overrides);
}

/** Render the QueuePanel with meeting context and optional socket. */
function renderQueue(meeting: MeetingState, user: User | null = null, socket: TypedSocket | null = null) {
  return render(
    <TestMeetingProvider meeting={meeting} user={user}>
      <PreferencesProvider>
        <SocketContext value={socket}>
          <QueuePanel
            autoEditEntryId={null}
            onAddEntry={() => {}}
            onSavedTopic={() => {}}
            onAutoEditConsumed={() => {}}
          />
        </SocketContext>
      </PreferencesProvider>
    </TestMeetingProvider>,
  );
}

describe('QueuePanel', () => {
  // -- Agenda item section --

  it('shows "Waiting for the meeting to start" when no current agenda item and the meeting has never been started', () => {
    renderQueue(makeMeeting());
    expect(screen.getByText(/waiting for the meeting to start/i)).toBeInTheDocument();
  });

  it('shows "Meeting concluded" in the past-final state (no current item, but startedAt is set)', () => {
    // `startedAt` distinguishes past-final from pre-start so the UI
    // doesn't fall back to the "Waiting…" copy when the chair has
    // already advanced past the final item.
    const meeting = makeMeeting({
      users: { 'github:alice': chairUser },
      chairIds: ['github:alice'],
      agenda: [{ kind: 'item', id: '1', name: 'Done', presenterIds: ['github:alice'], conclusion: 'wrap-up' }],
      current: currentOf({ startedAt: '2026-04-01T10:00:00.000Z' }),
    });
    renderQueue(meeting, chairUser);

    expect(screen.getByText(/meeting concluded/i)).toBeInTheDocument();
    expect(screen.queryByText(/waiting for the meeting to start/i)).not.toBeInTheDocument();
    // The Start Meeting button is a pre-start affordance and must not
    // be available once the meeting has already happened.
    expect(screen.queryByRole('button', { name: 'Start Meeting' })).not.toBeInTheDocument();
  });

  it('shows the current agenda item when set', () => {
    const meeting = makeMeeting({
      users: {
        'github:alice': {
          provider: 'github',
          accountId: 'alice',
          handle: 'alice',
          name: 'Alice',
          organisation: 'ACME',
          avatarUrl: 'https://github.com/alice.png?size=80',
        },
      },
      agenda: [
        {
          kind: 'item',
          id: 'item-1',
          name: 'Discussion of proposal',
          presenterIds: ['github:alice'],
          duration: 20,
        },
      ],
      current: currentOf({ agendaItemId: 'item-1' }),
    });
    renderQueue(meeting);

    expect(screen.getByText('Discussion of proposal')).toBeInTheDocument();
    expect(screen.getByText(/Alice/)).toBeInTheDocument();
    expect(screen.getByText('20m')).toBeInTheDocument();
  });

  it('shows all presenters for a multi-presenter current agenda item', () => {
    const alice = {
      provider: 'github',
      accountId: 'alice',
      handle: 'alice',
      name: 'Alice',
      organisation: 'A Corp',
      avatarUrl: 'https://github.com/alice.png?size=80',
    };
    const bob = {
      provider: 'github',
      accountId: 'bob',
      handle: 'bob',
      name: 'Bob',
      organisation: 'B Corp',
      avatarUrl: 'https://github.com/bob.png?size=80',
    };
    const meeting = makeMeeting({
      users: { 'github:alice': alice, 'github:bob': bob },
      agenda: [
        {
          kind: 'item',
          id: 'item-1',
          name: 'Joint session',
          presenterIds: ['github:alice', 'github:bob'],
        },
      ],
      current: currentOf({ agendaItemId: 'item-1' }),
    });
    renderQueue(meeting);

    expect(screen.getByText(/Alice/)).toBeInTheDocument();
    expect(screen.getByText(/Bob/)).toBeInTheDocument();
  });

  // -- Start Meeting button --

  it('shows "Start Meeting" button for chairs when meeting has not started', () => {
    const meeting = makeMeeting({
      users: { 'github:alice': chairUser },
      chairIds: ['github:alice'],
      agenda: [{ kind: 'item', id: '1', name: 'Item', presenterIds: ['github:alice'] }],
    });
    renderQueue(meeting, chairUser);

    expect(screen.getByRole('button', { name: 'Start Meeting' })).toBeInTheDocument();
  });

  it('hides "Start Meeting" button for non-chairs', () => {
    const meeting = makeMeeting({
      users: { 'github:bob': otherUser, 'github:alice': chairUser },
      chairIds: ['github:bob'],
      agenda: [{ kind: 'item', id: '1', name: 'Item', presenterIds: ['github:alice'] }],
    });
    renderQueue(meeting, chairUser);

    expect(screen.queryByRole('button', { name: 'Start Meeting' })).not.toBeInTheDocument();
  });

  it('hides "Start Meeting" button when agenda is empty', () => {
    const meeting = makeMeeting({ users: { 'github:alice': chairUser }, chairIds: ['github:alice'] });
    renderQueue(meeting, chairUser);

    expect(screen.queryByRole('button', { name: 'Start Meeting' })).not.toBeInTheDocument();
  });

  it('emits meeting:nextAgendaItem with version and ack when Start Meeting is clicked', () => {
    const emit = vi.fn();
    const mockSocket = { emit } as unknown as TypedSocket;

    const meeting = makeMeeting({
      users: { 'github:alice': chairUser },
      chairIds: ['github:alice'],
      agenda: [{ kind: 'item', id: '1', name: 'Item', presenterIds: ['github:alice'] }],
    });
    renderQueue(meeting, chairUser, mockSocket);

    fireEvent.click(screen.getByRole('button', { name: 'Start Meeting' }));
    expect(emit).toHaveBeenCalledWith('meeting:nextAgendaItem', { currentAgendaItemId: null }, expect.any(Function));
  });

  // -- Next Agenda Item button --

  it('shows "Next Agenda Item" button when there are more items', () => {
    const meeting = makeMeeting({
      users: { 'github:alice': chairUser },
      chairIds: ['github:alice'],
      agenda: [
        { kind: 'item', id: '1', name: 'First', presenterIds: ['github:alice'] },
        { kind: 'item', id: '2', name: 'Second', presenterIds: ['github:alice'] },
      ],
      current: currentOf({ agendaItemId: '1' }),
    });
    renderQueue(meeting, chairUser);

    expect(screen.getByRole('button', { name: 'Next Agenda Item' })).toBeInTheDocument();
  });

  it('shows "Conclude meeting" button on the last agenda item', () => {
    const meeting = makeMeeting({
      users: { 'github:alice': chairUser },
      chairIds: ['github:alice'],
      agenda: [{ kind: 'item', id: '1', name: 'Only', presenterIds: ['github:alice'] }],
      current: currentOf({ agendaItemId: '1' }),
    });
    renderQueue(meeting, chairUser);

    // The button is still present (chairs can advance past the final
    // item to record its conclusion) but labelled "Conclude meeting"
    // since there is no next item to step to.
    expect(screen.queryByRole('button', { name: 'Next Agenda Item' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Conclude meeting' })).toBeInTheDocument();
  });

  it('hides "Next Agenda Item" button for non-chairs', () => {
    const meeting = makeMeeting({
      users: { 'github:bob': otherUser, 'github:alice': chairUser },
      chairIds: ['github:bob'],
      agenda: [
        { kind: 'item', id: '1', name: 'First', presenterIds: ['github:alice'] },
        { kind: 'item', id: '2', name: 'Second', presenterIds: ['github:alice'] },
      ],
      current: currentOf({ agendaItemId: '1' }),
    });
    renderQueue(meeting, chairUser);

    expect(screen.queryByRole('button', { name: 'Next Agenda Item' })).not.toBeInTheDocument();
  });

  // -- Advance confirmation dialog (with conclusion textarea) --

  it('opens the advance dialog with an empty queue (always-show)', () => {
    const emit = vi.fn();
    const mockSocket = { emit } as unknown as TypedSocket;
    const meeting = makeMeeting({
      users: { 'github:alice': chairUser },
      chairIds: ['github:alice'],
      agenda: [
        { kind: 'item', id: '1', name: 'First', presenterIds: ['github:alice'] },
        { kind: 'item', id: '2', name: 'Second', presenterIds: ['github:alice'] },
      ],
      current: currentOf({ agendaItemId: '1' }),
    });
    renderQueue(meeting, chairUser, mockSocket);

    fireEvent.click(screen.getByRole('button', { name: 'Next Agenda Item' }));

    // Dialog appears even though the queue is empty.
    expect(screen.getByRole('dialog', { name: /confirm agenda advancement/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/conclusion/i)).toBeInTheDocument();
    expect(emit).not.toHaveBeenCalled();
  });

  it('hides the queue-clearing warning when the queue is empty', () => {
    const meeting = makeMeeting({
      users: { 'github:alice': chairUser },
      chairIds: ['github:alice'],
      agenda: [
        { kind: 'item', id: '1', name: 'First', presenterIds: ['github:alice'] },
        { kind: 'item', id: '2', name: 'Second', presenterIds: ['github:alice'] },
      ],
      current: currentOf({ agendaItemId: '1' }),
    });
    renderQueue(meeting, chairUser);

    fireEvent.click(screen.getByRole('button', { name: 'Next Agenda Item' }));
    expect(screen.queryByText(/clear the speaker queue/i)).not.toBeInTheDocument();
  });

  it('shows the queue-clearing warning when the queue is non-empty', () => {
    const meeting = makeMeeting({
      users: { 'github:alice': chairUser },
      chairIds: ['github:alice'],
      agenda: [
        { kind: 'item', id: '1', name: 'First', presenterIds: ['github:alice'] },
        { kind: 'item', id: '2', name: 'Second', presenterIds: ['github:alice'] },
      ],
      current: currentOf({ agendaItemId: '1' }),
      queue: queueOf({ q1: { id: 'q1', type: 'topic', topic: 'pending', userId: 'github:alice' } }, ['q1']),
    });
    renderQueue(meeting, chairUser);

    fireEvent.click(screen.getByRole('button', { name: 'Next Agenda Item' }));
    expect(screen.getByText(/clear the speaker queue/i)).toBeInTheDocument();
  });

  it('auto-focuses the conclusion textarea when the dialog opens', () => {
    const meeting = makeMeeting({
      users: { 'github:alice': chairUser },
      chairIds: ['github:alice'],
      agenda: [
        { kind: 'item', id: '1', name: 'First', presenterIds: ['github:alice'] },
        { kind: 'item', id: '2', name: 'Second', presenterIds: ['github:alice'] },
      ],
      current: currentOf({ agendaItemId: '1' }),
    });
    renderQueue(meeting, chairUser);

    fireEvent.click(screen.getByRole('button', { name: 'Next Agenda Item' }));
    expect(screen.getByLabelText(/conclusion/i)).toHaveFocus();
  });

  it('seeds the conclusion textarea from the current item’s saved conclusion (revisit case)', () => {
    const meeting = makeMeeting({
      users: { 'github:alice': chairUser },
      chairIds: ['github:alice'],
      agenda: [
        { kind: 'item', id: '1', name: 'First', presenterIds: ['github:alice'], conclusion: 'previously decided' },
        { kind: 'item', id: '2', name: 'Second', presenterIds: ['github:alice'] },
      ],
      current: currentOf({ agendaItemId: '1' }),
    });
    renderQueue(meeting, chairUser);

    fireEvent.click(screen.getByRole('button', { name: 'Next Agenda Item' }));
    const textarea = screen.getByLabelText(/conclusion/i) as HTMLTextAreaElement;
    expect(textarea.value).toBe('previously decided');
  });

  it('emits meeting:nextAgendaItem with the conclusion when Advance is clicked', () => {
    const emit = vi.fn();
    const mockSocket = { emit } as unknown as TypedSocket;
    const meeting = makeMeeting({
      users: { 'github:alice': chairUser },
      chairIds: ['github:alice'],
      agenda: [
        { kind: 'item', id: '1', name: 'First', presenterIds: ['github:alice'] },
        { kind: 'item', id: '2', name: 'Second', presenterIds: ['github:alice'] },
      ],
      current: currentOf({ agendaItemId: '1' }),
    });
    renderQueue(meeting, chairUser, mockSocket);

    fireEvent.click(screen.getByRole('button', { name: 'Next Agenda Item' }));
    const textarea = screen.getByLabelText(/conclusion/i);
    fireEvent.change(textarea, { target: { value: 'agreed to revisit next week' } });
    fireEvent.click(screen.getByRole('button', { name: 'Advance' }));

    expect(emit).toHaveBeenCalledWith(
      'meeting:nextAgendaItem',
      { currentAgendaItemId: '1', conclusion: 'agreed to revisit next week' },
      expect.any(Function),
    );
  });

  it('advances on Ctrl+Enter in the conclusion textarea', () => {
    const emit = vi.fn();
    const mockSocket = { emit } as unknown as TypedSocket;
    const meeting = makeMeeting({
      users: { 'github:alice': chairUser },
      chairIds: ['github:alice'],
      agenda: [
        { kind: 'item', id: '1', name: 'First', presenterIds: ['github:alice'] },
        { kind: 'item', id: '2', name: 'Second', presenterIds: ['github:alice'] },
      ],
      current: currentOf({ agendaItemId: '1' }),
    });
    renderQueue(meeting, chairUser, mockSocket);

    fireEvent.click(screen.getByRole('button', { name: 'Next Agenda Item' }));
    const textarea = screen.getByLabelText(/conclusion/i);
    fireEvent.change(textarea, { target: { value: 'decided via keyboard' } });
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });

    expect(emit).toHaveBeenCalledWith(
      'meeting:nextAgendaItem',
      { currentAgendaItemId: '1', conclusion: 'decided via keyboard' },
      expect.any(Function),
    );
  });

  it('advances on Cmd+Enter in the conclusion textarea', () => {
    const emit = vi.fn();
    const mockSocket = { emit } as unknown as TypedSocket;
    const meeting = makeMeeting({
      users: { 'github:alice': chairUser },
      chairIds: ['github:alice'],
      agenda: [
        { kind: 'item', id: '1', name: 'First', presenterIds: ['github:alice'] },
        { kind: 'item', id: '2', name: 'Second', presenterIds: ['github:alice'] },
      ],
      current: currentOf({ agendaItemId: '1' }),
    });
    renderQueue(meeting, chairUser, mockSocket);

    fireEvent.click(screen.getByRole('button', { name: 'Next Agenda Item' }));
    const textarea = screen.getByLabelText(/conclusion/i);
    fireEvent.change(textarea, { target: { value: 'decided via meta key' } });
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });

    expect(emit).toHaveBeenCalledWith(
      'meeting:nextAgendaItem',
      { currentAgendaItemId: '1', conclusion: 'decided via meta key' },
      expect.any(Function),
    );
  });

  it('does not advance on bare Enter in the conclusion textarea', () => {
    const emit = vi.fn();
    const mockSocket = { emit } as unknown as TypedSocket;
    const meeting = makeMeeting({
      users: { 'github:alice': chairUser },
      chairIds: ['github:alice'],
      agenda: [
        { kind: 'item', id: '1', name: 'First', presenterIds: ['github:alice'] },
        { kind: 'item', id: '2', name: 'Second', presenterIds: ['github:alice'] },
      ],
      current: currentOf({ agendaItemId: '1' }),
    });
    renderQueue(meeting, chairUser, mockSocket);

    fireEvent.click(screen.getByRole('button', { name: 'Next Agenda Item' }));
    const textarea = screen.getByLabelText(/conclusion/i);
    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(emit).not.toHaveBeenCalled();
  });

  it('does not emit when Cancel is clicked', () => {
    const emit = vi.fn();
    const mockSocket = { emit } as unknown as TypedSocket;
    const meeting = makeMeeting({
      users: { 'github:alice': chairUser },
      chairIds: ['github:alice'],
      agenda: [
        { kind: 'item', id: '1', name: 'First', presenterIds: ['github:alice'] },
        { kind: 'item', id: '2', name: 'Second', presenterIds: ['github:alice'] },
      ],
      current: currentOf({ agendaItemId: '1' }),
    });
    renderQueue(meeting, chairUser, mockSocket);

    fireEvent.click(screen.getByRole('button', { name: 'Next Agenda Item' }));
    fireEvent.change(screen.getByLabelText(/conclusion/i), { target: { value: 'do not save me' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(emit).not.toHaveBeenCalled();
  });

  // -- Current speaker section --

  it('shows "Nobody speaking yet" when there is no current speaker', () => {
    renderQueue(makeMeeting());
    expect(screen.getByText(/nobody speaking yet/i)).toBeInTheDocument();
  });

  it('shows the current speaker when set', () => {
    const entry: QueueEntry = { id: 'entry-1', type: 'topic', topic: 'My proposal', userId: 'github:bob' };
    const meeting = makeMeeting({
      users: { 'github:bob': otherUser },
      current: currentOf({ speaker: speakerOf(entry) }),
    });
    renderQueue(meeting);

    expect(screen.getByText(/Bob/)).toBeInTheDocument();
    expect(screen.getByText('My proposal')).toBeInTheDocument();
  });

  // -- Current topic section --

  it('shows the current topic section when a topic is active', () => {
    const ct: QueueEntry = { id: 'ct-1', type: 'topic', topic: 'Active discussion point', userId: 'github:alice' };
    const meeting = makeMeeting({
      users: { 'github:alice': chairUser },
      current: currentOf({ topic: topicOf(ct) }),
    });
    renderQueue(meeting);

    expect(screen.getByText('Active discussion point')).toBeInTheDocument();
    expect(screen.getByText('Topic')).toBeInTheDocument();
  });

  // -- Count-up timers --

  it('shows a timer for the current agenda item', () => {
    const meeting = makeMeeting({
      users: { 'github:alice': chairUser },
      agenda: [{ kind: 'item', id: '1', name: 'Item', presenterIds: ['github:alice'] }],
      current: currentOf({
        agendaItemId: '1',
        agendaItemStartTime: new Date(Date.now() - 125_000).toISOString(),
      }),
    });
    renderQueue(meeting);
    expect(screen.getByText('2:05')).toBeInTheDocument();
  });

  it('shows a timer for the current speaker', () => {
    const entry: QueueEntry = { id: 's1', type: 'topic', topic: 'Test', userId: 'github:alice' };
    const meeting = makeMeeting({
      users: { 'github:alice': chairUser },
      current: currentOf({
        speaker: speakerOf(entry),
        topicSpeakers: [
          {
            userId: 'github:alice',
            type: 'topic',
            topic: 'Test',
            startTime: new Date(Date.now() - 65_000).toISOString(),
          },
        ],
      }),
    });
    renderQueue(meeting);
    expect(screen.getByText('1:05')).toBeInTheDocument();
  });

  // -- Speaker queue --

  it('shows "The queue is empty" when there are no queued speakers', () => {
    renderQueue(makeMeeting());
    expect(screen.getByText(/queue is empty/i)).toBeInTheDocument();
  });

  it('displays queued speakers with type labels and position numbers', () => {
    const meeting = makeMeeting({
      users: {
        'github:carol': {
          provider: 'github',
          accountId: 'carol',
          handle: 'carol',
          name: 'Carol',
          organisation: '',
          avatarUrl: 'https://github.com/carol.png?size=80',
        },
        'github:dave': {
          provider: 'github',
          accountId: 'dave',
          handle: 'dave',
          name: 'Dave',
          organisation: 'Inc',
          avatarUrl: 'https://github.com/dave.png?size=80',
        },
      },
      queue: queueOf(
        {
          q1: { id: 'q1', type: 'question', topic: 'How does this work?', userId: 'github:carol' },
          q2: { id: 'q2', type: 'topic', topic: 'Alternative approach', userId: 'github:dave' },
        },
        ['q1', 'q2'],
      ),
    });
    renderQueue(meeting);

    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText(/Clarifying Question:/)).toBeInTheDocument();
    expect(screen.getByText(/New Topic:/)).toBeInTheDocument();
    expect(screen.getByText('How does this work?')).toBeInTheDocument();
    expect(screen.getByText('Alternative approach')).toBeInTheDocument();
  });

  // -- Next Speaker button --

  it('shows "Next Speaker" button for chairs when there is a current speaker', () => {
    const entry: QueueEntry = { id: 's1', type: 'topic', topic: 'Topic', userId: 'github:bob' };
    const meeting = makeMeeting({
      users: { 'github:alice': chairUser, 'github:bob': otherUser },
      chairIds: ['github:alice'],
      current: currentOf({ speaker: speakerOf(entry) }),
    });
    renderQueue(meeting, chairUser);
    expect(screen.getByRole('button', { name: 'Next Speaker' })).toBeInTheDocument();
  });

  it('shows "Next Speaker" for chairs when nobody is speaking but queue has entries', () => {
    const q1: QueueEntry = { id: 'q1', type: 'topic', topic: 'Waiting', userId: 'github:bob' };
    const meeting = makeMeeting({
      users: { 'github:alice': chairUser, 'github:bob': otherUser },
      chairIds: ['github:alice'],
      queue: queueOf({ q1 }, ['q1']),
    });
    renderQueue(meeting, chairUser);
    expect(screen.getByRole('button', { name: 'Next Speaker' })).toBeInTheDocument();
  });

  it('hides "Next Speaker" for non-chairs', () => {
    const entry: QueueEntry = { id: 's1', type: 'topic', topic: 'Topic', userId: 'github:bob' };
    const meeting = makeMeeting({
      users: { 'github:bob': otherUser },
      chairIds: ['github:bob'],
      current: currentOf({ speaker: speakerOf(entry) }),
    });
    renderQueue(meeting, chairUser);
    expect(screen.queryByRole('button', { name: 'Next Speaker' })).not.toBeInTheDocument();
  });

  it('emits queue:next with version and ack when Next Speaker is clicked', () => {
    const emit = vi.fn();
    const mockSocket = { emit } as unknown as TypedSocket;

    const speakerEntry: QueueEntry = { id: 's1', type: 'topic', topic: 'Topic', userId: 'github:bob' };
    const topicEntry: QueueEntry = { id: 'topic-123', type: 'topic', topic: 'Topic', userId: 'github:bob' };
    const meeting = makeMeeting({
      users: { 'github:alice': chairUser, 'github:bob': otherUser },
      chairIds: ['github:alice'],
      current: currentOf({
        speaker: speakerOf(speakerEntry),
        topic: topicOf(topicEntry),
      }),
    });
    renderQueue(meeting, chairUser, mockSocket);

    fireEvent.click(screen.getByRole('button', { name: 'Next Speaker' }));
    expect(emit).toHaveBeenCalledWith('queue:next', { currentSpeakerEntryId: 's1' }, expect.any(Function));
  });

  // -- Delete buttons on queue entries --

  it('shows delete button on own queue entries', () => {
    const meeting = makeMeeting({
      users: { 'github:alice': chairUser },
      queue: queueOf({ q1: { id: 'q1', type: 'topic', topic: 'My entry', userId: 'github:alice' } }, ['q1']),
    });
    renderQueue(meeting, chairUser);
    expect(screen.getByRole('button', { name: /delete entry: my entry/i })).toBeInTheDocument();
  });

  it('shows delete button on all entries for chairs', () => {
    const meeting = makeMeeting({
      users: { 'github:alice': chairUser, 'github:bob': otherUser },
      chairIds: ['github:alice'],
      queue: queueOf({ q1: { id: 'q1', type: 'topic', topic: 'Other entry', userId: 'github:bob' } }, ['q1']),
    });
    renderQueue(meeting, chairUser);
    expect(screen.getByRole('button', { name: /delete entry/i })).toBeInTheDocument();
  });

  it('hides delete button on other users entries for non-chairs', () => {
    const meeting = makeMeeting({
      users: { 'github:bob': otherUser },
      chairIds: ['github:bob'],
      queue: queueOf({ q1: { id: 'q1', type: 'topic', topic: 'Not mine', userId: 'github:bob' } }, ['q1']),
    });
    renderQueue(meeting, chairUser);
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
  });

  it('emits queue:remove when delete button is clicked', () => {
    const emit = vi.fn();
    const mockSocket = { emit } as unknown as TypedSocket;

    const meeting = makeMeeting({
      users: { 'github:alice': chairUser },
      queue: queueOf({ 'entry-42': { id: 'entry-42', type: 'topic', topic: 'Remove me', userId: 'github:alice' } }, [
        'entry-42',
      ]),
    });
    renderQueue(meeting, chairUser, mockSocket);

    fireEvent.click(screen.getByRole('button', { name: /delete entry: remove me/i }));
    expect(emit).toHaveBeenCalledWith('queue:remove', { id: 'entry-42' });
  });

  // -- Cancel/Escape on new entry --

  it('removes new entry when Cancel is clicked with unmodified text', () => {
    const emit = vi.fn();
    const mockSocket = { emit } as unknown as TypedSocket;

    const meeting = makeMeeting({
      users: { 'github:alice': chairUser },
      queue: queueOf({ q1: { id: 'q1', type: 'topic', topic: 'New topic', userId: 'github:alice', pending: true } }, [
        'q1',
      ]),
    });
    renderQueue(meeting, chairUser, mockSocket);

    // Simulate auto-edit on a newly created entry — the QueuePanel receives
    // autoEditEntryId which triggers initialEditing on the matching entry.
    // For this test, we re-render with autoEditEntryId set.
    const { unmount } = render(
      <TestMeetingProvider meeting={meeting} user={chairUser}>
        <PreferencesProvider>
          <SocketContext value={mockSocket}>
            <QueuePanel
              autoEditEntryId="q1"
              onAddEntry={() => {}}
              onSavedTopic={() => {}}
              onAutoEditConsumed={() => {}}
            />
          </SocketContext>
        </PreferencesProvider>
      </TestMeetingProvider>,
    );

    // The entry should be in edit mode with the placeholder text
    const input = screen.getAllByLabelText('Topic description')[0];
    expect(input).toHaveValue('New topic');

    // Click Cancel without modifying text — should delete the entry
    const cancelBtn = screen.getAllByText('Cancel')[0];
    fireEvent.click(cancelBtn);
    expect(emit).toHaveBeenCalledWith('queue:remove', { id: 'q1' });

    unmount();
  });

  it('removes new entry when Cancel is clicked even after modifying text', () => {
    const emit = vi.fn();
    const mockSocket = { emit } as unknown as TypedSocket;

    const meeting = makeMeeting({
      users: { 'github:alice': chairUser },
      queue: queueOf({ q1: { id: 'q1', type: 'topic', topic: 'New topic', userId: 'github:alice', pending: true } }, [
        'q1',
      ]),
    });

    render(
      <TestMeetingProvider meeting={meeting} user={chairUser}>
        <PreferencesProvider>
          <SocketContext value={mockSocket}>
            <QueuePanel
              autoEditEntryId="q1"
              onAddEntry={() => {}}
              onSavedTopic={() => {}}
              onAutoEditConsumed={() => {}}
            />
          </SocketContext>
        </PreferencesProvider>
      </TestMeetingProvider>,
    );

    // Modify the text
    const input = screen.getByLabelText('Topic description');
    fireEvent.change(input, { target: { value: 'Modified text' } });

    // Click Cancel — should still delete the entry since it's a new entry
    fireEvent.click(screen.getByText('Cancel'));
    expect(emit).toHaveBeenCalledWith('queue:remove', { id: 'q1' });
  });

  it('removes new entry when Escape is pressed with unmodified text', () => {
    const emit = vi.fn();
    const mockSocket = { emit } as unknown as TypedSocket;

    const meeting = makeMeeting({
      users: { 'github:alice': chairUser },
      queue: queueOf({ q1: { id: 'q1', type: 'topic', topic: 'New topic', userId: 'github:alice', pending: true } }, [
        'q1',
      ]),
    });

    render(
      <TestMeetingProvider meeting={meeting} user={chairUser}>
        <PreferencesProvider>
          <SocketContext value={mockSocket}>
            <QueuePanel
              autoEditEntryId="q1"
              onAddEntry={() => {}}
              onSavedTopic={() => {}}
              onAutoEditConsumed={() => {}}
            />
          </SocketContext>
        </PreferencesProvider>
      </TestMeetingProvider>,
    );

    // Press Escape without modifying text — should delete the entry
    const input = screen.getByLabelText('Topic description');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(emit).toHaveBeenCalledWith('queue:remove', { id: 'q1' });
  });

  // -- Type badge (cycling) --

  it('shows a clickable type badge for chairs', () => {
    const meeting = makeMeeting({
      users: { 'github:alice': chairUser, 'github:bob': otherUser },
      chairIds: ['github:alice'],
      queue: queueOf({ q1: { id: 'q1', type: 'topic', topic: 'Test', userId: 'github:bob' } }, ['q1']),
    });
    renderQueue(meeting, chairUser);

    expect(screen.getByRole('button', { name: /change type/i })).toBeInTheDocument();
  });

  it('does not show a clickable type badge for participants on their own entries', () => {
    const meeting = makeMeeting({
      users: { 'github:alice': chairUser, 'github:bob': otherUser },
      chairIds: ['github:alice'],
      queue: queueOf({ q1: { id: 'q1', type: 'topic', topic: 'My entry', userId: 'github:bob' } }, ['q1']),
    });
    renderQueue(meeting, otherUser);

    expect(screen.queryByRole('button', { name: /change type/i })).not.toBeInTheDocument();
  });

  // -- Drag-and-drop reorder handles --

  it('shows drag handles for chairs', () => {
    const meeting = makeMeeting({
      users: { 'github:alice': chairUser, 'github:bob': otherUser },
      chairIds: ['github:alice'],
      queue: queueOf(
        {
          q1: { id: 'q1', type: 'topic', topic: 'First', userId: 'github:bob' },
          q2: { id: 'q2', type: 'topic', topic: 'Second', userId: 'github:bob' },
        },
        ['q1', 'q2'],
      ),
    });
    renderQueue(meeting, chairUser);

    // Each entry should have a drag handle with an accessible label
    expect(screen.getByLabelText(/drag to reorder: first/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/drag to reorder: second/i)).toBeInTheDocument();
  });

  it('hides drag handles for non-chairs', () => {
    const meeting = makeMeeting({
      users: { 'github:bob': otherUser },
      chairIds: ['github:bob'],
      queue: queueOf({ q1: { id: 'q1', type: 'topic', topic: 'First', userId: 'github:bob' } }, ['q1']),
    });
    renderQueue(meeting, chairUser);

    expect(screen.queryByLabelText(/drag to reorder/i)).not.toBeInTheDocument();
  });

  // -- Drag-handle cursor: chair --
  // The cursor reflects the directions the entry may actually move in.

  it('shows ns-resize on a chair drag handle for a middle entry', () => {
    const meeting = makeMeeting({
      users: { 'github:alice': chairUser, 'github:bob': otherUser },
      chairIds: ['github:alice'],
      queue: queueOf(
        {
          q1: { id: 'q1', type: 'topic', topic: 'First', userId: 'github:bob' },
          q2: { id: 'q2', type: 'topic', topic: 'Middle', userId: 'github:bob' },
          q3: { id: 'q3', type: 'topic', topic: 'Last', userId: 'github:bob' },
        },
        ['q1', 'q2', 'q3'],
      ),
    });
    renderQueue(meeting, chairUser);

    const handle = screen.getByLabelText(/drag to reorder: middle/i);
    expect(handle.className).toMatch(/cursor-ns-resize/);
    expect(handle.className).not.toMatch(/cursor-n-resize\b/);
    expect(handle.className).not.toMatch(/cursor-s-resize\b/);
  });

  it('shows s-resize on a chair drag handle for the top entry', () => {
    const meeting = makeMeeting({
      users: { 'github:alice': chairUser, 'github:bob': otherUser },
      chairIds: ['github:alice'],
      queue: queueOf(
        {
          q1: { id: 'q1', type: 'topic', topic: 'Top', userId: 'github:bob' },
          q2: { id: 'q2', type: 'topic', topic: 'Bottom', userId: 'github:bob' },
        },
        ['q1', 'q2'],
      ),
    });
    renderQueue(meeting, chairUser);

    const handle = screen.getByLabelText(/drag to reorder: top/i);
    expect(handle.className).toMatch(/cursor-s-resize/);
    expect(handle.className).not.toMatch(/cursor-ns-resize/);
  });

  it('shows n-resize on a chair drag handle for the bottom entry', () => {
    const meeting = makeMeeting({
      users: { 'github:alice': chairUser, 'github:bob': otherUser },
      chairIds: ['github:alice'],
      queue: queueOf(
        {
          q1: { id: 'q1', type: 'topic', topic: 'Top', userId: 'github:bob' },
          q2: { id: 'q2', type: 'topic', topic: 'Bottom', userId: 'github:bob' },
        },
        ['q1', 'q2'],
      ),
    });
    renderQueue(meeting, chairUser);

    const handle = screen.getByLabelText(/drag to reorder: bottom/i);
    expect(handle.className).toMatch(/cursor-n-resize/);
    expect(handle.className).not.toMatch(/cursor-ns-resize/);
  });

  it('hides the chair drag handle on a single-entry queue (no valid moves)', () => {
    const meeting = makeMeeting({
      users: { 'github:alice': chairUser, 'github:bob': otherUser },
      chairIds: ['github:alice'],
      queue: queueOf({ q1: { id: 'q1', type: 'topic', topic: 'Only', userId: 'github:bob' } }, ['q1']),
    });
    renderQueue(meeting, chairUser);

    expect(screen.queryByLabelText(/drag to reorder/i)).not.toBeInTheDocument();
  });

  // -- Drag-handle cursor: non-chair owner --

  it('shows ns-resize on a non-chair drag handle when own is above and something is below', () => {
    // [other, mine, mine, other] — viewer is bob (non-chair). The middle
    // own entry has bob's own entry directly above and an other-user entry
    // below, so it can move both up (within its own block) and down.
    const meeting = makeMeeting({
      users: { 'github:alice': chairUser, 'github:bob': otherUser },
      chairIds: ['github:alice'],
      queue: queueOf(
        {
          q1: { id: 'q1', type: 'topic', topic: 'AliceTop', userId: 'github:alice' },
          q2: { id: 'q2', type: 'topic', topic: 'BobOne', userId: 'github:bob' },
          q3: { id: 'q3', type: 'topic', topic: 'BobTwo', userId: 'github:bob' },
          q4: { id: 'q4', type: 'topic', topic: 'AliceBottom', userId: 'github:alice' },
        },
        ['q1', 'q2', 'q3', 'q4'],
      ),
    });
    renderQueue(meeting, otherUser);

    const handle = screen.getByLabelText(/drag to reorder: bobtwo/i);
    expect(handle.className).toMatch(/cursor-ns-resize/);
  });

  it('shows s-resize on a non-chair drag handle when no own is above but something is below', () => {
    // [other, mine, other] — bob's only own entry has alice's entry above
    // (no upward movement allowed) and alice's entry below (can defer).
    const meeting = makeMeeting({
      users: { 'github:alice': chairUser, 'github:bob': otherUser },
      chairIds: ['github:alice'],
      queue: queueOf(
        {
          q1: { id: 'q1', type: 'topic', topic: 'AliceTop', userId: 'github:alice' },
          q2: { id: 'q2', type: 'topic', topic: 'BobMid', userId: 'github:bob' },
          q3: { id: 'q3', type: 'topic', topic: 'AliceBottom', userId: 'github:alice' },
        },
        ['q1', 'q2', 'q3'],
      ),
    });
    renderQueue(meeting, otherUser);

    const handle = screen.getByLabelText(/drag to reorder: bobmid/i);
    expect(handle.className).toMatch(/cursor-s-resize/);
    expect(handle.className).not.toMatch(/cursor-ns-resize/);
  });

  it('shows n-resize on a non-chair drag handle when own is above and nothing is below', () => {
    // [mine, mine] at the bottom — bob may move up within his block but
    // there's nothing below to defer to.
    const meeting = makeMeeting({
      users: { 'github:alice': chairUser, 'github:bob': otherUser },
      chairIds: ['github:alice'],
      queue: queueOf(
        {
          q1: { id: 'q1', type: 'topic', topic: 'BobOne', userId: 'github:bob' },
          q2: { id: 'q2', type: 'topic', topic: 'BobTwo', userId: 'github:bob' },
        },
        ['q1', 'q2'],
      ),
    });
    renderQueue(meeting, otherUser);

    const handle = screen.getByLabelText(/drag to reorder: bobtwo/i);
    expect(handle.className).toMatch(/cursor-n-resize/);
    expect(handle.className).not.toMatch(/cursor-ns-resize/);
  });

  it('hides the non-chair drag handle when no own is above and nothing is below', () => {
    // [other, mine] — bob's only own entry is at the bottom under alice's.
    // No move is possible, so the handle is hidden entirely.
    const meeting = makeMeeting({
      users: { 'github:alice': chairUser, 'github:bob': otherUser },
      chairIds: ['github:alice'],
      queue: queueOf(
        {
          q1: { id: 'q1', type: 'topic', topic: 'AliceTop', userId: 'github:alice' },
          q2: { id: 'q2', type: 'topic', topic: 'BobLast', userId: 'github:bob' },
        },
        ['q1', 'q2'],
      ),
    });
    renderQueue(meeting, otherUser);

    expect(screen.queryByLabelText(/drag to reorder: boblast/i)).not.toBeInTheDocument();
  });

  it('hides the non-chair drag handle when the queue contains only their entry', () => {
    const meeting = makeMeeting({
      users: { 'github:alice': chairUser, 'github:bob': otherUser },
      chairIds: ['github:alice'],
      queue: queueOf({ q1: { id: 'q1', type: 'topic', topic: 'BobOnly', userId: 'github:bob' } }, ['q1']),
    });
    renderQueue(meeting, otherUser);

    expect(screen.queryByLabelText(/drag to reorder/i)).not.toBeInTheDocument();
  });

  // -- Accessibility --

  it('has accessible section headings', () => {
    renderQueue(makeMeeting());
    expect(screen.getByText('Agenda Item')).toBeInTheDocument();
    expect(screen.getByText('Speaking')).toBeInTheDocument();
    expect(screen.getByText('Speaker Queue')).toBeInTheDocument();
  });

  // -- Queue closed message --

  it('shows the queue-closed message at the bottom of the speaker queue for non-chairs', () => {
    renderQueue(makeMeeting({ queue: queueOf({}, [], true) }), otherUser);
    expect(screen.getByText('The queue is closed. You can still raise a Point of Order.')).toBeInTheDocument();
  });

  it('does not show closed message when user is a chair', () => {
    renderQueue(makeMeeting({ queue: queueOf({}, [], true), chairIds: ['github:alice'] }), chairUser);
    expect(screen.queryByText(/queue is closed/i)).not.toBeInTheDocument();
  });

  // -- Premium-tier border --

  it('applies the premium-border class to the outer <li> when the entry owner is premium', () => {
    const meeting = makeMeeting({
      users: { 'github:alice': chairUser, 'github:bob': { ...otherUser, isPremium: true } },
      chairIds: ['github:alice'],
      agenda: [{ kind: 'item', id: 'item-1', name: 'Item 1', presenterIds: ['github:alice'] }],
      current: currentOf({ agendaItemId: 'item-1' }),
      queue: queueOf({ q1: { id: 'q1', type: 'topic', topic: 'Premium pitch', userId: 'github:bob' } }, ['q1']),
    });
    renderQueue(meeting, chairUser);

    const li = screen.getByText('Premium pitch').closest('li');
    expect(li).not.toBeNull();
    expect(li!.className).toMatch(/\bpremium-border\b/);
  });

  it('does not apply the premium-border class when the entry owner is not premium', () => {
    const meeting = makeMeeting({
      users: { 'github:alice': chairUser, 'github:bob': otherUser },
      chairIds: ['github:alice'],
      agenda: [{ kind: 'item', id: 'item-1', name: 'Item 1', presenterIds: ['github:alice'] }],
      current: currentOf({ agendaItemId: 'item-1' }),
      queue: queueOf({ q1: { id: 'q1', type: 'topic', topic: 'Plain pitch', userId: 'github:bob' } }, ['q1']),
    });
    renderQueue(meeting, chairUser);

    const li = screen.getByText('Plain pitch').closest('li');
    expect(li).not.toBeNull();
    expect(li!.className).not.toMatch(/premium-border/);
  });
});
