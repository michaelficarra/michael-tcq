import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { MeetingState, User } from '@tcq/shared';
import { QueuePanel } from './QueuePanel.js';
import { TestMeetingProvider } from '../test/TestMeetingProvider.js';
import { SocketContext, type TypedSocket } from '../contexts/SocketContext.js';

const chairUser: User = {
  ghid: 1,
  ghUsername: 'alice',
  name: 'Alice',
  organisation: 'ACME',
};

const otherUser: User = {
  ghid: 2,
  ghUsername: 'bob',
  name: 'Bob',
  organisation: 'Corp',
};

/** Create a minimal meeting state for testing. */
function makeMeeting(overrides?: Partial<MeetingState>): MeetingState {
  return {
    id: 'test-meeting',
    users: {},
    chairIds: [],
    agenda: [],
    currentAgendaItemId: undefined,
    currentSpeakerEntryId: undefined,
    currentTopicEntryId: undefined,
    queueEntries: {},
    queuedSpeakerIds: [],
    reactions: [],
    trackPoll: false,
    pollOptions: [],
    version: 0,
    log: [],
    currentTopicSpeakers: [],
    ...overrides,
  };
}

/** Render the QueuePanel with meeting context and optional socket. */
function renderQueue(meeting: MeetingState, user: User | null = null, socket: TypedSocket | null = null) {
  return render(
    <TestMeetingProvider meeting={meeting} user={user}>
      <SocketContext value={socket}>
        <QueuePanel autoEditEntryId={null} onAddEntry={() => {}} onAutoEditConsumed={() => {}} />
      </SocketContext>
    </TestMeetingProvider>,
  );
}

