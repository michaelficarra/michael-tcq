import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { MeetingState, User } from '@tcq/shared';
import { QueuePanel } from './QueuePanel.js';
import { TestMeetingProvider } from '../test/TestMeetingProvider.js';
import { SocketContext, type TypedSocket } from '../contexts/SocketContext.js';

const chairUser: User = {
  ghid: 1, ghUsername: 'alice', name: 'Alice', organisation: 'ACME',
};

const otherUser: User = {
  ghid: 2, ghUsername: 'bob', name: 'Bob', organisation: 'Corp',
};

/** Create a minimal meeting state for testing. */
function makeMeeting(overrides?: Partial<MeetingState>): MeetingState {
  return {
    id: 'test-meeting',
    chairs: [],
    agenda: [],
    currentAgendaItem: undefined,
    currentSpeaker: undefined,
    currentTopic: undefined,
    queuedSpeakers: [],
    reactions: [],
    trackTemperature: false,
    ...overrides,
  };
}

/** Render the QueuePanel with meeting context and optional socket. */
function renderQueue(
  meeting: MeetingState,
  user: User | null = null,
  socket: TypedSocket | null = null,
) {
  return render(
    <TestMeetingProvider meeting={meeting} user={user}>
      <SocketContext value={socket}>
        <QueuePanel />
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
      currentAgendaItem: {
        id: 'item-1',
        name: 'Discussion of proposal',
        owner: { ghid: 1, ghUsername: 'alice', name: 'Alice', organisation: 'ACME' },
        timebox: 20,
      },
    });
    renderQueue(meeting);

    expect(screen.getByText('Discussion of proposal')).toBeInTheDocument();
    expect(screen.getByText(/Alice/)).toBeInTheDocument();
    expect(screen.getByText(/20 minutes/)).toBeInTheDocument();
  });

  // -- Start Meeting button --

  it('shows "Start Meeting" button for chairs when meeting has not started', () => {
    const meeting = makeMeeting({
      chairs: [chairUser],
      agenda: [{ id: '1', name: 'Item', owner: chairUser }],
    });
    renderQueue(meeting, chairUser);

    expect(screen.getByRole('button', { name: 'Start Meeting' })).toBeInTheDocument();
  });

  it('hides "Start Meeting" button for non-chairs', () => {
    const meeting = makeMeeting({
      chairs: [otherUser],
      agenda: [{ id: '1', name: 'Item', owner: chairUser }],
    });
    renderQueue(meeting, chairUser);

    expect(screen.queryByRole('button', { name: 'Start Meeting' })).not.toBeInTheDocument();
  });

  it('hides "Start Meeting" button when agenda is empty', () => {
    const meeting = makeMeeting({ chairs: [chairUser] });
    renderQueue(meeting, chairUser);

    expect(screen.queryByRole('button', { name: 'Start Meeting' })).not.toBeInTheDocument();
  });

  it('emits meeting:nextAgendaItem when Start Meeting is clicked', () => {
    const emit = vi.fn();
    const mockSocket = { emit } as unknown as TypedSocket;

    const meeting = makeMeeting({
      chairs: [chairUser],
      agenda: [{ id: '1', name: 'Item', owner: chairUser }],
    });
    renderQueue(meeting, chairUser, mockSocket);

    fireEvent.click(screen.getByRole('button', { name: 'Start Meeting' }));
    expect(emit).toHaveBeenCalledWith('meeting:nextAgendaItem');
  });

  // -- Next Agenda Item button --

  it('shows "Next Agenda Item" button when there are more items', () => {
    const meeting = makeMeeting({
      chairs: [chairUser],
      agenda: [
        { id: '1', name: 'First', owner: chairUser },
        { id: '2', name: 'Second', owner: chairUser },
      ],
      currentAgendaItem: { id: '1', name: 'First', owner: chairUser },
    });
    renderQueue(meeting, chairUser);

    expect(screen.getByRole('button', { name: 'Next Agenda Item' })).toBeInTheDocument();
  });

  it('hides "Next Agenda Item" button on the last agenda item', () => {
    const meeting = makeMeeting({
      chairs: [chairUser],
      agenda: [{ id: '1', name: 'Only', owner: chairUser }],
      currentAgendaItem: { id: '1', name: 'Only', owner: chairUser },
    });
    renderQueue(meeting, chairUser);

    expect(screen.queryByRole('button', { name: 'Next Agenda Item' })).not.toBeInTheDocument();
  });

  it('hides "Next Agenda Item" button for non-chairs', () => {
    const meeting = makeMeeting({
      chairs: [otherUser],
      agenda: [
        { id: '1', name: 'First', owner: chairUser },
        { id: '2', name: 'Second', owner: chairUser },
      ],
      currentAgendaItem: { id: '1', name: 'First', owner: chairUser },
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
      currentSpeaker: {
        id: 'entry-1',
        type: 'topic',
        topic: 'My proposal',
        user: otherUser,
      },
    });
    renderQueue(meeting);

    expect(screen.getByText(/Bob/)).toBeInTheDocument();
    expect(screen.getByText('My proposal')).toBeInTheDocument();
  });

  // -- Current topic section --

  it('shows the current topic section when a topic is active', () => {
    const meeting = makeMeeting({
      currentTopic: {
        id: 'ct-1',
        type: 'topic',
        topic: 'Active discussion point',
        user: chairUser,
      },
    });
    renderQueue(meeting);

    expect(screen.getByText('Active discussion point')).toBeInTheDocument();
    expect(screen.getByText('Topic')).toBeInTheDocument();
  });

  // -- Speaker queue --

  it('shows "The queue is empty" when there are no queued speakers', () => {
    renderQueue(makeMeeting());
    expect(screen.getByText(/queue is empty/i)).toBeInTheDocument();
  });

  it('displays queued speakers with type labels and position numbers', () => {
    const meeting = makeMeeting({
      queuedSpeakers: [
        {
          id: 'q1', type: 'question', topic: 'How does this work?',
          user: { ghid: 3, ghUsername: 'carol', name: 'Carol', organisation: '' },
        },
        {
          id: 'q2', type: 'topic', topic: 'Alternative approach',
          user: { ghid: 4, ghUsername: 'dave', name: 'Dave', organisation: 'Inc' },
        },
      ],
    });
    renderQueue(meeting);

    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText(/Clarifying Question:/)).toBeInTheDocument();
    expect(screen.getByText(/New Topic:/)).toBeInTheDocument();
    expect(screen.getByText('How does this work?')).toBeInTheDocument();
    expect(screen.getByText('Alternative approach')).toBeInTheDocument();
  });

  // -- Accessibility --

  it('has accessible section headings', () => {
    renderQueue(makeMeeting());
    expect(screen.getByText('Agenda Item')).toBeInTheDocument();
    expect(screen.getByText('Speaking')).toBeInTheDocument();
    expect(screen.getByText('Speaker Queue')).toBeInTheDocument();
  });
});
