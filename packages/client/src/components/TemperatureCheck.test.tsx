import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { MeetingState, User, TemperatureOption } from '@tcq/shared';
import { TemperatureCheck } from './TemperatureCheck.js';
import { TestMeetingProvider } from '../test/TestMeetingProvider.js';
import { SocketContext, type TypedSocket } from '../contexts/SocketContext.js';

const alice: User = { ghid: 1, ghUsername: 'alice', name: 'Alice', organisation: 'ACME' };
const bob: User = { ghid: 2, ghUsername: 'bob', name: 'Bob', organisation: '' };

/** Sample options for testing. */
const sampleOptions: TemperatureOption[] = [
  { id: 'opt-1', emoji: '❤️', label: 'Strong Positive' },
  { id: 'opt-2', emoji: '👍', label: 'Positive' },
  { id: 'opt-3', emoji: '👀', label: 'Following' },
  { id: 'opt-4', emoji: '❓', label: 'Confused' },
];

function makeMeeting(overrides?: Partial<MeetingState>): MeetingState {
  return {
    id: 'test', chairs: [], agenda: [],
    currentAgendaItem: undefined, currentSpeaker: undefined,
    currentTopic: undefined, queuedSpeakers: [],
    reactions: [], trackTemperature: false, temperatureOptions: [],
    version: 0,
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

  it('renders a button for each temperature option', () => {
    renderTemp(makeMeeting({
      trackTemperature: true,
      temperatureOptions: sampleOptions,
    }));

    expect(screen.getByLabelText(/strong positive/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^positive/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/following/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/confused/i)).toBeInTheDocument();
  });

  it('shows the count for each option', () => {
    const meeting = makeMeeting({
      trackTemperature: true,
      temperatureOptions: sampleOptions,
      reactions: [
        { optionId: 'opt-1', user: alice },
        { optionId: 'opt-1', user: bob },
        { optionId: 'opt-2', user: alice },
      ],
    });
    renderTemp(meeting);

    expect(screen.getByLabelText(/strong positive: 2/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^positive: 1/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/following: 0/i)).toBeInTheDocument();
  });

  it('highlights the current user\'s selected reactions', () => {
    const meeting = makeMeeting({
      trackTemperature: true,
      temperatureOptions: sampleOptions,
      reactions: [{ optionId: 'opt-2', user: alice }],
    });
    renderTemp(meeting, alice);

    const positiveBtn = screen.getByLabelText(/^positive: 1/i);
    expect(positiveBtn).toHaveAttribute('aria-pressed', 'true');

    const followingBtn = screen.getByLabelText(/following: 0/i);
    expect(followingBtn).toHaveAttribute('aria-pressed', 'false');
  });

  it('emits temperature:react with optionId when clicked', () => {
    const emit = vi.fn();
    const mockSocket = { emit } as unknown as TypedSocket;

    renderTemp(makeMeeting({
      trackTemperature: true,
      temperatureOptions: sampleOptions,
    }), alice, mockSocket);

    fireEvent.click(screen.getByLabelText(/confused/i));
    expect(emit).toHaveBeenCalledWith('temperature:react', { optionId: 'opt-4' });
  });

  it('shows user names in the tooltip', () => {
    const meeting = makeMeeting({
      trackTemperature: true,
      temperatureOptions: sampleOptions,
      reactions: [
        { optionId: 'opt-1', user: alice },
        { optionId: 'opt-1', user: bob },
      ],
    });
    renderTemp(meeting);

    const btn = screen.getByLabelText(/strong positive: 2/i);
    expect(btn).toHaveAttribute('title', 'Alice, Bob');
  });

  it('has an accessible group label', () => {
    renderTemp(makeMeeting({
      trackTemperature: true,
      temperatureOptions: sampleOptions,
    }));
    expect(screen.getByRole('group', { name: /temperature check reactions/i })).toBeInTheDocument();
  });
});
