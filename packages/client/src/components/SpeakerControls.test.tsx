import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import type { MeetingState, User } from '@tcq/shared';
import { SpeakerControls } from './SpeakerControls.js';
import { TestMeetingProvider } from '../test/TestMeetingProvider.js';
import { PreferencesProvider } from '../contexts/PreferencesContext.js';
import { AuthProvider } from '../contexts/AuthContext.js';
import { makeMeeting as buildMeeting } from '../test/makeMeeting.js';
import { __resetSavedTopicsCacheForTests } from '../hooks/useSavedTopics.js';

const testUser: User = {
  ghid: 1,
  ghUsername: 'alice',
  name: 'Alice',
  organisation: 'ACME',
};

function makeMeeting(overrides?: Partial<MeetingState>): MeetingState {
  return buildMeeting(overrides);
}

function renderControls(meeting: MeetingState, onAddEntry = vi.fn(), onSavedTopic = vi.fn()) {
  return {
    onAddEntry,
    onSavedTopic,
    ...render(
      <TestMeetingProvider meeting={meeting} user={testUser}>
        <PreferencesProvider>
          <SpeakerControls onAddEntry={onAddEntry} onSavedTopic={onSavedTopic} />
        </PreferencesProvider>
      </TestMeetingProvider>,
    ),
  };
}

