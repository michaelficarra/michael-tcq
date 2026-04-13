import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { MeetingState, User } from '@tcq/shared';
import { SpeakerControls } from './SpeakerControls.js';
import { TestMeetingProvider } from '../test/TestMeetingProvider.js';
import { SocketContext, type TypedSocket } from '../contexts/SocketContext.js';

const testUser: User = {
  ghid: 1, ghUsername: 'alice', name: 'Alice', organisation: 'ACME',
};

function makeMeeting(overrides?: Partial<MeetingState>): MeetingState {
  return {
    id: 'test-meeting', chairs: [], agenda: [],
    currentAgendaItem: undefined, currentSpeaker: undefined,
    currentTopic: undefined, queuedSpeakers: [],
    reactions: [], trackTemperature: false, temperatureOptions: [], version: 0,
    ...overrides,
  };
}

function renderControls(
  meeting: MeetingState,
  socket: TypedSocket | null = null,
) {
  return render(
    <TestMeetingProvider meeting={meeting} user={testUser}>
      <SocketContext value={socket}>
        <SpeakerControls />
      </SocketContext>
    </TestMeetingProvider>,
  );
}

describe('SpeakerControls', () => {
  it('renders New Topic, Clarifying Question, and Point of Order buttons', () => {
    renderControls(makeMeeting());

    expect(screen.getByRole('button', { name: 'New Topic' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clarifying Question' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Point of Order' })).toBeInTheDocument();
  });

  it('hides the Reply button when there is no current topic', () => {
    renderControls(makeMeeting());
    expect(screen.queryByRole('button', { name: 'Discuss Current Topic' })).not.toBeInTheDocument();
  });

  it('shows the Reply button when there is a current topic', () => {
    const meeting = makeMeeting({
      currentTopic: {
        id: 'ct-1', type: 'topic', topic: 'Active topic', user: testUser,
      },
    });
    renderControls(meeting);
    expect(screen.getByRole('button', { name: 'Discuss Current Topic' })).toBeInTheDocument();
  });

  it('opens the inline form when an entry type button is clicked', () => {
    renderControls(makeMeeting());

    fireEvent.click(screen.getByRole('button', { name: 'New Topic' }));

    expect(screen.getByLabelText('New Topic')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enter Queue' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('shows "Reply to <topic>" as the form label for replies', () => {
    const meeting = makeMeeting({
      currentTopic: {
        id: 'ct-1', type: 'topic', topic: 'Async iteration', user: testUser,
      },
    });
    renderControls(meeting);

    fireEvent.click(screen.getByRole('button', { name: 'Discuss Current Topic' }));

    expect(screen.getByLabelText('Reply to Async iteration')).toBeInTheDocument();
  });

  it('closes the form on Cancel', () => {
    renderControls(makeMeeting());

    fireEvent.click(screen.getByRole('button', { name: 'New Topic' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('button', { name: 'Enter Queue' })).not.toBeInTheDocument();
  });

  it('emits queue:add on form submit', () => {
    const emit = vi.fn();
    const mockSocket = { emit } as unknown as TypedSocket;

    renderControls(makeMeeting(), mockSocket);

    // Open the form
    fireEvent.click(screen.getByRole('button', { name: 'Clarifying Question' }));

    // Fill in and submit
    fireEvent.change(screen.getByPlaceholderText('short topic description'), {
      target: { value: 'How does this work?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Enter Queue' }));

    expect(emit).toHaveBeenCalledWith('queue:add', {
      type: 'question',
      topic: 'How does this work?',
    });
  });

  it('closes the form after successful submit', () => {
    const emit = vi.fn();
    const mockSocket = { emit } as unknown as TypedSocket;

    renderControls(makeMeeting(), mockSocket);

    fireEvent.click(screen.getByRole('button', { name: 'New Topic' }));
    fireEvent.change(screen.getByPlaceholderText('short topic description'), {
      target: { value: 'My topic' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Enter Queue' }));

    // Form should be closed
    expect(screen.queryByRole('button', { name: 'Enter Queue' })).not.toBeInTheDocument();
  });

  it('has an accessible group label', () => {
    renderControls(makeMeeting());
    expect(screen.getByRole('group', { name: 'Queue entry types' })).toBeInTheDocument();
  });
});
