import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { MeetingState, User, PollOption } from '@tcq/shared';
import { PollReactions } from './PollReactions.js';
import { TestMeetingProvider } from '../test/TestMeetingProvider.js';
import { SocketContext, type TypedSocket } from '../contexts/SocketContext.js';

const alice: User = { ghid: 1, ghUsername: 'alice', name: 'Alice', organisation: 'ACME' };
const bob: User = { ghid: 2, ghUsername: 'bob', name: 'Bob', organisation: '' };

/** Sample options for testing. */
const sampleOptions: PollOption[] = [
  { id: 'opt-1', emoji: '❤️', label: 'Strong Positive' },
  { id: 'opt-2', emoji: '👍', label: 'Positive' },
  { id: 'opt-3', emoji: '👀', label: 'Following' },
  { id: 'opt-4', emoji: '❓', label: 'Confused' },
];

function makeMeeting(overrides?: Partial<MeetingState>): MeetingState {
  return {
    id: 'test', users: {}, chairIds: [], agenda: [],
    currentAgendaItemId: undefined, currentSpeakerEntryId: undefined,
    currentTopicEntryId: undefined, queueEntries: {}, queuedSpeakerIds: [],
    reactions: [], trackPoll: false, pollOptions: [],
    version: 0, log: [], currentTopicSpeakers: [],
    ...overrides,
  };
}

function renderPoll(
  meeting: MeetingState,
  user: User | null = alice,
  socket: TypedSocket | null = null,
) {
  return render(
    <TestMeetingProvider meeting={meeting} user={user}>
      <SocketContext value={socket}>
        <PollReactions />
      </SocketContext>
    </TestMeetingProvider>,
  );
}

describe('PollReactions', () => {
  it('renders nothing when trackPoll is false', () => {
    const { container } = renderPoll(makeMeeting());
    expect(container.firstChild).toBeNull();
  });

  it('renders a button for each poll option', () => {
    renderPoll(makeMeeting({
      trackPoll: true,
      pollOptions: sampleOptions,
    }));

    expect(screen.getByLabelText(/strong positive/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^positive/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/following/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/confused/i)).toBeInTheDocument();
  });

  it('shows the count for each option', () => {
    const meeting = makeMeeting({
      trackPoll: true,
      pollOptions: sampleOptions,
      reactions: [
        { optionId: 'opt-1', userId: 'alice' },
        { optionId: 'opt-1', userId: 'bob' },
        { optionId: 'opt-2', userId: 'alice' },
      ],
    });
    renderPoll(meeting);

    expect(screen.getByLabelText(/strong positive: 2/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^positive: 1/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/following: 0/i)).toBeInTheDocument();
  });

  it('highlights the current user\'s selected reactions', () => {
    const meeting = makeMeeting({
      trackPoll: true,
      pollOptions: sampleOptions,
      reactions: [{ optionId: 'opt-2', userId: 'alice' }],
    });
    renderPoll(meeting, alice);

    const positiveBtn = screen.getByLabelText(/^positive: 1/i);
    expect(positiveBtn).toHaveAttribute('aria-pressed', 'true');

    const followingBtn = screen.getByLabelText(/following: 0/i);
    expect(followingBtn).toHaveAttribute('aria-pressed', 'false');
  });

  it('emits poll:react with optionId when clicked', () => {
    const emit = vi.fn();
    const mockSocket = { emit } as unknown as TypedSocket;

    renderPoll(makeMeeting({
      trackPoll: true,
      pollOptions: sampleOptions,
    }), alice, mockSocket);

    fireEvent.click(screen.getByLabelText(/confused/i));
    expect(emit).toHaveBeenCalledWith('poll:react', { optionId: 'opt-4' });
  });

  it('shows user names in the tooltip', () => {
    const meeting = makeMeeting({
      users: { alice, bob },
      trackPoll: true,
      pollOptions: sampleOptions,
      reactions: [
        { optionId: 'opt-1', userId: 'alice' },
        { optionId: 'opt-1', userId: 'bob' },
      ],
    });
    renderPoll(meeting);

    const btn = screen.getByLabelText(/strong positive: 2/i);
    expect(btn).toHaveAttribute('title', 'Alice, Bob');
  });

  it('has an accessible group label', () => {
    renderPoll(makeMeeting({
      trackPoll: true,
      pollOptions: sampleOptions,
    }));
    expect(screen.getByRole('group', { name: /poll reactions/i })).toBeInTheDocument();
  });
});
