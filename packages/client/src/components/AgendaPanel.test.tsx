import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { MeetingState, User } from '@tcq/shared';
import { AgendaPanel } from './AgendaPanel.js';
import { TestMeetingProvider } from '../test/TestMeetingProvider.js';
import { makeMeeting as buildMeeting } from '../test/makeMeeting.js';
import { SocketContext, type TypedSocket } from '../contexts/SocketContext.js';

// Mock useAuth so we can control isAdmin flag
let mockAuthState = {
  user: null as User | null,
  isAdmin: false,
  loading: false,
  mockAuth: false,
  switchUser: async () => {},
};
vi.mock('../contexts/AuthContext.js', () => ({
  useAuth: () => mockAuthState,
}));

/** Create a minimal meeting state for testing. */
function makeMeeting(overrides?: Partial<MeetingState>): MeetingState {
  return buildMeeting(overrides);
}

const chairUser: User = {
  provider: 'github',
  accountId: 'alice',
  handle: 'alice',
  name: 'Alice',
  organisation: 'ACME',
  avatarUrl: 'https://github.com/alice.png?size=80',
};

/** Render the AgendaPanel with meeting context and optional socket. */
function renderAgenda(meeting: MeetingState, user: User | null = null, socket: TypedSocket | null = null) {
  return render(
    <TestMeetingProvider meeting={meeting} user={user}>
      <SocketContext value={socket}>
        <AgendaPanel />
      </SocketContext>
    </TestMeetingProvider>,
  );
}

