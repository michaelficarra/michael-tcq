import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import type { MeetingState, User } from '@tcq/shared';
import { SpeakerControls } from './SpeakerControls.js';
import { TestMeetingProvider } from '../test/TestMeetingProvider.js';
import { PreferencesProvider } from '../contexts/PreferencesContext.js';
import { AuthProvider } from '../contexts/AuthContext.js';
import { makeMeeting as buildMeeting } from '../test/makeMeeting.js';
import { __resetCannedResponsesCacheForTests } from '../hooks/useCannedResponses.js';

const testUser: User = {
  ghid: 1,
  ghUsername: 'alice',
  name: 'Alice',
  organisation: 'ACME',
};

function makeMeeting(overrides?: Partial<MeetingState>): MeetingState {
  return buildMeeting(overrides);
}

function renderControls(meeting: MeetingState, onAddEntry = vi.fn(), onCannedResponse = vi.fn()) {
  return {
    onAddEntry,
    onCannedResponse,
    ...render(
      <TestMeetingProvider meeting={meeting} user={testUser}>
        <PreferencesProvider>
          <SpeakerControls onAddEntry={onAddEntry} onCannedResponse={onCannedResponse} />
        </PreferencesProvider>
      </TestMeetingProvider>,
    ),
  };
}

beforeEach(() => {
  // Each test gets a clean canned-responses cache so a previous test's
  // mutations don't leak into the next.
  localStorage.clear();
  __resetCannedResponsesCacheForTests();
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

  it('renders the canned-responses trigger button alongside the entry-type buttons', () => {
    renderControls(makeMeeting());
    expect(screen.getByRole('button', { name: 'Canned responses' })).toBeInTheDocument();
  });

  it('disables the canned-responses button when queue is closed for non-chairs', () => {
    const meeting = makeMeeting({ queue: { entries: {}, orderedIds: [], closed: true } });
    renderControls(meeting);
    expect(screen.getByRole('button', { name: 'Canned responses' })).toBeDisabled();
  });
});

// ----- Canned responses dropdown -----
//
// These tests wrap the component in a real AuthProvider so `useCannedResponses`
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

async function renderControlsWithAuth(meeting: MeetingState, onAddEntry = vi.fn(), onCannedResponse = vi.fn()) {
  const result = render(
    <AuthProvider>
      <TestMeetingProvider meeting={meeting} user={testUser}>
        <PreferencesProvider>
          <SpeakerControls onAddEntry={onAddEntry} onCannedResponse={onCannedResponse} />
        </PreferencesProvider>
      </TestMeetingProvider>
    </AuthProvider>,
  );
  // Flush AuthProvider's initial /api/me fetch.
  await act(async () => {});
  return { onAddEntry, onCannedResponse, ...result };
}

describe('SpeakerControls — canned responses dropdown', () => {
  it('opens the dropdown with the seeded default response on first click', async () => {
    stubMe(1);
    await renderControlsWithAuth(makeMeeting());
    const trigger = screen.getByRole('button', { name: 'Canned responses' });

    // Dropdown is closed initially.
    expect(screen.queryByRole('menu', { name: 'Canned responses' })).not.toBeInTheDocument();

    fireEvent.click(trigger);

    const menu = screen.getByRole('menu', { name: 'Canned responses' });
    expect(menu).toBeInTheDocument();
    // The default seed should be present.
    expect(screen.getByRole('menuitem', { name: '👍 I support this. (EOM)' })).toBeInTheDocument();
    // The "Edit…" entry always appears.
    expect(screen.getByRole('menuitem', { name: /Edit canned responses/ })).toBeInTheDocument();
  });

  it('calls onCannedResponse with the selected text and closes the menu', async () => {
    stubMe(1);
    const { onCannedResponse } = await renderControlsWithAuth(makeMeeting());
    fireEvent.click(screen.getByRole('button', { name: 'Canned responses' }));

    fireEvent.click(screen.getByRole('menuitem', { name: '👍 I support this. (EOM)' }));

    expect(onCannedResponse).toHaveBeenCalledWith('👍 I support this. (EOM)');
    // Selecting closes the dropdown.
    expect(screen.queryByRole('menu', { name: 'Canned responses' })).not.toBeInTheDocument();
  });

  it('renders the empty-state message when the user has deleted every entry', async () => {
    // Pre-seed an empty list so the hook doesn't add the default back.
    localStorage.setItem('tcq:canned-responses:1', JSON.stringify([]));
    stubMe(1);
    await renderControlsWithAuth(makeMeeting());

    fireEvent.click(screen.getByRole('button', { name: 'Canned responses' }));

    expect(screen.getByText(/No canned responses yet/)).toBeInTheDocument();
    // The Edit entry is still available so the user can recover.
    expect(screen.getByRole('menuitem', { name: /Edit canned responses/ })).toBeInTheDocument();
  });

  it('Escape closes the dropdown', async () => {
    stubMe(1);
    await renderControlsWithAuth(makeMeeting());
    fireEvent.click(screen.getByRole('button', { name: 'Canned responses' }));
    expect(screen.getByRole('menu', { name: 'Canned responses' })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu', { name: 'Canned responses' })).not.toBeInTheDocument();
  });
});
