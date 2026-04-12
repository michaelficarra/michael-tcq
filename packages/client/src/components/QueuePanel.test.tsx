import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { MeetingState } from '@tcq/shared';
import { QueuePanel } from './QueuePanel.js';
import { TestMeetingProvider } from '../test/TestMeetingProvider.js';

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

describe('QueuePanel', () => {
  it('shows "Waiting for the meeting to start" when no current agenda item', () => {
    render(
      <TestMeetingProvider meeting={makeMeeting()}>
        <QueuePanel />
      </TestMeetingProvider>,
    );

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

    render(
      <TestMeetingProvider meeting={meeting}>
        <QueuePanel />
      </TestMeetingProvider>,
    );

    expect(screen.getByText('Discussion of proposal')).toBeInTheDocument();
    expect(screen.getByText(/Alice/)).toBeInTheDocument();
    expect(screen.getByText(/20 minutes/)).toBeInTheDocument();
  });

  it('shows "Nobody speaking yet" when there is no current speaker', () => {
    render(
      <TestMeetingProvider meeting={makeMeeting()}>
        <QueuePanel />
      </TestMeetingProvider>,
    );

    expect(screen.getByText(/nobody speaking yet/i)).toBeInTheDocument();
  });

  it('shows the current speaker when set', () => {
    const meeting = makeMeeting({
      currentSpeaker: {
        id: 'entry-1',
        type: 'topic',
        topic: 'My proposal',
        user: { ghid: 2, ghUsername: 'bob', name: 'Bob', organisation: 'Corp' },
      },
    });

    render(
      <TestMeetingProvider meeting={meeting}>
        <QueuePanel />
      </TestMeetingProvider>,
    );

    expect(screen.getByText(/Bob/)).toBeInTheDocument();
    expect(screen.getByText('My proposal')).toBeInTheDocument();
  });

  it('shows "The queue is empty" when there are no queued speakers', () => {
    render(
      <TestMeetingProvider meeting={makeMeeting()}>
        <QueuePanel />
      </TestMeetingProvider>,
    );

    expect(screen.getByText(/queue is empty/i)).toBeInTheDocument();
  });

  it('displays queued speakers with type labels and position numbers', () => {
    const meeting = makeMeeting({
      queuedSpeakers: [
        {
          id: 'q1',
          type: 'question',
          topic: 'How does this work?',
          user: { ghid: 3, ghUsername: 'carol', name: 'Carol', organisation: '' },
        },
        {
          id: 'q2',
          type: 'topic',
          topic: 'Alternative approach',
          user: { ghid: 4, ghUsername: 'dave', name: 'Dave', organisation: 'Inc' },
        },
      ],
    });

    render(
      <TestMeetingProvider meeting={meeting}>
        <QueuePanel />
      </TestMeetingProvider>,
    );

    // Position numbers
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();

    // Type labels
    expect(screen.getByText(/Clarifying Question:/)).toBeInTheDocument();
    expect(screen.getByText(/New Topic:/)).toBeInTheDocument();

    // Topics
    expect(screen.getByText('How does this work?')).toBeInTheDocument();
    expect(screen.getByText('Alternative approach')).toBeInTheDocument();
  });

  it('shows the current topic section when a topic is active', () => {
    const meeting = makeMeeting({
      currentTopic: {
        id: 'ct-1',
        type: 'topic',
        topic: 'Active discussion point',
        user: { ghid: 1, ghUsername: 'alice', name: 'Alice', organisation: '' },
      },
    });

    render(
      <TestMeetingProvider meeting={meeting}>
        <QueuePanel />
      </TestMeetingProvider>,
    );

    expect(screen.getByText('Active discussion point')).toBeInTheDocument();
    // The "Topic" heading should be visible
    expect(screen.getByText('Topic')).toBeInTheDocument();
  });

  it('has accessible section headings', () => {
    render(
      <TestMeetingProvider meeting={makeMeeting()}>
        <QueuePanel />
      </TestMeetingProvider>,
    );

    expect(screen.getByText('Agenda Item')).toBeInTheDocument();
    expect(screen.getByText('Speaking')).toBeInTheDocument();
    expect(screen.getByText('Speaker Queue')).toBeInTheDocument();
  });
});