describe('AgendaPanel', () => {
  it('shows "No agenda items yet" when the agenda is empty', () => {
    renderAgenda(makeMeeting());
    expect(screen.getByText(/no agenda items yet/i)).toBeInTheDocument();
  });

  it('displays agenda items as a numbered list', () => {
    const meeting = makeMeeting({
      users: { 'github:alice': chairUser },
      agenda: [
        { kind: 'item', id: '1', name: 'First item', presenterIds: ['github:alice'], duration: 20 },
        { kind: 'item', id: '2', name: 'Second item', presenterIds: ['github:alice'] },
      ],
    });
    renderAgenda(meeting);

    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('First item')).toBeInTheDocument();
    expect(screen.getByText('20m')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('Second item')).toBeInTheDocument();
  });

  it('shows the "New Agenda Item" button for chairs', () => {
    const meeting = makeMeeting({ users: { 'github:alice': chairUser }, chairIds: ['github:alice'] });
    renderAgenda(meeting, chairUser);

    expect(screen.getByText('New Agenda Item')).toBeInTheDocument();
  });

  it('hides the "New Agenda Item" button for non-chairs', () => {
    const meeting = makeMeeting({
      users: {
        'github:other': {
          provider: 'github',
          accountId: 'other',
          handle: 'other',
          name: 'Other',
          organisation: '',
          avatarUrl: 'https://github.com/other.png?size=80',
        },
      },
      chairIds: ['github:other'],
    });
    renderAgenda(meeting, chairUser);

    expect(screen.queryByText('New Agenda Item')).not.toBeInTheDocument();
  });

  it('shows the agenda form when "New Agenda Item" is clicked', () => {
    const meeting = makeMeeting({ users: { 'github:alice': chairUser }, chairIds: ['github:alice'] });
    renderAgenda(meeting, chairUser);

    fireEvent.click(screen.getByText('New Agenda Item'));

    expect(screen.getByLabelText('Agenda Item Name')).toBeInTheDocument();
    expect(screen.getByLabelText('Presenters')).toBeInTheDocument();
    expect(screen.getByLabelText('Estimate')).toBeInTheDocument();
  });

  it('shows delete buttons for chairs', () => {
    const meeting = makeMeeting({
      users: { 'github:alice': chairUser },
      chairIds: ['github:alice'],
      agenda: [{ kind: 'item', id: '1', name: 'Deletable item', presenterIds: ['github:alice'] }],
    });
    renderAgenda(meeting, chairUser);

    expect(screen.getByRole('button', { name: /delete deletable item/i })).toBeInTheDocument();
  });

  it('hides delete buttons for non-chairs', () => {
    const meeting = makeMeeting({
      users: {
        'github:other': {
          provider: 'github',
          accountId: 'other',
          handle: 'other',
          name: 'Other',
          organisation: '',
          avatarUrl: 'https://github.com/other.png?size=80',
        },
        'github:alice': chairUser,
      },
      chairIds: ['github:other'],
      agenda: [{ kind: 'item', id: '1', name: 'Item', presenterIds: ['github:alice'] }],
    });
    renderAgenda(meeting, chairUser);

    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
  });

  it('hides the delete button for the current agenda item', () => {
    // The chair must advance off an item (Next Agenda Item) before it can
    // be deleted — discussion is in progress.
    const meeting = makeMeeting({
      users: { 'github:alice': chairUser },
      chairIds: ['github:alice'],
      agenda: [
        { kind: 'item', id: 'item-current', name: 'Currently discussing', presenterIds: ['github:alice'] },
        { kind: 'item', id: 'item-next', name: 'Next up', presenterIds: ['github:alice'] },
      ],
      current: { topicSpeakers: [], agendaItemId: 'item-current' },
    });
    renderAgenda(meeting, chairUser);

    // Edit button stays available for the current item; delete does not.
    expect(screen.getByRole('button', { name: /edit currently discussing/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete currently discussing/i })).not.toBeInTheDocument();
    // Other items (not current) still have the delete button.
    expect(screen.getByRole('button', { name: /delete next up/i })).toBeInTheDocument();
  });

  it('emits agenda:delete when delete button is clicked', () => {
    const emit = vi.fn();
    const mockSocket = { emit } as unknown as TypedSocket;

    const meeting = makeMeeting({
      users: { 'github:alice': chairUser },
      chairIds: ['github:alice'],
      agenda: [{ kind: 'item', id: 'item-1', name: 'To delete', presenterIds: ['github:alice'] }],
    });
    renderAgenda(meeting, chairUser, mockSocket);

    fireEvent.click(screen.getByRole('button', { name: /delete to delete/i }));
    expect(emit).toHaveBeenCalledWith('agenda:delete', { id: 'item-1' });
  });

  it('renders a badge per presenter when an item has multiple', () => {
    const alice = {
      provider: 'github',
      accountId: 'alice',
      handle: 'alice',
      name: 'Alice',
      organisation: 'A Corp',
      avatarUrl: 'https://github.com/alice.png?size=80',
    };
    const bob = {
      provider: 'github',
      accountId: 'bob',
      handle: 'bob',
      name: 'Bob',
      organisation: 'B Corp',
      avatarUrl: 'https://github.com/bob.png?size=80',
    };
    const meeting = makeMeeting({
      users: { 'github:alice': alice, 'github:bob': bob },
      agenda: [{ kind: 'item', id: '1', name: 'Joint', presenterIds: ['github:alice', 'github:bob'] }],
    });
    renderAgenda(meeting);

    // Both users' names appear alongside the item.
    expect(screen.getByText(/Alice/)).toBeInTheDocument();
    expect(screen.getByText(/Bob/)).toBeInTheDocument();
  });

  it('highlights items where the viewer is any of the presenters', () => {
    const bob = {
      provider: 'github',
      accountId: 'bob',
      handle: 'bob',
      name: 'Bob',
      organisation: '',
      avatarUrl: 'https://github.com/bob.png?size=80',
    };
    const meeting = makeMeeting({
      users: { 'github:alice': chairUser, 'github:bob': bob },
      agenda: [{ kind: 'item', id: '1', name: 'Joint', presenterIds: ['github:bob', 'github:alice'] }],
    });
    renderAgenda(meeting, chairUser);

    const li = screen.getByText('Joint').closest('li')!;
    expect(li.className).toMatch(/border-l-teal-500/);
  });

  it('shows presenter organisation in parentheses', () => {
    const meeting = makeMeeting({
      users: {
        'github:alice': {
          provider: 'github',
          accountId: 'alice',
          handle: 'alice',
          name: 'Alice',
          organisation: 'ACME Corp',
          avatarUrl: 'https://github.com/alice.png?size=80',
        },
      },
      agenda: [
        {
          kind: 'item',
          id: '1',
          name: 'Test',
          presenterIds: ['github:alice'],
        },
      ],
    });
    renderAgenda(meeting);

    expect(screen.getByText(/ACME Corp/)).toBeInTheDocument();
  });

  describe('Current item styling', () => {
    const a: User = {
      provider: 'github',
      accountId: 'a',
      handle: 'a',
      name: 'A',
      organisation: '',
      avatarUrl: 'https://github.com/a.png?size=80',
    };

    it('dims items strictly before the current one and highlights the current item', () => {
      const meeting = makeMeeting({
        users: { a },
        agenda: [
          { kind: 'item', id: '1', name: 'Past item', presenterIds: ['github:a'] },
          { kind: 'item', id: '2', name: 'Current item', presenterIds: ['github:a'] },
          { kind: 'item', id: '3', name: 'Upcoming item', presenterIds: ['github:a'] },
        ],
        current: { agendaItemId: '2', topicSpeakers: [] },
      });
      renderAgenda(meeting);

      const pastLi = screen.getByText('Past item').closest('li')!;
      const currentLi = screen.getByText('Current item').closest('li')!;
      const upcomingLi = screen.getByText('Upcoming item').closest('li')!;

      // Past: dimmed, NOT orange.
      expect(pastLi.className).toMatch(/opacity-60/);
      expect(pastLi.className).not.toMatch(/bg-orange-100/);

      // Current: orange, NOT dimmed.
      expect(currentLi.className).toMatch(/bg-orange-100/);
      expect(currentLi.className).not.toMatch(/opacity-60/);

      // Upcoming: neither.
      expect(upcomingLi.className).not.toMatch(/opacity-60/);
      expect(upcomingLi.className).not.toMatch(/bg-orange-100/);
    });

    it('gives the current item emphatic, higher-contrast text', () => {
      const meeting = makeMeeting({
        users: { a },
        agenda: [{ kind: 'item', id: '1', name: 'The current one', presenterIds: ['github:a'] }],
        current: { agendaItemId: '1', topicSpeakers: [] },
      });
      renderAgenda(meeting);

      // The item-name span picks up the emphatic class bundle on the current row.
      const nameEl = screen.getByText('The current one');
      expect(nameEl.className).toMatch(/font-semibold/);
      expect(nameEl.className).toMatch(/text-stone-900/);
    });

    it('does not dim or highlight anything when no item is current', () => {
      const meeting = makeMeeting({
        users: { a },
        agenda: [
          { kind: 'item', id: '1', name: 'Alpha', presenterIds: ['github:a'] },
          { kind: 'item', id: '2', name: 'Beta', presenterIds: ['github:a'] },
        ],
      });
      renderAgenda(meeting);

      for (const name of ['Alpha', 'Beta']) {
        const li = screen.getByText(name).closest('li')!;
        expect(li.className).not.toMatch(/opacity-60/);
        expect(li.className).not.toMatch(/bg-orange-100/);
      }
    });

    it('shows the conclusion under a past item that has one', () => {
      const meeting = makeMeeting({
        users: { a },
        agenda: [
          { kind: 'item', id: '1', name: 'Past', presenterIds: ['github:a'], conclusion: 'agreed unanimously' },
          { kind: 'item', id: '2', name: 'Current', presenterIds: ['github:a'] },
        ],
        current: { agendaItemId: '2', topicSpeakers: [] },
      });
      renderAgenda(meeting);

      expect(screen.getByText('agreed unanimously')).toBeInTheDocument();
    });

    it('shows conclusions on every item in the past-final state (no current item, but meeting has started)', () => {
      // Once the chair advances past the final item, `agendaItemId` is
      // undefined but `startedAt` is set — every item is now in the past
      // and any saved conclusions (including the one just recorded for
      // the final item via the Conclude meeting dialog) must surface on
      // the agenda.
      const meeting = makeMeeting({
        users: { a },
        agenda: [
          { kind: 'item', id: '1', name: 'First', presenterIds: ['github:a'], conclusion: 'first conclusion' },
          { kind: 'item', id: '2', name: 'Final', presenterIds: ['github:a'], conclusion: 'final conclusion' },
        ],
        current: { topicSpeakers: [], startedAt: '2026-04-01T10:00:00.000Z' },
      });
      renderAgenda(meeting);

      expect(screen.getByText('first conclusion')).toBeInTheDocument();
      expect(screen.getByText('final conclusion')).toBeInTheDocument();
    });

    it('does not show a conclusion on the current or upcoming items even if one is set', () => {
      // Setting `conclusion` on a current/future item should never happen in
      // practice (the dialog only writes on advance), but if it did the UI
      // must not surface it on those rows.
      const meeting = makeMeeting({
        users: { a },
        agenda: [
          { kind: 'item', id: '1', name: 'Past', presenterIds: ['github:a'] },
          {
            kind: 'item',
            id: '2',
            name: 'Current',
            presenterIds: ['github:a'],
            conclusion: 'should be hidden — current',
          },
          {
            kind: 'item',
            id: '3',
            name: 'Upcoming',
            presenterIds: ['github:a'],
            conclusion: 'should be hidden — upcoming',
          },
        ],
        current: { agendaItemId: '2', topicSpeakers: [] },
      });
      renderAgenda(meeting);

      expect(screen.queryByText('should be hidden — current')).not.toBeInTheDocument();
      expect(screen.queryByText('should be hidden — upcoming')).not.toBeInTheDocument();
    });
  });

  describe('Auto-scroll on tab visibility', () => {
    const a: User = {
      provider: 'github',
      accountId: 'a',
      handle: 'a',
      name: 'A',
      organisation: '',
      avatarUrl: 'https://github.com/a.png?size=80',
    };

    // jsdom doesn't implement scrollIntoView; stub on Element.prototype.
    let scrollSpy: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      scrollSpy = vi.fn();
      Element.prototype.scrollIntoView = scrollSpy;
    });

    it('tags the current row with the tcq-agenda-current-item marker class', () => {
      const meeting = makeMeeting({
        users: { a },
        agenda: [
          { kind: 'item', id: '1', name: 'Past', presenterIds: ['github:a'] },
          { kind: 'item', id: '2', name: 'Current', presenterIds: ['github:a'] },
          { kind: 'item', id: '3', name: 'Upcoming', presenterIds: ['github:a'] },
        ],
        current: { agendaItemId: '2', topicSpeakers: [] },
      });
      renderAgenda(meeting);

      const currentLi = screen.getByText('Current').closest('li')!;
      expect(currentLi.className).toMatch(/tcq-agenda-current-item/);
      expect(screen.getByText('Past').closest('li')!.className).not.toMatch(/tcq-agenda-current-item/);
      expect(screen.getByText('Upcoming').closest('li')!.className).not.toMatch(/tcq-agenda-current-item/);
    });

    it('scrolls the current item into view when the panel transitions from hidden to visible', () => {
      const meeting = makeMeeting({
        users: { a },
        agenda: [
          { kind: 'item', id: '1', name: 'Past', presenterIds: ['github:a'] },
          { kind: 'item', id: '2', name: 'Current', presenterIds: ['github:a'] },
        ],
        current: { agendaItemId: '2', topicSpeakers: [] },
      });

      const { rerender } = render(
        <TestMeetingProvider meeting={meeting}>
          <AgendaPanel hidden />
        </TestMeetingProvider>,
      );
      // While hidden, the inner content (and therefore the current row) isn't rendered, so no scroll.
      expect(scrollSpy).not.toHaveBeenCalled();

      // Reveal the panel.
      rerender(
        <TestMeetingProvider meeting={meeting}>
          <AgendaPanel hidden={false} />
        </TestMeetingProvider>,
      );

      expect(scrollSpy).toHaveBeenCalledTimes(1);
      expect(scrollSpy).toHaveBeenCalledWith({ block: 'center', behavior: 'auto' });
    });

    it('scrolls on initial mount when the panel starts visible with a current item set', () => {
      const meeting = makeMeeting({
        users: { a },
        agenda: [{ kind: 'item', id: '1', name: 'Only', presenterIds: ['github:a'] }],
        current: { agendaItemId: '1', topicSpeakers: [] },
      });
      renderAgenda(meeting);

      expect(scrollSpy).toHaveBeenCalledTimes(1);
    });

    it('does not scroll when the current item changes while the panel is already visible', () => {
      const meeting = makeMeeting({
        users: { a },
        agenda: [
          { kind: 'item', id: '1', name: 'First', presenterIds: ['github:a'] },
          { kind: 'item', id: '2', name: 'Second', presenterIds: ['github:a'] },
        ],
        current: { agendaItemId: '1', topicSpeakers: [] },
      });

      const { rerender } = render(
        <TestMeetingProvider meeting={meeting}>
          <AgendaPanel hidden={false} />
        </TestMeetingProvider>,
      );
      expect(scrollSpy).toHaveBeenCalledTimes(1); // initial mount counts as a visibility edge

      // Chair advances — current item changes but visibility doesn't.
      const advanced = makeMeeting({
        users: { a },
        agenda: meeting.agenda,
        current: { agendaItemId: '2', topicSpeakers: [] },
      });
      rerender(
        <TestMeetingProvider meeting={advanced}>
          <AgendaPanel hidden={false} />
        </TestMeetingProvider>,
      );

      // Still one call — advancement alone must not trigger an auto-scroll.
      expect(scrollSpy).toHaveBeenCalledTimes(1);
    });

    it('does not scroll when there is no current item', () => {
      const meeting = makeMeeting({
        users: { a },
        agenda: [{ kind: 'item', id: '1', name: 'Only', presenterIds: ['github:a'] }],
        // No current.agendaItemId — meeting hasn't started.
      });

      const { rerender } = render(
        <TestMeetingProvider meeting={meeting}>
          <AgendaPanel hidden />
        </TestMeetingProvider>,
      );
      rerender(
        <TestMeetingProvider meeting={meeting}>
          <AgendaPanel hidden={false} />
        </TestMeetingProvider>,
      );

      expect(scrollSpy).not.toHaveBeenCalled();
    });
  });

  describe('Chair management', () => {
    const otherChair: User = {
      provider: 'github',
      accountId: 'bob',
      handle: 'bob',
      name: 'Bob',
      organisation: '',
      avatarUrl: 'https://github.com/bob.png?size=80',
    };

    it('shows remove buttons for chairs on other chairs', () => {
      mockAuthState = { ...mockAuthState, user: chairUser, isAdmin: false };
      const meeting = makeMeeting({
        users: { 'github:alice': chairUser, 'github:bob': otherChair },
        chairIds: ['github:alice', 'github:bob'],
      });
      renderAgenda(meeting, chairUser);

      // Should see remove button for bob but not for alice (self)
      expect(screen.getByRole('button', { name: /remove chair bob/i })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /remove chair alice/i })).not.toBeInTheDocument();
    });

    it('non-chairs do not see remove buttons', () => {
      mockAuthState = { ...mockAuthState, user: chairUser, isAdmin: false };
      const meeting = makeMeeting({
        users: { 'github:bob': otherChair },
        chairIds: ['github:bob'],
      });
      renderAgenda(meeting, chairUser);

      expect(screen.queryByRole('button', { name: /remove chair/i })).not.toBeInTheDocument();
    });

    it('admins see remove buttons on all chairs including themselves', () => {
      mockAuthState = { ...mockAuthState, user: chairUser, isAdmin: true };
      const meeting = makeMeeting({
        users: { 'github:alice': chairUser, 'github:bob': otherChair },
        chairIds: ['github:alice', 'github:bob'],
      });
      renderAgenda(meeting, chairUser);

      expect(screen.getByRole('button', { name: /remove chair alice/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /remove chair bob/i })).toBeInTheDocument();
    });

    it('shows confirmation modal before removing a chair', () => {
      mockAuthState = { ...mockAuthState, user: chairUser, isAdmin: false };
      const meeting = makeMeeting({
        users: { 'github:alice': chairUser, 'github:bob': otherChair },
        chairIds: ['github:alice', 'github:bob'],
      });
      renderAgenda(meeting, chairUser);

      fireEvent.click(screen.getByRole('button', { name: /remove chair bob/i }));

      expect(screen.getByText(/remove chair/i)).toBeInTheDocument();
      expect(screen.getByText(/bob/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^remove$/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
    });

    it('emits meeting:updateChairs without the removed chair', () => {
      const emit = vi.fn();
      const mockSocket = { emit } as unknown as TypedSocket;
      mockAuthState = { ...mockAuthState, user: chairUser, isAdmin: false };
      const meeting = makeMeeting({
        users: { 'github:alice': chairUser, 'github:bob': otherChair },
        chairIds: ['github:alice', 'github:bob'],
      });
      renderAgenda(meeting, chairUser, mockSocket);

      fireEvent.click(screen.getByRole('button', { name: /remove chair bob/i }));
      fireEvent.click(screen.getByRole('button', { name: /^remove$/i }));

      // The remaining chair is re-emitted as its concrete account identity
      // (provider + accountId), not a handle.
      expect(emit).toHaveBeenCalledWith('meeting:updateChairs', {
        chairs: [{ provider: 'github', accountId: 'alice' }],
      });
    });

    it('shows add chair button for chairs', () => {
      mockAuthState = { ...mockAuthState, user: chairUser, isAdmin: false };
      const meeting = makeMeeting({ users: { 'github:alice': chairUser }, chairIds: ['github:alice'] });
      renderAgenda(meeting, chairUser);

      expect(screen.getByRole('button', { name: /add chair/i })).toBeInTheDocument();
    });

    it('hides add chair button for non-chairs', () => {
      mockAuthState = { ...mockAuthState, user: chairUser, isAdmin: false };
      const meeting = makeMeeting({ users: { 'github:bob': otherChair }, chairIds: ['github:bob'] });
      renderAgenda(meeting, chairUser);

      expect(screen.queryByRole('button', { name: /add chair/i })).not.toBeInTheDocument();
    });

    it('shows username input when add button is clicked', () => {
      mockAuthState = { ...mockAuthState, user: chairUser, isAdmin: false };
      const meeting = makeMeeting({ users: { 'github:alice': chairUser }, chairIds: ['github:alice'] });
      renderAgenda(meeting, chairUser);

      fireEvent.click(screen.getByRole('button', { name: /add chair/i }));

      expect(screen.getByLabelText(/new chair username/i)).toBeInTheDocument();
    });

    it('emits meeting:updateChairs with new chair added', () => {
      const emit = vi.fn();
      const mockSocket = { emit } as unknown as TypedSocket;
      mockAuthState = { ...mockAuthState, user: chairUser, isAdmin: false };
      const meeting = makeMeeting({ users: { 'github:alice': chairUser }, chairIds: ['github:alice'] });
      renderAgenda(meeting, chairUser, mockSocket);

      fireEvent.click(screen.getByRole('button', { name: /add chair/i }));
      const input = screen.getByLabelText(/new chair username/i);
      fireEvent.change(input, { target: { value: 'newperson' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      // Existing chair re-emitted as identity; the typed-but-unpicked new
      // chair commits as a bare handle (the server resolves it).
      expect(emit).toHaveBeenCalledWith('meeting:updateChairs', {
        chairs: [{ provider: 'github', accountId: 'alice' }, { handle: 'newperson' }],
      });
    });

    it('does not add a duplicate chair when re-picking an existing identity from suggestions', async () => {
      const emit = vi.fn();
      const mockSocket = { emit } as unknown as TypedSocket;
      mockAuthState = { ...mockAuthState, user: chairUser, isAdmin: false };
      const meeting = makeMeeting({ users: { 'github:alice': chairUser }, chairIds: ['github:alice'] });

      // Stub autocomplete to return alice's account, so picking her commits
      // a `{user}` whose identity matches the existing chair and dedupes.
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(
        async () =>
          new Response(JSON.stringify({ suggestions: [{ user: chairUser }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      ) as unknown as typeof fetch;

      try {
        renderAgenda(meeting, chairUser, mockSocket);

        fireEvent.click(screen.getByRole('button', { name: /add chair/i }));
        const input = screen.getByLabelText(/new chair username/i);
        fireEvent.change(input, { target: { value: 'alice' } });

        // Wait for the suggestion to appear, then pick it.
        const option = await screen.findByRole('option', { name: /alice/i });
        fireEvent.mouseDown(option, { button: 0 });

        // The picked identity already exists in the chair list, so the
        // emitted list is unchanged (just alice's identity).
        expect(emit).toHaveBeenCalledWith('meeting:updateChairs', {
          chairs: [{ provider: 'github', accountId: 'alice' }],
        });
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    // Users may type or paste handles in GitHub-style `@name` form; the
    // chair-add input strips a leading `@` and surrounding whitespace
    // before the username is added.
    it('strips a leading @ and surrounding whitespace from the new chair username', () => {
      const emit = vi.fn();
      const mockSocket = { emit } as unknown as TypedSocket;
      mockAuthState = { ...mockAuthState, user: chairUser, isAdmin: false };
      const meeting = makeMeeting({ users: { 'github:alice': chairUser }, chairIds: ['github:alice'] });
      renderAgenda(meeting, chairUser, mockSocket);

      fireEvent.click(screen.getByRole('button', { name: /add chair/i }));
      const input = screen.getByLabelText(/new chair username/i);
      fireEvent.change(input, { target: { value: ' @newperson ' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(emit).toHaveBeenCalledWith('meeting:updateChairs', {
        chairs: [{ provider: 'github', accountId: 'alice' }, { handle: 'newperson' }],
      });
    });
  });

  describe('inline edit', () => {
    // Edit the presenters of an existing item via the chip combobox: each
    // typed-and-Enter'd handle is normalised before becoming a token.
    it('strips a leading @ and surrounding whitespace from edited presenters', () => {
      const emit = vi.fn();
      const mockSocket = { emit } as unknown as TypedSocket;
      mockAuthState = { ...mockAuthState, user: chairUser, isAdmin: false };
      const meeting = makeMeeting({
        users: { 'github:alice': chairUser },
        chairIds: ['github:alice'],
        agenda: [{ kind: 'item', id: '1', name: 'Topic', presenterIds: ['github:alice'] }],
      });
      renderAgenda(meeting, chairUser, mockSocket);

      // Open the inline edit form on the only item
      fireEvent.click(screen.getByRole('button', { name: /^edit topic$/i }));

      // Drop the auto-prefilled 'alice' chip, then add three new ones.
      fireEvent.click(screen.getByLabelText('Remove alice'));
      const presentersInput = screen.getByLabelText('Presenters');
      for (const raw of [' @alice ', ' @ bob', 'charlie']) {
        fireEvent.change(presentersInput, { target: { value: raw } });
        fireEvent.keyDown(presentersInput, { key: 'Enter' });
      }

      fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

      expect(emit).toHaveBeenCalledWith('agenda:edit', {
        id: '1',
        name: 'Topic',
        presenters: [{ handle: 'alice' }, { handle: 'bob' }, { handle: 'charlie' }],
        duration: null,
      });
    });
  });

  describe('sessions', () => {
    it('shows the "New Session" button for chairs alongside "New Agenda Item"', () => {
      const meeting = makeMeeting({ users: { 'github:alice': chairUser }, chairIds: ['github:alice'] });
      renderAgenda(meeting, chairUser);

      expect(screen.getByText('New Agenda Item')).toBeInTheDocument();
      expect(screen.getByText('New Session')).toBeInTheDocument();
    });

    it('hides the "New Session" button for non-chairs', () => {
      const meeting = makeMeeting({
        users: {
          'github:other': {
            provider: 'github',
            accountId: 'other',
            handle: 'other',
            name: 'Other',
            organisation: '',
            avatarUrl: 'https://github.com/other.png?size=80',
          },
        },
        chairIds: ['github:other'],
      });
      renderAgenda(meeting, chairUser);

      expect(screen.queryByText('New Session')).not.toBeInTheDocument();
    });

    it('opens a session form and emits session:add on submit', () => {
      const emit = vi.fn();
      const mockSocket = { emit } as unknown as TypedSocket;
      const meeting = makeMeeting({ users: { 'github:alice': chairUser }, chairIds: ['github:alice'] });
      renderAgenda(meeting, chairUser, mockSocket);

      fireEvent.click(screen.getByText('New Session'));
      fireEvent.change(screen.getByLabelText(/session name/i), { target: { value: 'Morning block' } });
      fireEvent.change(screen.getByLabelText(/^capacity$/i), { target: { value: '90' } });
      fireEvent.submit(screen.getByLabelText(/session name/i));

      expect(emit).toHaveBeenCalledWith('session:add', { name: 'Morning block', capacity: 90 });
    });

    it('renders a session header with capacity / used / remaining', () => {
      const meeting = makeMeeting({
        users: { 'github:alice': chairUser },
        agenda: [
          { kind: 'session', id: 's1', name: 'Morning', capacity: 90 },
          { kind: 'item', id: 'a', name: 'First', presenterIds: ['github:alice'], duration: 15 },
          { kind: 'item', id: 'b', name: 'Second', presenterIds: ['github:alice'], duration: 30 },
        ],
      });
      renderAgenda(meeting);

      // "Morning" session header present (rendered in upper case by Tailwind
      // but the text node itself preserves the original casing).
      expect(screen.getByText('Morning')).toBeInTheDocument();
      // Capacity 1h 30m, used 45m, remaining 45m.
      expect(screen.getByText('1h 30m')).toBeInTheDocument();
      // Two "45m" elements: one for used, one for remaining.
      expect(screen.getAllByText('45m').length).toBeGreaterThanOrEqual(2);
      expect(screen.getByText(/remaining/i)).toBeInTheDocument();
    });

    it('flips to "overflow" label when the run exceeds capacity', () => {
      const meeting = makeMeeting({
        users: { 'github:alice': chairUser },
        agenda: [
          { kind: 'session', id: 's1', name: 'Tight', capacity: 30 },
          { kind: 'item', id: 'a', name: 'First', presenterIds: ['github:alice'], duration: 15 },
          { kind: 'item', id: 'b', name: 'Second', presenterIds: ['github:alice'], duration: 15 },
          { kind: 'item', id: 'c', name: 'Third', presenterIds: ['github:alice'], duration: 10 },
        ],
      });
      renderAgenda(meeting);

      // Capacity 30m, used 30m (first two fit exactly), overflow = 40 - 30 = 10m.
      // Two "overflow" labels render: the session header's status and the
      // auto-inserted overflow subsection divider above the third item.
      expect(screen.getAllByText(/overflow/i).length).toBeGreaterThanOrEqual(2);
      expect(screen.queryByText(/remaining/i)).not.toBeInTheDocument();
      // Both the session overflow amount and the "Third" item render as "10m".
      // Presence of at least two matching nodes confirms the overflow amount is shown.
      expect(screen.getAllByText('10m').length).toBeGreaterThanOrEqual(2);
    });

    it('renders an "overflow" subsection divider before the first overflowing item', () => {
      const meeting = makeMeeting({
        users: { 'github:alice': chairUser },
        agenda: [
          { kind: 'session', id: 's1', name: 'Tight', capacity: 30 },
          { kind: 'item', id: 'a', name: 'First', presenterIds: ['github:alice'], duration: 15 },
          { kind: 'item', id: 'b', name: 'Second', presenterIds: ['github:alice'], duration: 15 },
          { kind: 'item', id: 'c', name: 'Third', presenterIds: ['github:alice'], duration: 10 },
        ],
      });
      const { container } = renderAgenda(meeting);

      const overflowHeader = container.querySelector('[aria-label="Overflow"]');
      expect(overflowHeader).not.toBeNull();
      // The overflow header must sit between the last contained item ("Second")
      // and the first overflowing item ("Third"), inside the agenda list.
      const list = container.querySelector('ol[aria-label="Agenda items"]');
      expect(list).not.toBeNull();
      const children = Array.from(list!.children);
      const overflowIndex = children.findIndex((el) => el.getAttribute('aria-label') === 'Overflow');
      const secondIndex = children.findIndex((el) => (el.textContent ?? '').includes('Second'));
      const thirdIndex = children.findIndex((el) => (el.textContent ?? '').includes('Third'));
      expect(overflowIndex).toBeGreaterThan(secondIndex);
      expect(overflowIndex).toBeLessThan(thirdIndex);
    });

    it('does not render an "overflow" subsection divider when the run fits', () => {
      const meeting = makeMeeting({
        users: { 'github:alice': chairUser },
        agenda: [
          { kind: 'session', id: 's1', name: 'Roomy', capacity: 60 },
          { kind: 'item', id: 'a', name: 'First', presenterIds: ['github:alice'], duration: 15 },
          { kind: 'item', id: 'b', name: 'Second', presenterIds: ['github:alice'], duration: 15 },
        ],
      });
      const { container } = renderAgenda(meeting);

      expect(container.querySelector('[aria-label="Overflow"]')).toBeNull();
    });

    it('hides the in-list overflow indicators for a concluded (past-final) session but keeps the header count', () => {
      const meeting = makeMeeting({
        users: { 'github:alice': chairUser },
        agenda: [
          { kind: 'session', id: 's1', name: 'Tight', capacity: 30 },
          { kind: 'item', id: 'a', name: 'First', presenterIds: ['github:alice'], duration: 15 },
          { kind: 'item', id: 'b', name: 'Second', presenterIds: ['github:alice'], duration: 15 },
          { kind: 'item', id: 'c', name: 'Third', presenterIds: ['github:alice'], duration: 10 },
        ],
        // Concluded: chair advanced past the last item, so every session is past.
        current: { topicSpeakers: [], startedAt: '2026-04-01T10:00:00.000Z' },
      });
      const { container } = renderAgenda(meeting);

      // The session-header overflow count still summarises the excess…
      expect(screen.getByText(/overflow/i)).toBeInTheDocument();
      // …but the auto-inserted divider and the per-item badge are gone.
      expect(container.querySelector('[aria-label="Overflow"]')).toBeNull();
      expect(screen.queryByLabelText(/overflows by/i)).toBeNull();
    });

    it('hides the in-list overflow indicators once the meeting advances past the session run', () => {
      const meeting = makeMeeting({
        users: { 'github:alice': chairUser },
        agenda: [
          { kind: 'session', id: 's1', name: 'Tight', capacity: 30 },
          { kind: 'item', id: 'a', name: 'First', presenterIds: ['github:alice'], duration: 15 },
          { kind: 'item', id: 'b', name: 'Second', presenterIds: ['github:alice'], duration: 15 },
          { kind: 'item', id: 'c', name: 'Third', presenterIds: ['github:alice'], duration: 10 },
          { kind: 'session', id: 's2', name: 'Later', capacity: 60 },
          { kind: 'item', id: 'd', name: 'Fourth', presenterIds: ['github:alice'], duration: 5 },
        ],
        // Current item sits in the later session's run, so 'Tight' is fully past.
        current: { agendaItemId: 'd', topicSpeakers: [] },
      });
      const { container } = renderAgenda(meeting);

      expect(screen.getByText(/overflow/i)).toBeInTheDocument();
      expect(container.querySelector('[aria-label="Overflow"]')).toBeNull();
      expect(screen.queryByLabelText(/overflows by/i)).toBeNull();
    });

    it('keeps the in-list overflow indicators while the session is current', () => {
      const meeting = makeMeeting({
        users: { 'github:alice': chairUser },
        agenda: [
          { kind: 'session', id: 's1', name: 'Tight', capacity: 30 },
          { kind: 'item', id: 'a', name: 'First', presenterIds: ['github:alice'], duration: 15 },
          { kind: 'item', id: 'b', name: 'Second', presenterIds: ['github:alice'], duration: 15 },
          { kind: 'item', id: 'c', name: 'Third', presenterIds: ['github:alice'], duration: 10 },
        ],
        // Current item is inside the run, so the session is current, not past.
        current: { agendaItemId: 'b', topicSpeakers: [] },
      });
      const { container } = renderAgenda(meeting);

      expect(container.querySelector('[aria-label="Overflow"]')).not.toBeNull();
      expect(screen.getByLabelText(/overflows by/i)).toBeInTheDocument();
    });

    it('numbers agenda items sequentially, skipping session headers', () => {
      const meeting = makeMeeting({
        users: { 'github:alice': chairUser },
        agenda: [
          { kind: 'item', id: 'a', name: 'First', presenterIds: ['github:alice'] },
          { kind: 'session', id: 's1', name: 'Block', capacity: 30 },
          { kind: 'item', id: 'b', name: 'Second', presenterIds: ['github:alice'] },
        ],
      });
      renderAgenda(meeting);

      // Items should be numbered 1, 2 — not 1, 3 — even though a session
      // sits between them in the list.
      expect(screen.getByText('1')).toBeInTheDocument();
      expect(screen.getByText('2')).toBeInTheDocument();
      expect(screen.queryByText('3')).not.toBeInTheDocument();
    });

    it('emits session:delete when the chair clicks the session delete button', () => {
      const emit = vi.fn();
      const mockSocket = { emit } as unknown as TypedSocket;
      const meeting = makeMeeting({
        users: { 'github:alice': chairUser },
        chairIds: ['github:alice'],
        agenda: [{ kind: 'session', id: 's1', name: 'Block', capacity: 30 }],
      });
      renderAgenda(meeting, chairUser, mockSocket);

      fireEvent.click(screen.getByRole('button', { name: /delete session block/i }));
      expect(emit).toHaveBeenCalledWith('session:delete', { id: 's1' });
    });
  });

  describe('agenda file import', () => {
    const chairMeeting = () =>
      makeMeeting({ id: 'meet-123', users: { 'github:alice': chairUser }, chairIds: ['github:alice'] });

    it('shows import controls when the agenda already has items', () => {
      const meeting = makeMeeting({
        users: { 'github:alice': chairUser },
        chairIds: ['github:alice'],
        agenda: [{ kind: 'item', id: '1', name: 'Existing', presenterIds: ['github:alice'] }],
      });
      renderAgenda(meeting, chairUser);

      expect(screen.getByRole('button', { name: 'Import Agenda from URL' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Import from File' })).toBeInTheDocument();
    });

    it('posts file source to import-agenda-file on success', async () => {
      const fetchMock = vi.fn(async () => Response.json({ imported: 1, sessions: 0 }));
      vi.stubGlobal('fetch', fetchMock);

      try {
        renderAgenda(chairMeeting(), chairUser);

        const source = JSON.stringify([{ type: 'topic', name: 'Imported' }]);
        const file = new File([source], 'agenda.json', { type: 'application/json' });
        const input = screen.getByLabelText('Agenda file');

        await act(async () => {
          fireEvent.change(input, { target: { files: [file] } });
        });

        await act(async () => {
          await Promise.resolve();
        });

        expect(fetchMock).toHaveBeenCalledWith('/api/meetings/meet-123/import-agenda-file', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source }),
        });
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('shows an error alert when file import fails', async () => {
      const fetchMock = vi.fn(async () => Response.json({ error: 'Invalid agenda file' }, { status: 400 }));
      vi.stubGlobal('fetch', fetchMock);

      try {
        renderAgenda(chairMeeting(), chairUser);

        const file = new File(['[]'], 'agenda.json', { type: 'application/json' });
        await act(async () => {
          fireEvent.change(screen.getByLabelText('Agenda file'), { target: { files: [file] } });
          await Promise.resolve();
        });

        expect(await screen.findByRole('alert')).toHaveTextContent('Invalid agenda file');
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  describe('agenda URL import', () => {
    const chairMeeting = () =>
      makeMeeting({ id: 'meet-123', users: { 'github:alice': chairUser }, chairIds: ['github:alice'] });

    it('posts slotIntoSessions when the checkbox is checked', async () => {
      const fetchMock = vi.fn(async () => Response.json({ imported: 1 }, { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      try {
        renderAgenda(chairMeeting(), chairUser);
        fireEvent.click(screen.getByRole('button', { name: 'Import Agenda from URL' }));
        fireEvent.change(screen.getByLabelText('Agenda markdown URL'), {
          target: { value: 'https://github.com/tc39/agendas/blob/main/2026/03.md' },
        });
        fireEvent.click(screen.getByLabelText('Slot into sessions with available capacity'));
        fireEvent.click(screen.getByRole('button', { name: 'Import' }));

        await act(async () => {
          await Promise.resolve();
        });

        expect(fetchMock).toHaveBeenCalledWith('/api/meetings/meet-123/import-agenda', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: 'https://github.com/tc39/agendas/blob/main/2026/03.md',
            slotIntoSessions: true,
          }),
        });
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('omits slotIntoSessions from the request when the checkbox is unchecked', async () => {
      const fetchMock = vi.fn(async () => Response.json({ imported: 1 }, { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      try {
        renderAgenda(chairMeeting(), chairUser);
        fireEvent.click(screen.getByRole('button', { name: 'Import Agenda from URL' }));
        fireEvent.change(screen.getByLabelText('Agenda markdown URL'), {
          target: { value: 'https://github.com/tc39/agendas/blob/main/2026/03.md' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Import' }));

        await act(async () => {
          await Promise.resolve();
        });

        expect(fetchMock).toHaveBeenCalledWith('/api/meetings/meet-123/import-agenda', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: 'https://github.com/tc39/agendas/blob/main/2026/03.md' }),
        });
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  describe('agenda export', () => {
    const chairMeetingWithAgenda = () =>
      makeMeeting({
        users: { 'github:alice': chairUser },
        chairIds: ['github:alice'],
        agenda: [
          { kind: 'session', id: 's1', name: 'Morning', capacity: 60 },
          { kind: 'item', id: 'a', name: 'Welcome', presenterIds: ['github:alice'], duration: 5 },
        ],
      });

    it('does not show Export to File when the agenda is empty', () => {
      renderAgenda(makeMeeting({ users: { 'github:alice': chairUser }, chairIds: ['github:alice'] }), chairUser);
      expect(screen.queryByRole('button', { name: 'Export to File' })).not.toBeInTheDocument();
    });

    it('does not show Export to File to non-chairs', () => {
      const meeting = makeMeeting({
        users: { 'github:alice': chairUser },
        chairIds: [],
        agenda: [{ kind: 'item', id: 'a', name: 'Welcome', presenterIds: ['github:alice'] }],
      });
      renderAgenda(meeting, chairUser);
      expect(screen.queryByRole('button', { name: 'Export to File' })).not.toBeInTheDocument();
    });

    it('downloads the current agenda as a flat JSON document', async () => {
      // jsdom implements neither URL.createObjectURL nor a navigating anchor
      // click; stub both so downloadFile runs and we can inspect the Blob.
      let captured: Blob | undefined;
      const originalCreate = URL.createObjectURL;
      const originalRevoke = URL.revokeObjectURL;
      URL.createObjectURL = vi.fn((blob: Blob) => {
        captured = blob;
        return 'blob:mock';
      });
      URL.revokeObjectURL = vi.fn();
      const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

      try {
        renderAgenda(chairMeetingWithAgenda(), chairUser);
        fireEvent.click(screen.getByRole('button', { name: 'Export to File' }));

        expect(clickSpy).toHaveBeenCalledTimes(1);
        expect(captured).toBeInstanceOf(Blob);
        expect(captured?.type).toBe('application/json');
        expect(JSON.parse(await captured!.text())).toEqual([
          { type: 'session', name: 'Morning', capacity: 60 },
          { type: 'topic', name: 'Welcome', presenters: ['Alice'], duration: 5 },
        ]);
      } finally {
        clickSpy.mockRestore();
        URL.createObjectURL = originalCreate;
        URL.revokeObjectURL = originalRevoke;
      }
    });
  });

  describe('prologue / epilogue', () => {
    function makeChairMeeting(overrides: Partial<MeetingState> = {}) {
      return makeMeeting({
        users: { 'github:alice': chairUser },
        chairIds: ['github:alice'],
        ...overrides,
      });
    }

    it('hides both sections from non-chairs when unset', () => {
      const meeting = makeMeeting({
        users: {
          'github:alice': chairUser,
          'github:other': {
            provider: 'github',
            accountId: 'other',
            handle: 'other',
            name: 'Other',
            organisation: '',
            avatarUrl: 'https://github.com/other.png?size=80',
          },
        },
        chairIds: ['github:alice'],
      });
      renderAgenda(meeting, {
        provider: 'github',
        accountId: 'other',
        handle: 'other',
        name: 'Other',
        organisation: '',
        avatarUrl: 'https://github.com/other.png?size=80',
      });

      expect(screen.queryByRole('button', { name: /add an agenda prologue/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /add an agenda epilogue/i })).not.toBeInTheDocument();
    });

    it('shows both dashed placeholders to chairs when unset', () => {
      const meeting = makeChairMeeting();
      renderAgenda(meeting, chairUser);

      expect(screen.getByRole('button', { name: /add an agenda prologue/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /add an agenda epilogue/i })).toBeInTheDocument();
    });

    it('clicking the prologue placeholder reveals an auto-focused textarea', () => {
      const meeting = makeChairMeeting();
      renderAgenda(meeting, chairUser);

      fireEvent.click(screen.getByRole('button', { name: /add an agenda prologue/i }));
      const textarea = screen.getByRole('textbox', { name: /agenda prologue/i });
      expect(textarea).toBeInTheDocument();
      expect(textarea).toHaveFocus();
    });

    it('Save emits agenda:setPrologue with the entered text', () => {
      const emit = vi.fn();
      const mockSocket = { emit } as unknown as TypedSocket;
      const meeting = makeChairMeeting();
      renderAgenda(meeting, chairUser, mockSocket);

      fireEvent.click(screen.getByRole('button', { name: /add an agenda prologue/i }));
      const textarea = screen.getByRole('textbox', { name: /agenda prologue/i });
      fireEvent.change(textarea, { target: { value: 'welcome **everyone**' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      expect(emit).toHaveBeenCalledWith('agenda:setPrologue', { prologue: 'welcome **everyone**' });
    });

    it('Save with an empty textarea emits an empty prologue (server treats as clear)', () => {
      const emit = vi.fn();
      const mockSocket = { emit } as unknown as TypedSocket;
      const meeting = makeChairMeeting();
      renderAgenda(meeting, chairUser, mockSocket);

      fireEvent.click(screen.getByRole('button', { name: /add an agenda prologue/i }));
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      expect(emit).toHaveBeenCalledWith('agenda:setPrologue', { prologue: '' });
    });

    it('Ctrl+Enter inside the textarea submits', () => {
      const emit = vi.fn();
      const mockSocket = { emit } as unknown as TypedSocket;
      const meeting = makeChairMeeting();
      renderAgenda(meeting, chairUser, mockSocket);

      fireEvent.click(screen.getByRole('button', { name: /add an agenda prologue/i }));
      const textarea = screen.getByRole('textbox', { name: /agenda prologue/i });
      fireEvent.change(textarea, { target: { value: 'hi' } });
      fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });

      expect(emit).toHaveBeenCalledWith('agenda:setPrologue', { prologue: 'hi' });
    });

    it('Cancel discards the draft and returns to the placeholder', () => {
      const emit = vi.fn();
      const mockSocket = { emit } as unknown as TypedSocket;
      const meeting = makeChairMeeting();
      renderAgenda(meeting, chairUser, mockSocket);

      fireEvent.click(screen.getByRole('button', { name: /add an agenda prologue/i }));
      const textarea = screen.getByRole('textbox', { name: /agenda prologue/i });
      fireEvent.change(textarea, { target: { value: 'never sent' } });
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(emit).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: /add an agenda prologue/i })).toBeInTheDocument();
    });

    it('renders populated content via BlockMarkdown and shows chair-only edit/delete', () => {
      const meeting = makeChairMeeting({ prologue: '# heading\n\nbody text', epilogue: 'see you later' });
      renderAgenda(meeting, chairUser);

      // BlockMarkdown produces real heading + paragraph elements.
      expect(screen.getByRole('heading', { level: 1, name: 'heading' })).toBeInTheDocument();
      expect(screen.getByText('body text')).toBeInTheDocument();
      expect(screen.getByText('see you later')).toBeInTheDocument();

      // Chair sees edit/delete on each populated section.
      expect(screen.getByRole('button', { name: /edit prologue/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /delete prologue/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /edit epilogue/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /delete epilogue/i })).toBeInTheDocument();
    });

    it('non-chairs see populated content but no edit/delete buttons', () => {
      const other: User = {
        provider: 'github',
        accountId: 'other',
        handle: 'other',
        name: 'Other',
        organisation: '',
        avatarUrl: 'https://github.com/other.png?size=80',
      };
      const meeting = makeMeeting({
        users: { 'github:alice': chairUser, 'github:other': other },
        chairIds: ['github:alice'],
        prologue: 'visible to all',
      });
      renderAgenda(meeting, other);

      expect(screen.getByText('visible to all')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /edit prologue/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /delete prologue/i })).not.toBeInTheDocument();
    });

    it('clicking the prologue delete button opens a confirmation dialogue', () => {
      const emit = vi.fn();
      const mockSocket = { emit } as unknown as TypedSocket;
      const meeting = makeChairMeeting({ prologue: 'to be deleted' });
      renderAgenda(meeting, chairUser, mockSocket);

      fireEvent.click(screen.getByRole('button', { name: /delete prologue/i }));
      // The delete is gated behind a confirmation — no emit yet.
      expect(emit).not.toHaveBeenCalled();
      expect(screen.getByRole('dialog', { name: /delete prologue/i })).toBeInTheDocument();
    });

    it('confirming the deletion emits an empty prologue', () => {
      const emit = vi.fn();
      const mockSocket = { emit } as unknown as TypedSocket;
      const meeting = makeChairMeeting({ prologue: 'to be deleted' });
      renderAgenda(meeting, chairUser, mockSocket);

      fireEvent.click(screen.getByRole('button', { name: /delete prologue/i }));
      const dialog = screen.getByRole('dialog', { name: /delete prologue/i });
      fireEvent.click(dialog.querySelector('button[autofocus]') ?? dialog.querySelectorAll('button')[1]);

      expect(emit).toHaveBeenCalledWith('agenda:setPrologue', { prologue: '' });
    });

    it('cancelling the deletion does not emit', () => {
      const emit = vi.fn();
      const mockSocket = { emit } as unknown as TypedSocket;
      const meeting = makeChairMeeting({ prologue: 'to be deleted' });
      renderAgenda(meeting, chairUser, mockSocket);

      fireEvent.click(screen.getByRole('button', { name: /delete prologue/i }));
      const dialog = screen.getByRole('dialog', { name: /delete prologue/i });
      fireEvent.click(dialog.querySelector('button:not([autofocus])') ?? dialog.querySelectorAll('button')[0]);

      expect(emit).not.toHaveBeenCalled();
      // The populated content + edit/delete controls are still visible.
      expect(screen.getByText('to be deleted')).toBeInTheDocument();
    });

    it('Save with the conflict toast up opens an overwrite confirmation', () => {
      const emit = vi.fn();
      const mockSocket = { emit } as unknown as TypedSocket;
      const meeting = makeChairMeeting({ prologue: 'original' });
      const { rerender } = render(
        <TestMeetingProvider meeting={meeting} user={chairUser}>
          <SocketContext value={mockSocket}>
            <AgendaPanel />
          </SocketContext>
        </TestMeetingProvider>,
      );

      // Open the editor.
      fireEvent.click(screen.getByRole('button', { name: /edit prologue/i }));

      // Make a local change so the draft differs from the incoming value.
      const textarea = screen.getByRole('textbox', { name: /agenda prologue/i });
      fireEvent.change(textarea, { target: { value: 'local change' } });

      // Simulate a concurrent update from another chair.
      const remoteUpdate = makeChairMeeting({ prologue: 'remote change' });
      rerender(
        <TestMeetingProvider meeting={remoteUpdate} user={chairUser}>
          <SocketContext value={mockSocket}>
            <AgendaPanel />
          </SocketContext>
        </TestMeetingProvider>,
      );
      expect(screen.getByText(/another chair has updated the prologue/i)).toBeInTheDocument();

      // Click Save — this should open the overwrite dialogue, not emit yet.
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      expect(emit).not.toHaveBeenCalled();
      expect(screen.getByRole('dialog', { name: /overwrite prologue/i })).toBeInTheDocument();
    });

    it('confirming the overwrite emits the draft value', () => {
      const emit = vi.fn();
      const mockSocket = { emit } as unknown as TypedSocket;
      const meeting = makeChairMeeting({ prologue: 'original' });
      const { rerender } = render(
        <TestMeetingProvider meeting={meeting} user={chairUser}>
          <SocketContext value={mockSocket}>
            <AgendaPanel />
          </SocketContext>
        </TestMeetingProvider>,
      );
      fireEvent.click(screen.getByRole('button', { name: /edit prologue/i }));
      fireEvent.change(screen.getByRole('textbox', { name: /agenda prologue/i }), {
        target: { value: 'local change' },
      });
      rerender(
        <TestMeetingProvider meeting={makeChairMeeting({ prologue: 'remote change' })} user={chairUser}>
          <SocketContext value={mockSocket}>
            <AgendaPanel />
          </SocketContext>
        </TestMeetingProvider>,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      const dialog = screen.getByRole('dialog', { name: /overwrite prologue/i });
      fireEvent.click(dialog.querySelector('button[autofocus]') ?? dialog.querySelectorAll('button')[1]);

      expect(emit).toHaveBeenCalledWith('agenda:setPrologue', { prologue: 'local change' });
    });

    it('cancelling the overwrite leaves the editor open with the draft intact', () => {
      const emit = vi.fn();
      const mockSocket = { emit } as unknown as TypedSocket;
      const meeting = makeChairMeeting({ prologue: 'original' });
      const { rerender } = render(
        <TestMeetingProvider meeting={meeting} user={chairUser}>
          <SocketContext value={mockSocket}>
            <AgendaPanel />
          </SocketContext>
        </TestMeetingProvider>,
      );
      fireEvent.click(screen.getByRole('button', { name: /edit prologue/i }));
      const textarea = screen.getByRole('textbox', { name: /agenda prologue/i });
      fireEvent.change(textarea, { target: { value: 'local change' } });
      rerender(
        <TestMeetingProvider meeting={makeChairMeeting({ prologue: 'remote change' })} user={chairUser}>
          <SocketContext value={mockSocket}>
            <AgendaPanel />
          </SocketContext>
        </TestMeetingProvider>,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      const dialog = screen.getByRole('dialog', { name: /overwrite prologue/i });
      fireEvent.click(dialog.querySelector('button:not([autofocus])') ?? dialog.querySelectorAll('button')[0]);

      expect(emit).not.toHaveBeenCalled();
      expect(screen.getByRole('textbox', { name: /agenda prologue/i })).toHaveValue('local change');
    });

    it('Save without the conflict banner submits directly (no overwrite dialogue)', () => {
      const emit = vi.fn();
      const mockSocket = { emit } as unknown as TypedSocket;
      const meeting = makeChairMeeting({ prologue: 'original' });
      renderAgenda(meeting, chairUser, mockSocket);

      fireEvent.click(screen.getByRole('button', { name: /edit prologue/i }));
      fireEvent.change(screen.getByRole('textbox', { name: /agenda prologue/i }), {
        target: { value: 'updated by me' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      expect(emit).toHaveBeenCalledWith('agenda:setPrologue', { prologue: 'updated by me' });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('shows a sticky conflict toast when the value changes mid-edit', () => {
      const meeting = makeChairMeeting({ prologue: 'original' });
      const { rerender } = renderAgenda(meeting, chairUser);

      // Open the editor on the populated section.
      fireEvent.click(screen.getByRole('button', { name: /edit prologue/i }));
      expect(screen.queryByText(/another chair has updated the prologue/i)).not.toBeInTheDocument();

      // Simulate another chair's update arriving — rerender with new state.
      const updated = makeChairMeeting({ prologue: 'updated by someone else' });
      rerender(
        <TestMeetingProvider meeting={updated} user={chairUser}>
          <SocketContext value={null}>
            <AgendaPanel />
          </SocketContext>
        </TestMeetingProvider>,
      );

      expect(screen.getByText(/another chair has updated the prologue/i)).toBeInTheDocument();

      // The toast is sticky: a further update doesn't dismiss it and doesn't
      // raise a second one — exactly one stays.
      const updatedAgain = makeChairMeeting({ prologue: 'another remote change' });
      rerender(
        <TestMeetingProvider meeting={updatedAgain} user={chairUser}>
          <SocketContext value={null}>
            <AgendaPanel />
          </SocketContext>
        </TestMeetingProvider>,
      );
      expect(screen.getAllByText(/another chair has updated the prologue/i)).toHaveLength(1);

      // Closing the toast clears the conflict without exiting the editor.
      // (The close button hides the popover via popovertargetaction in a real
      // browser; jsdom doesn't process invokers, so drive hidePopover directly
      // — it fires the same `toggle` the close button would.)
      const toast = screen.getByRole('status');
      act(() => toast.hidePopover());
      expect(screen.queryByText(/another chair has updated the prologue/i)).not.toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: /agenda prologue/i })).toBeInTheDocument();
    });
  });
});
