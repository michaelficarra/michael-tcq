import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { MeetingState, User, LogEntry, TopicSpeaker } from '@tcq/shared';
import { LogsPanel } from './LogsPanel.js';
import { TestMeetingProvider } from '../test/TestMeetingProvider.js';

const alice: User = { ghid: 1, ghUsername: 'alice', name: 'Alice', organisation: 'ACME' };
const bob: User = { ghid: 2, ghUsername: 'bob', name: 'Bob', organisation: 'ACME' };
const carol: User = { ghid: 3, ghUsername: 'carol', name: 'Carol', organisation: 'ACME' };

function makeMeeting(overrides?: Partial<MeetingState>): MeetingState {
  return {
    id: 'test', chairs: [alice], agenda: [],
    currentAgendaItem: undefined, currentSpeaker: undefined,
    currentTopic: undefined, queuedSpeakers: [],
    reactions: [], trackPoll: false, pollOptions: [],
    version: 0, log: [], currentTopicSpeakers: [],
    ...overrides,
  };
}

function renderLog(meeting: MeetingState) {
  return render(
    <TestMeetingProvider meeting={meeting}>
      <LogsPanel />
    </TestMeetingProvider>,
  );
}

describe('LogsPanel', () => {
  it('shows empty state message when there are no log entries', () => {
    renderLog(makeMeeting());
    expect(screen.getByText(/no events yet/i)).toBeTruthy();
  });

  it('renders a meeting-started entry', () => {
    renderLog(makeMeeting({
      log: [{
        type: 'meeting-started',
        timestamp: new Date().toISOString(),
        chair: alice,
      }],
    }));
    expect(screen.getByText('Meeting started')).toBeTruthy();
  });

  it('renders an agenda-item-started entry with "Started:" prefix', () => {
    renderLog(makeMeeting({
      log: [{
        type: 'agenda-item-started',
        timestamp: new Date().toISOString(),
        chair: alice,
        itemName: 'Proposal A',
        itemOwner: bob,
      }],
    }));
    expect(screen.getByText('Started:')).toBeTruthy();
    expect(screen.getByText('Proposal A')).toBeTruthy();
    // Item owner badge should be shown
    expect(screen.getByText('Bob')).toBeTruthy();
  });

  it('renders an agenda-item-finished entry with duration and participants', () => {
    renderLog(makeMeeting({
      log: [{
        type: 'agenda-item-finished',
        timestamp: new Date().toISOString(),
        chair: alice,
        itemName: 'Proposal A',
        duration: 15 * 60 * 1000, // 15 min
        participants: [alice, bob],
      }],
    }));
    expect(screen.getByText('Finished:')).toBeTruthy();
    expect(screen.getByText('Proposal A')).toBeTruthy();
    expect(screen.getByText('15 min')).toBeTruthy();
    expect(screen.getByText('Alice')).toBeTruthy();
    expect(screen.getByText('Bob')).toBeTruthy();
  });

  it('renders remaining queue in a disclosure on agenda-item-finished', () => {
    renderLog(makeMeeting({
      log: [{
        type: 'agenda-item-finished',
        timestamp: new Date().toISOString(),
        chair: alice,
        itemName: 'Proposal A',
        duration: 5 * 60 * 1000,
        participants: [],
        remainingQueue: 'New Topic: Leftover (bob)',
      }],
    }));
    expect(screen.getByText('Remaining queue')).toBeTruthy();
    expect(screen.getByText('New Topic: Leftover (bob)')).toBeTruthy();
  });

  it('does not show remaining queue when absent', () => {
    renderLog(makeMeeting({
      log: [{
        type: 'agenda-item-finished',
        timestamp: new Date().toISOString(),
        chair: alice,
        itemName: 'Proposal A',
        duration: 5 * 60 * 1000,
        participants: [],
      }],
    }));
    expect(screen.queryByText('Remaining queue')).toBeNull();
  });

  it('renders a compact topic-discussed entry for a single speaker', () => {
    const speakers: TopicSpeaker[] = [{
      user: bob, type: 'topic', topic: 'My discussion point',
      startTime: new Date().toISOString(), duration: 3 * 60 * 1000,
    }];
    renderLog(makeMeeting({
      log: [{
        type: 'topic-discussed',
        timestamp: speakers[0].startTime,
        chair: alice,
        topicName: 'My discussion point',
        speakers,
        duration: 3 * 60 * 1000,
      }],
    }));
    // Topic text shown once (compact format, no nested rows)
    const matches = screen.getAllByText('My discussion point');
    expect(matches).toHaveLength(1);
    expect(screen.getByText('Bob')).toBeTruthy();
    expect(screen.getByText('3 min')).toBeTruthy();
  });

  it('renders an expanded topic-discussed entry without duplicating the first speaker', () => {
    const now = new Date();
    const speakers: TopicSpeaker[] = [
      { user: bob, type: 'topic', topic: 'Main point',
        startTime: now.toISOString(), duration: 2 * 60 * 1000 },
      { user: carol, type: 'reply', topic: 'I agree',
        startTime: new Date(now.getTime() + 120000).toISOString(), duration: 60 * 1000 },
    ];
    renderLog(makeMeeting({
      log: [{
        type: 'topic-discussed',
        timestamp: speakers[0].startTime,
        chair: alice,
        topicName: 'Main point',
        speakers,
        duration: 3 * 60 * 1000,
      }],
    }));
    // Topic name appears once in the heading, not duplicated as a nested row
    const topicMatches = screen.getAllByText('Main point');
    expect(topicMatches).toHaveLength(1);
    // First speaker's badge is in the heading
    expect(screen.getByText('Bob')).toBeTruthy();
    // Reply appears as a nested row
    expect(screen.getByText('I agree')).toBeTruthy();
    expect(screen.getByText('Carol')).toBeTruthy();
    expect(screen.getByText('Reply:')).toBeTruthy();
  });

  it('renders a poll-ran entry with chair, voters, and results', () => {
    renderLog(makeMeeting({
      log: [{
        type: 'poll-ran',
        timestamp: new Date().toISOString(),
        startChair: alice,
        endChair: alice,
        duration: 2 * 60 * 1000,
        totalVoters: 5,
        results: [
          { emoji: '👍', label: 'Yes', count: 4 },
          { emoji: '👎', label: 'No', count: 1 },
        ],
      }],
    }));
    expect(screen.getByText('Ran a poll')).toBeTruthy();
    expect(screen.getByText('2 min')).toBeTruthy();
    expect(screen.getByText('5 voters')).toBeTruthy();
    expect(screen.getByText('Alice')).toBeTruthy();
    expect(screen.getByText(/Yes: 4/)).toBeTruthy();
    expect(screen.getByText(/No: 1/)).toBeTruthy();
  });

  it('shows both chairs on poll-ran when start and end chairs differ', () => {
    renderLog(makeMeeting({
      log: [{
        type: 'poll-ran',
        timestamp: new Date().toISOString(),
        startChair: alice,
        endChair: bob,
        duration: 60 * 1000,
        totalVoters: 1,
        results: [{ emoji: '👍', label: 'Yes', count: 1 }],
      }],
    }));
    expect(screen.getByText('Alice')).toBeTruthy();
    expect(screen.getByText('Bob')).toBeTruthy();
  });

  it('renders the current topic group as ongoing', () => {
    const speakers: TopicSpeaker[] = [{
      user: bob, type: 'topic', topic: 'Active discussion',
      startTime: new Date().toISOString(),
    }];
    renderLog(makeMeeting({ currentTopicSpeakers: speakers }));
    expect(screen.getByText('Active discussion')).toBeTruthy();
    expect(screen.getByText('ongoing')).toBeTruthy();
  });

  it('renders entries in reverse chronological order', () => {
    const t1 = '2026-01-01T10:00:00Z';
    const t2 = '2026-01-01T10:05:00Z';
    const log: LogEntry[] = [
      { type: 'meeting-started', timestamp: t1, chair: alice },
      { type: 'agenda-item-started', timestamp: t2, chair: alice, itemName: 'Item 1', itemOwner: alice },
    ];
    renderLog(makeMeeting({ log }));
    const started = screen.getByText('Meeting started');
    const item = screen.getByText('Started:');
    // In the DOM, the agenda-item-started (later timestamp) should come before meeting-started
    expect(item.compareDocumentPosition(started) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders a separator after agenda-item-started entries', () => {
    const log: LogEntry[] = [
      { type: 'meeting-started', timestamp: '2026-01-01T10:00:00Z', chair: alice },
      { type: 'agenda-item-started', timestamp: '2026-01-01T10:00:00Z', chair: alice, itemName: 'Item 1', itemOwner: alice },
      { type: 'agenda-item-finished', timestamp: '2026-01-01T10:10:00Z', chair: alice, itemName: 'Item 1', duration: 600000, participants: [alice] },
      { type: 'agenda-item-started', timestamp: '2026-01-01T10:10:00Z', chair: alice, itemName: 'Item 2', itemOwner: bob },
    ];
    const { container } = renderLog(makeMeeting({ log }));
    const separators = container.querySelectorAll('hr');
    // Separator after each agenda-item-started except the last in the reversed list
    expect(separators.length).toBeGreaterThanOrEqual(1);
  });

  it('uses singular "voter" for a single voter', () => {
    renderLog(makeMeeting({
      log: [{
        type: 'poll-ran',
        timestamp: new Date().toISOString(),
        startChair: alice,
        endChair: alice,
        duration: 60 * 1000,
        totalVoters: 1,
        results: [{ emoji: '👍', label: 'Yes', count: 1 }],
      }],
    }));
    expect(screen.getByText('1 voter')).toBeTruthy();
  });
});
