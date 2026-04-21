import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { MeetingState, User } from '@tcq/shared';
import { MeetingPage } from './MeetingPage.js';
import { PreferencesProvider } from '../contexts/PreferencesContext.js';

// -- Mocks --

const chairUser: User = { ghid: 1, ghUsername: 'alice', name: 'Alice', organisation: 'ACME' };

vi.mock('../contexts/AuthContext.js', () => ({
  useAuth: () => ({
    user: chairUser,
    isAdmin: false,
    loading: false,
    mockAuth: false,
    switchUser: async () => {},
  }),
}));

vi.mock('../hooks/useSocketConnection.js', () => ({
  useSocketConnection: () => null,
}));

function makeMeeting(overrides?: Partial<MeetingState>): MeetingState {
  return {
    id: 'test-meeting',
    users: { alice: chairUser },
    chairIds: ['alice'],
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

// Inject meeting state into the MeetingContext by dispatching a 'state' action
// via the socket connection mock. Since we mock useSocketConnection to return null,
// we instead reach into the MeetingProvider by importing its internals.
// A simpler approach: mock useMeetingState to return pre-populated state.
const mockMeetingState = {
  meeting: null as MeetingState | null,
  user: chairUser,
  connected: true,
  activeConnections: 1,
  error: null,
};
vi.mock('../contexts/MeetingContext.js', async () => {
  const actual = await vi.importActual('../contexts/MeetingContext.js');
  return {
    ...actual,
    useMeetingState: () => mockMeetingState,
    useMeetingDispatch: () => () => {},
    useIsChair: () => true,
  };
});

/** Render the MeetingPage at /meeting/test with the given hash. */
function renderMeetingPage(hash = '') {
  window.location.hash = hash;
  return render(
    <PreferencesProvider>
      <MemoryRouter initialEntries={[`/meeting/test${hash}`]}>
        <Routes>
          <Route path="/meeting/:id" element={<MeetingPage />} />
        </Routes>
      </MemoryRouter>
    </PreferencesProvider>,
  );
}

// -- Tests --

let savedHash: string;

beforeEach(() => {
  savedHash = window.location.hash;
  mockMeetingState.meeting = makeMeeting();
});

afterEach(() => {
  window.location.hash = savedHash;
});

describe('MeetingPage tab–hash sync', () => {
  describe('initial tab from hash', () => {
    it('defaults to the queue tab when there is no hash', () => {
      renderMeetingPage();
      expect(screen.getByRole('tab', { name: 'Queue' })).toHaveAttribute('aria-selected', 'true');
    });

    it('selects the agenda tab when hash is #agenda', () => {
      renderMeetingPage('#agenda');
      expect(screen.getByRole('tab', { name: 'Agenda' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByRole('tab', { name: 'Queue' })).toHaveAttribute('aria-selected', 'false');
    });

    it('selects the log tab when hash is #log', () => {
      renderMeetingPage('#log');
      expect(screen.getByRole('tab', { name: 'Log' })).toHaveAttribute('aria-selected', 'true');
    });

    it('selects the help tab when hash is #help', () => {
      renderMeetingPage('#help');
      expect(screen.getByRole('tab', { name: 'Help' })).toHaveAttribute('aria-selected', 'true');
    });

    it('falls back to queue for an invalid hash', () => {
      renderMeetingPage('#nonsense');
      expect(screen.getByRole('tab', { name: 'Queue' })).toHaveAttribute('aria-selected', 'true');
    });
  });

  describe('tab change updates hash', () => {
    it('updates the hash when a tab is clicked', () => {
      renderMeetingPage();
      fireEvent.click(screen.getByRole('tab', { name: 'Agenda' }));
      expect(window.location.hash).toBe('#agenda');
    });

    it('updates the hash for each successive tab click', () => {
      renderMeetingPage();
      fireEvent.click(screen.getByRole('tab', { name: 'Log' }));
      expect(window.location.hash).toBe('#log');

      fireEvent.click(screen.getByRole('tab', { name: 'Help' }));
      expect(window.location.hash).toBe('#help');

      fireEvent.click(screen.getByRole('tab', { name: 'Queue' }));
      expect(window.location.hash).toBe('#queue');
    });
  });

  describe('hashchange updates the active tab', () => {
    it('switches tab when the hash changes externally', () => {
      renderMeetingPage('#queue');
      expect(screen.getByRole('tab', { name: 'Queue' })).toHaveAttribute('aria-selected', 'true');

      act(() => {
        window.location.hash = '#agenda';
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      });

      expect(screen.getByRole('tab', { name: 'Agenda' })).toHaveAttribute('aria-selected', 'true');
    });

    it('ignores invalid hash values', () => {
      renderMeetingPage('#queue');

      act(() => {
        window.location.hash = '#invalid';
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      });

      // Should remain on queue
      expect(screen.getByRole('tab', { name: 'Queue' })).toHaveAttribute('aria-selected', 'true');
    });
  });

  describe('presentation mode', () => {
    /** Enter presentation mode by pressing the 'f' shortcut key. */
    function enterPresentationMode() {
      act(() => {
        fireEvent.keyDown(document, { key: 'f' });
      });
    }

    it('renders the agenda panel in presentation mode', () => {
      renderMeetingPage('#agenda');
      enterPresentationMode();
      expect(screen.getByRole('tabpanel', { name: 'Agenda' })).toBeInTheDocument();
    });

    it('renders the queue panel in presentation mode', () => {
      renderMeetingPage('#queue');
      enterPresentationMode();
      expect(screen.getByRole('tabpanel', { name: 'Queue' })).toBeInTheDocument();
    });

    it('renders the log panel in presentation mode', () => {
      renderMeetingPage('#log');
      enterPresentationMode();
      expect(screen.getByRole('tabpanel', { name: 'Log' })).toBeInTheDocument();
    });

    it('renders the help panel in presentation mode', () => {
      renderMeetingPage('#help');
      enterPresentationMode();
      expect(screen.getByRole('tabpanel', { name: 'Help' })).toBeInTheDocument();
    });
  });
});