describe('QueuePanel', () => {
  // -- Agenda item section --

  it('shows "Waiting for the meeting to start" when no current agenda item', () => {
    renderQueue(makeMeeting());
    expect(screen.getByText(/waiting for the meeting to start/i)).toBeInTheDocument();
  });

  it('shows the current agenda item when set', () => {
    const meeting = makeMeeting({
      users: { alice: { ghid: 1, ghUsername: 'alice', name: 'Alice', organisation: 'ACME' } },
      agenda: [
        {
          id: 'item-1',
          name: 'Discussion of proposal',
          ownerId: 'alice',
          timebox: 20,
        },
      ],
      currentAgendaItemId: 'item-1',
    });
    renderQueue(meeting);

    expect(screen.getByText('Discussion of proposal')).toBeInTheDocument();
    expect(screen.getByText(/Alice/)).toBeInTheDocument();
    expect(screen.getByText(/20 minutes/)).toBeInTheDocument();
  });

  // -- Start Meeting button --

  it('shows "Start Meeting" button for chairs when meeting has not started', () => {
    const meeting = makeMeeting({
      users: { alice: chairUser },
      chairIds: ['alice'],
      agenda: [{ id: '1', name: 'Item', ownerId: 'alice' }],
    });
    renderQueue(meeting, chairUser);

    expect(screen.getByRole('button', { name: 'Start Meeting' })).toBeInTheDocument();
  });

  it('hides "Start Meeting" button for non-chairs', () => {
    const meeting = makeMeeting({
      users: { bob: otherUser, alice: chairUser },
      chairIds: ['bob'],
      agenda: [{ id: '1', name: 'Item', ownerId: 'alice' }],
    });
    renderQueue(meeting, chairUser);

    expect(screen.queryByRole('button', { name: 'Start Meeting' })).not.toBeInTheDocument();
  });

  it('hides "Start Meeting" button when agenda is empty', () => {
    const meeting = makeMeeting({ users: { alice: chairUser }, chairIds: ['alice'] });
    renderQueue(meeting, chairUser);

    expect(screen.queryByRole('button', { name: 'Start Meeting' })).not.toBeInTheDocument();
  });

  it('emits meeting:nextAgendaItem with version and ack when Start Meeting is clicked', () => {
    const emit = vi.fn();
    const mockSocket = { emit } as unknown as TypedSocket;

    const meeting = makeMeeting({
      users: { alice: chairUser },
      chairIds: ['alice'],
      agenda: [{ id: '1', name: 'Item', ownerId: 'alice' }],
    });
    renderQueue(meeting, chairUser, mockSocket);

    fireEvent.click(screen.getByRole('button', { name: 'Start Meeting' }));
    expect(emit).toHaveBeenCalledWith('meeting:nextAgendaItem', { currentAgendaItemId: null }, expect.any(Function));
  });

  // -- Next Agenda Item button --

  it('shows "Next Agenda Item" button when there are more items', () => {
    const meeting = makeMeeting({
      users: { alice: chairUser },
      chairIds: ['alice'],
      agenda: [
        { id: '1', name: 'First', ownerId: 'alice' },
        { id: '2', name: 'Second', ownerId: 'alice' },
      ],
      currentAgendaItemId: '1',
    });
    renderQueue(meeting, chairUser);

    expect(screen.getByRole('button', { name: 'Next Agenda Item' })).toBeInTheDocument();
  });

  it('hides "Next Agenda Item" button on the last agenda item', () => {
    const meeting = makeMeeting({
      users: { alice: chairUser },
      chairIds: ['alice'],
      agenda: [{ id: '1', name: 'Only', ownerId: 'alice' }],
      currentAgendaItemId: '1',
    });
    renderQueue(meeting, chairUser);

    expect(screen.queryByRole('button', { name: 'Next Agenda Item' })).not.toBeInTheDocument();
  });

  it('hides "Next Agenda Item" button for non-chairs', () => {
    const meeting = makeMeeting({
      users: { bob: otherUser, alice: chairUser },
      chairIds: ['bob'],
      agenda: [
        { id: '1', name: 'First', ownerId: 'alice' },
        { id: '2', name: 'Second', ownerId: 'alice' },
      ],
      currentAgendaItemId: '1',
    });
    renderQueue(meeting, chairUser);

    expect(screen.queryByRole('button', { name: 'Next Agenda Item' })).not.toBeInTheDocument();
  });

  // -- Current speaker section --

  it('shows "Nobody speaking yet" when there is no current speaker', () => {
    renderQueue(makeMeeting());
    expect(screen.getByText(/nobody speaking yet/i)).toBeInTheDocument();
  });

  it('shows the current speaker when set', () => {
    const meeting = makeMeeting({
      users: { bob: otherUser },
      queueEntries: { 'entry-1': { id: 'entry-1', type: 'topic', topic: 'My proposal', userId: 'bob' } },
      currentSpeakerEntryId: 'entry-1',
    });
    renderQueue(meeting);

    expect(screen.getByText(/Bob/)).toBeInTheDocument();
    expect(screen.getByText('My proposal')).toBeInTheDocument();
  });

  // -- Current topic section --

  it('shows the current topic section when a topic is active', () => {
    const meeting = makeMeeting({
      users: { alice: chairUser },
      queueEntries: { 'ct-1': { id: 'ct-1', type: 'topic', topic: 'Active discussion point', userId: 'alice' } },
      currentTopicEntryId: 'ct-1',
    });
    renderQueue(meeting);

    expect(screen.getByText('Active discussion point')).toBeInTheDocument();
    expect(screen.getByText('Topic')).toBeInTheDocument();
  });

  // -- Count-up timers --

  it('shows a timer for the current agenda item', () => {
    const meeting = makeMeeting({
      users: { alice: chairUser },
      agenda: [{ id: '1', name: 'Item', ownerId: 'alice' }],
      currentAgendaItemId: '1',
      currentAgendaItemStartTime: new Date(Date.now() - 125_000).toISOString(),
    });
    renderQueue(meeting);
    expect(screen.getByText('2:05')).toBeInTheDocument();
  });

  it('shows a timer for the current speaker', () => {
    const meeting = makeMeeting({
      users: { alice: chairUser },
      queueEntries: { s1: { id: 's1', type: 'topic', topic: 'Test', userId: 'alice' } },
      currentSpeakerEntryId: 's1',
      currentTopicSpeakers: [
        {
          userId: 'alice',
          type: 'topic',
          topic: 'Test',
          startTime: new Date(Date.now() - 65_000).toISOString(),
        },
      ],
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
        carol: { ghid: 3, ghUsername: 'carol', name: 'Carol', organisation: '' },
        dave: { ghid: 4, ghUsername: 'dave', name: 'Dave', organisation: 'Inc' },
      },
      queueEntries: {
        q1: { id: 'q1', type: 'question', topic: 'How does this work?', userId: 'carol' },
        q2: { id: 'q2', type: 'topic', topic: 'Alternative approach', userId: 'dave' },
      },
      queuedSpeakerIds: ['q1', 'q2'],
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
    const meeting = makeMeeting({
      users: { alice: chairUser, bob: otherUser },
      chairIds: ['alice'],
      queueEntries: { s1: { id: 's1', type: 'topic', topic: 'Topic', userId: 'bob' } },
      currentSpeakerEntryId: 's1',
    });
    renderQueue(meeting, chairUser);
    expect(screen.getByRole('button', { name: 'Next Speaker' })).toBeInTheDocument();
  });

  it('shows "Next Speaker" for chairs when nobody is speaking but queue has entries', () => {
    const meeting = makeMeeting({
      users: { alice: chairUser, bob: otherUser },
      chairIds: ['alice'],
      queueEntries: { q1: { id: 'q1', type: 'topic', topic: 'Waiting', userId: 'bob' } },
      queuedSpeakerIds: ['q1'],
    });
    renderQueue(meeting, chairUser);
    expect(screen.getByRole('button', { name: 'Next Speaker' })).toBeInTheDocument();
  });

  it('hides "Next Speaker" for non-chairs', () => {
    const meeting = makeMeeting({
      users: { bob: otherUser },
      chairIds: ['bob'],
      queueEntries: { s1: { id: 's1', type: 'topic', topic: 'Topic', userId: 'bob' } },
      currentSpeakerEntryId: 's1',
    });
    renderQueue(meeting, chairUser);
    expect(screen.queryByRole('button', { name: 'Next Speaker' })).not.toBeInTheDocument();
  });

  it('emits queue:next with version and ack when Next Speaker is clicked', () => {
    const emit = vi.fn();
    const mockSocket = { emit } as unknown as TypedSocket;

    const meeting = makeMeeting({
      users: { alice: chairUser, bob: otherUser },
      chairIds: ['alice'],
      queueEntries: {
        s1: { id: 's1', type: 'topic', topic: 'Topic', userId: 'bob' },
        'topic-123': { id: 'topic-123', type: 'topic', topic: 'Topic', userId: 'bob' },
      },
      currentSpeakerEntryId: 's1',
      currentTopicEntryId: 'topic-123',
    });
    renderQueue(meeting, chairUser, mockSocket);

    fireEvent.click(screen.getByRole('button', { name: 'Next Speaker' }));
    expect(emit).toHaveBeenCalledWith('queue:next', { currentSpeakerEntryId: 's1' }, expect.any(Function));
  });

  // -- Delete buttons on queue entries --

  it('shows delete button on own queue entries', () => {
    const meeting = makeMeeting({
      users: { alice: chairUser },
      queueEntries: { q1: { id: 'q1', type: 'topic', topic: 'My entry', userId: 'alice' } },
      queuedSpeakerIds: ['q1'],
    });
    renderQueue(meeting, chairUser);
    expect(screen.getByRole('button', { name: /delete entry: my entry/i })).toBeInTheDocument();
  });

  it('shows delete button on all entries for chairs', () => {
    const meeting = makeMeeting({
      users: { alice: chairUser, bob: otherUser },
      chairIds: ['alice'],
      queueEntries: { q1: { id: 'q1', type: 'topic', topic: 'Other entry', userId: 'bob' } },
      queuedSpeakerIds: ['q1'],
    });
    renderQueue(meeting, chairUser);
    expect(screen.getByRole('button', { name: /delete entry/i })).toBeInTheDocument();
  });

  it('hides delete button on other users entries for non-chairs', () => {
    const meeting = makeMeeting({
      users: { bob: otherUser },
      chairIds: ['bob'],
      queueEntries: { q1: { id: 'q1', type: 'topic', topic: 'Not mine', userId: 'bob' } },
      queuedSpeakerIds: ['q1'],
    });
    renderQueue(meeting, chairUser);
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
  });

  it('emits queue:remove when delete button is clicked', () => {
    const emit = vi.fn();
    const mockSocket = { emit } as unknown as TypedSocket;

    const meeting = makeMeeting({
      users: { alice: chairUser },
      queueEntries: { 'entry-42': { id: 'entry-42', type: 'topic', topic: 'Remove me', userId: 'alice' } },
      queuedSpeakerIds: ['entry-42'],
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
      users: { alice: chairUser },
      queueEntries: { q1: { id: 'q1', type: 'topic', topic: 'New topic', userId: 'alice' } },
      queuedSpeakerIds: ['q1'],
    });
    renderQueue(meeting, chairUser, mockSocket);

    // Simulate auto-edit on a newly created entry — the QueuePanel receives
    // autoEditEntryId which triggers initialEditing on the matching entry.
    // For this test, we re-render with autoEditEntryId set.
    const { unmount } = render(
      <TestMeetingProvider meeting={meeting} user={chairUser}>
        <SocketContext value={mockSocket}>
          <QueuePanel autoEditEntryId="q1" onAddEntry={() => {}} onAutoEditConsumed={() => {}} />
        </SocketContext>
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
      users: { alice: chairUser },
      queueEntries: { q1: { id: 'q1', type: 'topic', topic: 'New topic', userId: 'alice' } },
      queuedSpeakerIds: ['q1'],
    });

    render(
      <TestMeetingProvider meeting={meeting} user={chairUser}>
        <SocketContext value={mockSocket}>
          <QueuePanel autoEditEntryId="q1" onAddEntry={() => {}} onAutoEditConsumed={() => {}} />
        </SocketContext>
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
      users: { alice: chairUser },
      queueEntries: { q1: { id: 'q1', type: 'topic', topic: 'New topic', userId: 'alice' } },
      queuedSpeakerIds: ['q1'],
    });

    render(
      <TestMeetingProvider meeting={meeting} user={chairUser}>
        <SocketContext value={mockSocket}>
          <QueuePanel autoEditEntryId="q1" onAddEntry={() => {}} onAutoEditConsumed={() => {}} />
        </SocketContext>
      </TestMeetingProvider>,
    );

    // Press Escape without modifying text — should delete the entry
    const input = screen.getByLabelText('Topic description');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(emit).toHaveBeenCalledWith('queue:remove', { id: 'q1' });
  });

  // -- Drag-and-drop reorder handles --

  it('shows drag handles for chairs', () => {
    const meeting = makeMeeting({
      users: { alice: chairUser, bob: otherUser },
      chairIds: ['alice'],
      queueEntries: {
        q1: { id: 'q1', type: 'topic', topic: 'First', userId: 'bob' },
        q2: { id: 'q2', type: 'topic', topic: 'Second', userId: 'bob' },
      },
      queuedSpeakerIds: ['q1', 'q2'],
    });
    renderQueue(meeting, chairUser);

    // Each entry should have a drag handle with an accessible label
    expect(screen.getByLabelText(/drag to reorder: first/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/drag to reorder: second/i)).toBeInTheDocument();
  });

  it('hides drag handles for non-chairs', () => {
    const meeting = makeMeeting({
      users: { bob: otherUser },
      chairIds: ['bob'],
      queueEntries: { q1: { id: 'q1', type: 'topic', topic: 'First', userId: 'bob' } },
      queuedSpeakerIds: ['q1'],
    });
    renderQueue(meeting, chairUser);

    expect(screen.queryByLabelText(/drag to reorder/i)).not.toBeInTheDocument();
  });

  // -- Accessibility --

  it('has accessible section headings', () => {
    renderQueue(makeMeeting());
    expect(screen.getByText('Agenda Item')).toBeInTheDocument();
    expect(screen.getByText('Speaking')).toBeInTheDocument();
    expect(screen.getByText('Speaker Queue')).toBeInTheDocument();
  });
});