beforeEach(() => {
  // Each test gets a clean saved-topics cache so a previous test's
  // mutations don't leak into the next.
  localStorage.clear();
  __resetSavedTopicsCacheForTests();
});

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
      current: {
        topicSpeakers: [],
        topic: { speakerId: 'ct-1', userId: 'alice', topic: 'Active topic', startTime: '2026-01-01T00:00:00.000Z' },
      },
    });
    renderControls(meeting);
    expect(screen.getByRole('button', { name: 'Discuss Current Topic' })).toBeInTheDocument();
  });

  it('calls onAddEntry with the type on click', () => {
    const { onAddEntry } = renderControls(makeMeeting());

    fireEvent.click(screen.getByRole('button', { name: 'Clarifying Question' }));
    expect(onAddEntry).toHaveBeenCalledWith('question');
  });

  it('calls onAddEntry with topic type for New Topic', () => {
    const { onAddEntry } = renderControls(makeMeeting());

    fireEvent.click(screen.getByRole('button', { name: 'New Topic' }));
    expect(onAddEntry).toHaveBeenCalledWith('topic');
  });

  it('has an accessible group label', () => {
    renderControls(makeMeeting());
    expect(screen.getByRole('group', { name: 'Queue entry types' })).toBeInTheDocument();
  });

  it('disables buttons when queue is closed and user is not a chair, except Point of Order', () => {
    const meeting = makeMeeting({ queue: { entries: {}, orderedIds: [], closed: true } });
    renderControls(meeting);

    expect(screen.getByRole('button', { name: 'New Topic' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Clarifying Question' })).toBeDisabled();
    // Point of Order is always permitted — procedural interruptions bypass the closed-queue gate.
    expect(screen.getByRole('button', { name: 'Point of Order' })).toBeEnabled();
  });

  it('enables buttons when queue is closed and user IS a chair', () => {
    const meeting = makeMeeting({ queue: { entries: {}, orderedIds: [], closed: true }, chairIds: ['alice'] });
    renderControls(meeting);

    expect(screen.getByRole('button', { name: 'New Topic' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Clarifying Question' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Point of Order' })).toBeEnabled();
  });

  it('renders the saved-topics trigger button alongside the entry-type buttons', () => {
    renderControls(makeMeeting());
    expect(screen.getByRole('button', { name: 'Saved topics' })).toBeInTheDocument();
  });

  it('keeps the saved-topics button enabled when queue is closed (per-item gating handles it)', () => {
    const meeting = makeMeeting({ queue: { entries: {}, orderedIds: [], closed: true } });
    renderControls(meeting);
    // The button only opens the menu; Point of Order saved topics and the
    // Edit link must stay reachable even when the queue is closed.
    expect(screen.getByRole('button', { name: 'Saved topics' })).toBeEnabled();
  });
});

// ----- Saved topics dropdown -----
//
// These tests wrap the component in a real AuthProvider so `useSavedTopics`
// can key by user.ghid. /api/me is stubbed so the provider resolves without
// network. Each render awaits an act() tick so the AuthProvider's initial
// fetch settles before the dropdown reads its (now-seeded) list.

function stubMe(ghid: number, username = 'alice'): void {
  globalThis.fetch = (async (url: string | URL | Request) => {
    if (String(url) === '/api/me') {
      return {
        ok: true,
        json: async () => ({ ghid, ghUsername: username, name: username, organisation: '' }),
      } as Response;
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
}

async function renderControlsWithAuth(meeting: MeetingState, onAddEntry = vi.fn(), onSavedTopic = vi.fn()) {
  const result = render(
    <AuthProvider>
      <TestMeetingProvider meeting={meeting} user={testUser}>
        <PreferencesProvider>
          <SpeakerControls onAddEntry={onAddEntry} onSavedTopic={onSavedTopic} />
        </PreferencesProvider>
      </TestMeetingProvider>
    </AuthProvider>,
  );
  // Flush AuthProvider's initial /api/me fetch.
  await act(async () => {});
  return { onAddEntry, onSavedTopic, ...result };
}

describe('SpeakerControls — saved topics dropdown', () => {
  it('opens the dropdown with the seeded default topic on first click', async () => {
    stubMe(1);
    await renderControlsWithAuth(makeMeeting());
    const trigger = screen.getByRole('button', { name: 'Saved topics' });

    // Dropdown is closed initially.
    expect(screen.queryByRole('menu', { name: 'Saved topics' })).not.toBeInTheDocument();

    fireEvent.click(trigger);

    const menu = screen.getByRole('menu', { name: 'Saved topics' });
    expect(menu).toBeInTheDocument();
    // The default seed should be present.
    expect(screen.getByRole('menuitem', { name: '👍 I support this. (EOM)' })).toBeInTheDocument();
    // The "Edit…" entry always appears.
    expect(screen.getByRole('menuitem', { name: /Edit saved topics/ })).toBeInTheDocument();
  });

  it('calls onSavedTopic with the selected text and closes the menu', async () => {
    stubMe(1);
    const { onSavedTopic } = await renderControlsWithAuth(makeMeeting());
    fireEvent.click(screen.getByRole('button', { name: 'Saved topics' }));

    fireEvent.click(screen.getByRole('menuitem', { name: '👍 I support this. (EOM)' }));

    // The seeded default carries the New Topic priority.
    expect(onSavedTopic).toHaveBeenCalledWith('👍 I support this. (EOM)', 'topic');
    // Selecting closes the dropdown.
    expect(screen.queryByRole('menu', { name: 'Saved topics' })).not.toBeInTheDocument();
  });

  it('disables a Reply-typed saved topic when there is no active topic', async () => {
    localStorage.setItem('tcq:saved-topics:1', JSON.stringify([{ id: 'r', text: 'Good point', type: 'reply' }]));
    stubMe(1);
    const { onSavedTopic } = await renderControlsWithAuth(makeMeeting());
    fireEvent.click(screen.getByRole('button', { name: 'Saved topics' }));

    const item = screen.getByRole('menuitem', { name: /Good point/ });
    expect(item).toBeDisabled();
    expect(item).toHaveAttribute('title', 'No active topic to reply to');

    // Clicking the disabled item does nothing.
    fireEvent.click(item);
    expect(onSavedTopic).not.toHaveBeenCalled();
  });

  it('enables a Reply-typed saved topic when a topic is active', async () => {
    localStorage.setItem('tcq:saved-topics:1', JSON.stringify([{ id: 'r', text: 'Good point', type: 'reply' }]));
    stubMe(1);
    const meeting = makeMeeting({
      users: { alice: testUser },
      current: {
        topicSpeakers: [],
        topic: { speakerId: 'ct-1', userId: 'alice', topic: 'Active topic', startTime: '2026-01-01T00:00:00.000Z' },
      },
    });
    const { onSavedTopic } = await renderControlsWithAuth(meeting);
    fireEvent.click(screen.getByRole('button', { name: 'Saved topics' }));

    const item = screen.getByRole('menuitem', { name: /Good point/ });
    expect(item).toBeEnabled();
    fireEvent.click(item);
    expect(onSavedTopic).toHaveBeenCalledWith('Good point', 'reply');
  });

  it('when the queue is closed for a non-chair, disables non-Point-of-Order saved topics', async () => {
    localStorage.setItem(
      'tcq:saved-topics:1',
      JSON.stringify([
        { id: 't', text: 'A new topic', type: 'topic' },
        { id: 'p', text: 'Out of order!', type: 'point-of-order' },
      ]),
    );
    stubMe(1);
    const meeting = makeMeeting({ queue: { entries: {}, orderedIds: [], closed: true } });
    await renderControlsWithAuth(meeting);
    fireEvent.click(screen.getByRole('button', { name: 'Saved topics' }));

    const topicItem = screen.getByRole('menuitem', { name: /A new topic/ });
    expect(topicItem).toBeDisabled();
    expect(topicItem).toHaveAttribute('title', 'The queue is closed');
    // Point of Order bypasses the closed-queue gate.
    expect(screen.getByRole('menuitem', { name: /Out of order!/ })).toBeEnabled();
  });

  it('renders the empty-state message when the user has deleted every entry', async () => {
    // Pre-seed an empty list so the hook doesn't add the default back.
    localStorage.setItem('tcq:saved-topics:1', JSON.stringify([]));
    stubMe(1);
    await renderControlsWithAuth(makeMeeting());

    fireEvent.click(screen.getByRole('button', { name: 'Saved topics' }));

    expect(screen.getByText(/No saved topics yet/)).toBeInTheDocument();
    // The Edit entry is still available so the user can recover.
    expect(screen.getByRole('menuitem', { name: /Edit saved topics/ })).toBeInTheDocument();
  });

  it('Escape closes the dropdown', async () => {
    stubMe(1);
    await renderControlsWithAuth(makeMeeting());
    fireEvent.click(screen.getByRole('button', { name: 'Saved topics' }));
    expect(screen.getByRole('menu', { name: 'Saved topics' })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu', { name: 'Saved topics' })).not.toBeInTheDocument();
  });
});
