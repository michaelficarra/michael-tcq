import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import type { MeetingState, User } from '@tcq/shared';
import { SpeakerControls } from './SpeakerControls.js';
import { TestMeetingProvider } from '../test/TestMeetingProvider.js';
import { PreferencesProvider } from '../contexts/PreferencesContext.js';
import { AuthProvider } from '../contexts/AuthContext.js';
import { makeMeeting as buildMeeting, RUNNING_CURRENT } from '../test/makeMeeting.js';
import { __resetSavedTopicsCacheForTests } from '../hooks/useSavedTopics.js';

const testUser: User = {
  provider: 'github',
  accountId: 'alice',
  handle: 'alice',
  name: 'Alice',
  organisation: 'ACME',
  avatarUrl: 'https://github.com/alice.png?size=80',
};

/**
 * Meetings here default to being under way — with no agenda item current,
 * Point of Order is the only addable type and every other control is disabled,
 * which is its own rule (covered in the "no current agenda item" describe at
 * the bottom) rather than what most of these tests are about.
 */
function makeMeeting(overrides?: Partial<MeetingState>): MeetingState {
  return buildMeeting({ ...overrides, current: { ...RUNNING_CURRENT, ...overrides?.current } });
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
      users: { 'github:alice': testUser },
      current: {
        topicSpeakers: [],
        topic: {
          speakerId: 'ct-1',
          userId: 'github:alice',
          topic: 'Active topic',
          startTime: '2026-01-01T00:00:00.000Z',
        },
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
    const meeting = makeMeeting({ queue: { entries: {}, orderedIds: [], closed: true }, chairIds: ['github:alice'] });
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

  // -- No current agenda item: Point of Order only (issue #54) --
  //
  // `buildMeeting` (rather than the local `makeMeeting`) is used here so the
  // fixture keeps its pre-start `current`.

  it('disables every button but Point of Order before the meeting starts', () => {
    // Queue explicitly open, so this can only be the no-agenda-item rule.
    renderControls(buildMeeting({ queue: { entries: {}, orderedIds: [], closed: false } }));

    expect(screen.getByRole('button', { name: 'New Topic' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Clarifying Question' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Point of Order' })).toBeEnabled();
  });

  it('disables them for a chair too — unlike the closed-queue rule', () => {
    renderControls(buildMeeting({ chairIds: ['github:alice'] }));

    expect(screen.getByRole('button', { name: 'New Topic' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Clarifying Question' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Point of Order' })).toBeEnabled();
  });

  it('disables every button but Point of Order once the meeting has concluded', () => {
    // Past-final: `startedAt` set, no agenda item current.
    renderControls(buildMeeting({ current: { topicSpeakers: [], startedAt: '2026-01-01T00:00:00.000Z' } }));

    expect(screen.getByRole('button', { name: 'New Topic' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Clarifying Question' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Point of Order' })).toBeEnabled();
  });
});

// ----- Saved topics dropdown -----
//
// These tests wrap the component in a real AuthProvider so `useSavedTopics`
// can key by the user's canonical key. /api/me is stubbed so the provider
// resolves without network. Each render awaits an act() tick so the
// AuthProvider's initial fetch settles before the dropdown reads its
// (now-seeded) list.

function stubMe(username = 'alice'): void {
  globalThis.fetch = (async (url: string | URL | Request) => {
    if (String(url) === '/api/me') {
      return {
        ok: true,
        json: async () => ({
          provider: 'github',
          accountId: username.toLowerCase(),
          handle: username,
          name: username,
          organisation: '',
          avatarUrl: `https://github.com/${username.toLowerCase()}.png?size=80`,
        }),
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
    stubMe();
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
    stubMe();
    const { onSavedTopic } = await renderControlsWithAuth(makeMeeting());
    fireEvent.click(screen.getByRole('button', { name: 'Saved topics' }));

    fireEvent.click(screen.getByRole('menuitem', { name: '👍 I support this. (EOM)' }));

    // The seeded default carries the New Topic priority.
    expect(onSavedTopic).toHaveBeenCalledWith('👍 I support this. (EOM)', 'topic');
    // Selecting closes the dropdown.
    expect(screen.queryByRole('menu', { name: 'Saved topics' })).not.toBeInTheDocument();
  });

  it('disables a Reply-typed saved topic when there is no active topic', async () => {
    localStorage.setItem(
      'tcq:saved-topics:github:alice',
      JSON.stringify([{ id: 'r', text: 'Good point', type: 'reply' }]),
    );
    stubMe();
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
    localStorage.setItem(
      'tcq:saved-topics:github:alice',
      JSON.stringify([{ id: 'r', text: 'Good point', type: 'reply' }]),
    );
    stubMe();
    const meeting = makeMeeting({
      users: { 'github:alice': testUser },
      current: {
        topicSpeakers: [],
        topic: {
          speakerId: 'ct-1',
          userId: 'github:alice',
          topic: 'Active topic',
          startTime: '2026-01-01T00:00:00.000Z',
        },
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
      'tcq:saved-topics:github:alice',
      JSON.stringify([
        { id: 't', text: 'A new topic', type: 'topic' },
        { id: 'p', text: 'Out of order!', type: 'point-of-order' },
      ]),
    );
    stubMe();
    const meeting = makeMeeting({ queue: { entries: {}, orderedIds: [], closed: true } });
    await renderControlsWithAuth(meeting);
    fireEvent.click(screen.getByRole('button', { name: 'Saved topics' }));

    const topicItem = screen.getByRole('menuitem', { name: /A new topic/ });
    expect(topicItem).toBeDisabled();
    expect(topicItem).toHaveAttribute('title', 'The queue is closed');
    // Point of Order bypasses the closed-queue gate.
    expect(screen.getByRole('menuitem', { name: /Out of order!/ })).toBeEnabled();
  });

  it('when no agenda item is current, disables non-Point-of-Order saved topics', async () => {
    localStorage.setItem(
      'tcq:saved-topics:github:alice',
      JSON.stringify([
        { id: 't', text: 'A new topic', type: 'topic' },
        { id: 'p', text: 'Out of order!', type: 'point-of-order' },
      ]),
    );
    stubMe();
    // Chair, with the queue explicitly open — neither exempts this rule.
    await renderControlsWithAuth(
      buildMeeting({ chairIds: ['github:alice'], queue: { entries: {}, orderedIds: [], closed: false } }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Saved topics' }));

    const topicItem = screen.getByRole('menuitem', { name: /A new topic/ });
    expect(topicItem).toBeDisabled();
    expect(topicItem).toHaveAttribute('title', 'The meeting has not started');
    expect(screen.getByRole('menuitem', { name: /Out of order!/ })).toBeEnabled();
  });

  it('renders the empty-state message when the user has deleted every entry', async () => {
    // Pre-seed an empty list so the hook doesn't add the default back.
    localStorage.setItem('tcq:saved-topics:github:alice', JSON.stringify([]));
    stubMe();
    await renderControlsWithAuth(makeMeeting());

    fireEvent.click(screen.getByRole('button', { name: 'Saved topics' }));

    expect(screen.getByText(/No saved topics yet/)).toBeInTheDocument();
    // The Edit entry is still available so the user can recover.
    expect(screen.getByRole('menuitem', { name: /Edit saved topics/ })).toBeInTheDocument();
  });

  // Esc and outside-click dismissal now come from the native `popover="auto"`
  // element, which jsdom doesn't implement — that coverage lives in the
  // Playwright e2e suite (saved-topics.spec.ts) where a real browser drives
  // the platform light dismiss.
});
