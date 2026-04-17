import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { MeetingState, User } from '@tcq/shared';
import { SpeakerControls } from './SpeakerControls.js';
import { TestMeetingProvider } from '../test/TestMeetingProvider.js';

const testUser: User = {
  ghid: 1,
  ghUsername: 'alice',
  name: 'Alice',
  organisation: 'ACME',
};

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
    queueClosed: false,
    reactions: [],
    trackPoll: false,
    pollOptions: [],
    version: 0,
    log: [],
    currentTopicSpeakers: [],
    ...overrides,
  };
}

function renderControls(meeting: MeetingState, onAddEntry = vi.fn()) {
  return {
    onAddEntry,
    ...render(
      <TestMeetingProvider meeting={meeting} user={testUser}>
        <SpeakerControls onAddEntry={onAddEntry} />
      </TestMeetingProvider>,
    ),
  };
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
      users: { alice: testUser },
      queueEntries: { 'ct-1': { id: 'ct-1', type: 'topic', topic: 'Active topic', userId: 'alice' } },
      currentTopicEntryId: 'ct-1',
    });
    renderControls(meeting);
    expect(screen.getByRole('button', { name: 'Discuss Current Topic' })).toBeInTheDocument();
  });

  it('calls onAddEntry with type and placeholder on click', () => {
    const { onAddEntry } = renderControls(makeMeeting());

    fireEvent.click(screen.getByRole('button', { name: 'Clarifying Question' }));
    expect(onAddEntry).toHaveBeenCalledWith('question', 'Clarifying question');
  });

  it('calls onAddEntry with topic type and placeholder for New Topic', () => {
    const { onAddEntry } = renderControls(makeMeeting());

    fireEvent.click(screen.getByRole('button', { name: 'New Topic' }));
    expect(onAddEntry).toHaveBeenCalledWith('topic', 'New topic');
  });

  it('has an accessible group label', () => {
    renderControls(makeMeeting());
    expect(screen.getByRole('group', { name: 'Queue entry types' })).toBeInTheDocument();
  });

  it('disables buttons when queue is closed and user is not a chair, except Point of Order', () => {
    const meeting = makeMeeting({ queueClosed: true });
    renderControls(meeting);

    expect(screen.getByRole('button', { name: 'New Topic' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Clarifying Question' })).toBeDisabled();
    // Point of Order is always permitted — procedural interruptions bypass the closed-queue gate.
    expect(screen.getByRole('button', { name: 'Point of Order' })).toBeEnabled();
  });

  it('enables buttons when queue is closed and user IS a chair', () => {
    const meeting = makeMeeting({ queueClosed: true, chairIds: ['alice'] });
    renderControls(meeting);

    expect(screen.getByRole('button', { name: 'New Topic' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Clarifying Question' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Point of Order' })).toBeEnabled();
  });
});
