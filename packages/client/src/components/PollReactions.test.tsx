import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ActivePoll, MeetingState, User, PollOption } from '@tcq/shared';
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

function makePoll(overrides?: Partial<ActivePoll>): ActivePoll {
  return {
    options: sampleOptions,
    reactions: [],
    startTime: new Date().toISOString(),
    startChairId: 'alice',
    multiSelect: true,
    ...overrides,
  };
}

function makeMeeting(overrides?: Partial<MeetingState>): MeetingState {
  return {
    id: 'test',
    users: {},
    chairIds: [],
    agenda: [],
    currentAgendaItemId: undefined,
    currentSpeakerEntryId: undefined,
    currentTopicEntryId: undefined,
    queueEntries: {},
    queuedSpeakerIds: [],
    queueClosed: false,
    log: [],
    currentTopicSpeakers: [],
    ...overrides,
  };
}

function renderPoll(meeting: MeetingState, user: User | null = alice, socket: TypedSocket | null = null) {
  return render(
    <TestMeetingProvider meeting={meeting} user={user}>
      <SocketContext value={socket}>
        <PollReactions />
      </SocketContext>
    </TestMeetingProvider>,
  );
}

describe('PollReactions', () => {
  it('renders nothing when no poll is active', () => {
    const { container } = renderPoll(makeMeeting());
    expect(container.firstChild).toBeNull();
  });

  it('renders a button for each poll option', () => {
    renderPoll(makeMeeting({ poll: makePoll() }));

    expect(screen.getByLabelText(/strong positive/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^positive/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/following/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/confused/i)).toBeInTheDocument();
  });

  it('shows the count for each option', () => {
    const meeting = makeMeeting({
      poll: makePoll({
        reactions: [
          { optionId: 'opt-1', userId: 'alice' },
          { optionId: 'opt-1', userId: 'bob' },
          { optionId: 'opt-2', userId: 'alice' },
        ],
      }),
    });
    renderPoll(meeting);

    expect(screen.getByLabelText(/strong positive: 2/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^positive: 1/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/following: 0/i)).toBeInTheDocument();
  });

  it("highlights the current user's selected reactions", () => {
    const meeting = makeMeeting({
      poll: makePoll({
        reactions: [{ optionId: 'opt-2', userId: 'alice' }],
      }),
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

    renderPoll(makeMeeting({ poll: makePoll() }), alice, mockSocket);

    fireEvent.click(screen.getByLabelText(/confused/i));
    expect(emit).toHaveBeenCalledWith('poll:react', { optionId: 'opt-4' });
  });

  it('shows user names in the tooltip', () => {
    const meeting = makeMeeting({
      users: { alice, bob },
      poll: makePoll({
        reactions: [
          { optionId: 'opt-1', userId: 'alice' },
          { optionId: 'opt-1', userId: 'bob' },
        ],
      }),
    });
    renderPoll(meeting);

    const btn = screen.getByLabelText(/strong positive: 2/i);
    expect(btn).toHaveAttribute('title', 'Alice, Bob');
  });

  it('has an accessible group label', () => {
    renderPoll(makeMeeting({ poll: makePoll() }));
    expect(screen.getByRole('group', { name: /poll reactions/i })).toBeInTheDocument();
  });

  it('displays the poll topic when provided', () => {
    const meeting = makeMeeting({
      poll: makePoll({ topic: 'Should we advance this proposal?' }),
    });
    renderPoll(meeting);
    expect(screen.getByText('Should we advance this proposal?')).toBeInTheDocument();
  });

  it('does not display a topic line when no topic is set', () => {
    const meeting = makeMeeting({ poll: makePoll() });
    renderPoll(meeting);
    // Only the options and group should be rendered, no topic paragraph
    expect(screen.queryByText(/should|topic/i)).not.toBeInTheDocument();
  });

  it('displays a count-up timer based on poll.startTime', () => {
    const meeting = makeMeeting({
      poll: makePoll({ startTime: new Date(Date.now() - 125_000).toISOString() }),
    });
    renderPoll(meeting);
    expect(screen.getByText('2:05')).toBeInTheDocument();
  });
});
