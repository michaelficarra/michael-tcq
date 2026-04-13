import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { MeetingState, User } from '@tcq/shared';
import { TemperatureCheck } from './TemperatureCheck.js';
import { TestMeetingProvider } from '../test/TestMeetingProvider.js';
import { SocketContext, type TypedSocket } from '../contexts/SocketContext.js';

const alice: User = { ghid: 1, ghUsername: 'alice', name: 'Alice', organisation: 'ACME' };
const bob: User = { ghid: 2, ghUsername: 'bob', name: 'Bob', organisation: '' };

function makeMeeting(overrides?: Partial<MeetingState>): MeetingState {
  return {
    id: 'test', chairs: [], agenda: [],
    currentAgendaItem: undefined, currentSpeaker: undefined,
    currentTopic: undefined, queuedSpeakers: [],
    reactions: [], trackTemperature: false, version: 0,
    ...overrides,
  };
}

function renderTemp(
  meeting: MeetingState,
  user: User | null = alice,
  socket: TypedSocket | null = null,
) {
  return render(
    <TestMeetingProvider meeting={meeting} user={user}>
      <SocketContext value={socket}>
        <TemperatureCheck />
      </SocketContext>
    </TestMeetingProvider>,
  );
}

describe('TemperatureCheck', () => {
  it('renders nothing when trackTemperature is false', () => {
    const { container } = renderTemp(makeMeeting());
    expect(container.firstChild).toBeNull();
  });

  it('renders six reaction buttons when trackTemperature is true', () => {
    renderTemp(makeMeeting({ trackTemperature: true }));

    expect(screen.getByLabelText(/strong positive/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^positive/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/following/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/confused/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/indifferent/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/unconvinced/i)).toBeInTheDocument();
  });

  it('shows the count for each reaction type', () => {
    const meeting = makeMeeting({
      trackTemperature: true,
      reactions: [
        { reaction: '❤️', user: alice },
        { reaction: '❤️', user: bob },
        { reaction: '👍', user: alice },
      ],
    });
    renderTemp(meeting);

    // Strong Positive: 2, Positive: 1, rest: 0
    expect(screen.getByLabelText(/strong positive: 2/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^positive: 1/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/following: 0/i)).toBeInTheDocument();
  });

  it('highlights the current user\'s selected reactions', () => {
    const meeting = makeMeeting({
      trackTemperature: true,
      reactions: [{ reaction: '👍', user: alice }],
    });
    renderTemp(meeting, alice);

    const positiveBtn = screen.getByLabelText(/^positive: 1/i);
    expect(positiveBtn).toHaveAttribute('aria-pressed', 'true');

    const followingBtn = screen.getByLabelText(/following: 0/i);
    expect(followingBtn).toHaveAttribute('aria-pressed', 'false');
  });

  it('emits temperature:react when a reaction button is clicked', () => {
    const emit = vi.fn();
    const mockSocket = { emit } as unknown as TypedSocket;

    renderTemp(makeMeeting({ trackTemperature: true }), alice, mockSocket);

    fireEvent.click(screen.getByLabelText(/confused/i));
    expect(emit).toHaveBeenCalledWith('temperature:react', { reaction: '❓' });
  });

  it('shows user names in the tooltip', () => {
    const meeting = makeMeeting({
      trackTemperature: true,
      reactions: [
        { reaction: '❤️', user: alice },
        { reaction: '❤️', user: bob },
      ],
    });
    renderTemp(meeting);

    const btn = screen.getByLabelText(/strong positive: 2/i);
    expect(btn).toHaveAttribute('title', 'Alice, Bob');
  });

  it('has an accessible group label', () => {
    renderTemp(makeMeeting({ trackTemperature: true }));
    expect(screen.getByRole('group', { name: /temperature check reactions/i })).toBeInTheDocument();
  });
});
