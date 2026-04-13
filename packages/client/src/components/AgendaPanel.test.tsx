import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { MeetingState, User } from '@tcq/shared';
import { AgendaPanel } from './AgendaPanel.js';
import { TestMeetingProvider } from '../test/TestMeetingProvider.js';
import { SocketContext, type TypedSocket } from '../contexts/SocketContext.js';

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
    trackTemperature: false, temperatureOptions: [], version: 0,
    ...overrides,
  };
}

const chairUser: User = {
  ghid: 1, ghUsername: 'alice', name: 'Alice', organisation: 'ACME',
};

/** Render the AgendaPanel with meeting context and optional socket. */
function renderAgenda(
  meeting: MeetingState,
  user: User | null = null,
  socket: TypedSocket | null = null,
) {
  return render(
    <TestMeetingProvider meeting={meeting} user={user}>
      <SocketContext value={socket}>
        <AgendaPanel />
      </SocketContext>
    </TestMeetingProvider>,
  );
}

describe('AgendaPanel', () => {
  it('shows "No agenda items yet" when the agenda is empty', () => {
    renderAgenda(makeMeeting());
    expect(screen.getByText(/no agenda items yet/i)).toBeInTheDocument();
  });

  it('displays agenda items as a numbered list', () => {
    const meeting = makeMeeting({
      agenda: [
        { id: '1', name: 'First item', owner: chairUser, timebox: 20 },
        { id: '2', name: 'Second item', owner: chairUser },
      ],
    });
    renderAgenda(meeting);

    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('First item')).toBeInTheDocument();
    expect(screen.getByText(/20 minutes/)).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('Second item')).toBeInTheDocument();
  });

  it('shows the "+ New Agenda Item" button for chairs', () => {
    const meeting = makeMeeting({ chairs: [chairUser] });
    renderAgenda(meeting, chairUser);

    expect(screen.getByText('+ New Agenda Item')).toBeInTheDocument();
  });

  it('hides the "+ New Agenda Item" button for non-chairs', () => {
    const meeting = makeMeeting({
      chairs: [{ ghid: 99, ghUsername: 'other', name: 'Other', organisation: '' }],
    });
    renderAgenda(meeting, chairUser);

    expect(screen.queryByText('+ New Agenda Item')).not.toBeInTheDocument();
  });

  it('shows the agenda form when "+ New Agenda Item" is clicked', () => {
    const meeting = makeMeeting({ chairs: [chairUser] });
    renderAgenda(meeting, chairUser);

    fireEvent.click(screen.getByText('+ New Agenda Item'));

    expect(screen.getByLabelText('Agenda Item Name')).toBeInTheDocument();
    expect(screen.getByLabelText('Owner')).toBeInTheDocument();
    expect(screen.getByLabelText('Timebox')).toBeInTheDocument();
  });

  it('shows delete buttons for chairs', () => {
    const meeting = makeMeeting({
      chairs: [chairUser],
      agenda: [
        { id: '1', name: 'Deletable item', owner: chairUser },
      ],
    });
    renderAgenda(meeting, chairUser);

    expect(screen.getByRole('button', { name: /delete deletable item/i })).toBeInTheDocument();
  });

  it('hides delete buttons for non-chairs', () => {
    const meeting = makeMeeting({
      chairs: [{ ghid: 99, ghUsername: 'other', name: 'Other', organisation: '' }],
      agenda: [
        { id: '1', name: 'Item', owner: chairUser },
      ],
    });
    renderAgenda(meeting, chairUser);

    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
  });

  it('emits agenda:delete when delete button is clicked', () => {
    const emit = vi.fn();
    const mockSocket = { emit } as unknown as TypedSocket;

    const meeting = makeMeeting({
      chairs: [chairUser],
      agenda: [
        { id: 'item-1', name: 'To delete', owner: chairUser },
      ],
    });
    renderAgenda(meeting, chairUser, mockSocket);

    fireEvent.click(screen.getByRole('button', { name: /delete to delete/i }));
    expect(emit).toHaveBeenCalledWith('agenda:delete', { id: 'item-1' });
  });

  it('shows owner organisation in parentheses', () => {
    const meeting = makeMeeting({
      agenda: [{
        id: '1',
        name: 'Test',
        owner: { ghid: 1, ghUsername: 'alice', name: 'Alice', organisation: 'ACME Corp' },
      }],
    });
    renderAgenda(meeting);

    expect(screen.getByText(/ACME Corp/)).toBeInTheDocument();
  });
});
