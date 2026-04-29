import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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
  ghid: 1,
  ghUsername: 'alice',
  name: 'Alice',
  organisation: 'ACME',
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
      users: { alice: chairUser },
      agenda: [
        { kind: 'item', id: '1', name: 'First item', presenterIds: ['alice'], duration: 20 },
        { kind: 'item', id: '2', name: 'Second item', presenterIds: ['alice'] },
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
    const meeting = makeMeeting({ users: { alice: chairUser }, chairIds: ['alice'] });
    renderAgenda(meeting, chairUser);

    expect(screen.getByText('New Agenda Item')).toBeInTheDocument();
  });

  it('hides the "New Agenda Item" button for non-chairs', () => {
    const meeting = makeMeeting({
      users: { other: { ghid: 99, ghUsername: 'other', name: 'Other', organisation: '' } },
      chairIds: ['other'],
    });
    renderAgenda(meeting, chairUser);

    expect(screen.queryByText('New Agenda Item')).not.toBeInTheDocument();
  });

  it('shows the agenda form when "New Agenda Item" is clicked', () => {
    const meeting = makeMeeting({ users: { alice: chairUser }, chairIds: ['alice'] });
    renderAgenda(meeting, chairUser);

    fireEvent.click(screen.getByText('New Agenda Item'));

    expect(screen.getByLabelText('Agenda Item Name')).toBeInTheDocument();
    expect(screen.getByLabelText('Presenters')).toBeInTheDocument();
    expect(screen.getByLabelText('Estimate')).toBeInTheDocument();
  });

  it('shows delete buttons for chairs', () => {
    const meeting = makeMeeting({
      users: { alice: chairUser },
      chairIds: ['alice'],
      agenda: [{ kind: 'item', id: '1', name: 'Deletable item', presenterIds: ['alice'] }],
    });
    renderAgenda(meeting, chairUser);

    expect(screen.getByRole('button', { name: /delete deletable item/i })).toBeInTheDocument();
  });

  it('hides delete buttons for non-chairs', () => {
    const meeting = makeMeeting({
      users: { other: { ghid: 99, ghUsername: 'other', name: 'Other', organisation: '' }, alice: chairUser },
      chairIds: ['other'],
      agenda: [{ kind: 'item', id: '1', name: 'Item', presenterIds: ['alice'] }],
    });
    renderAgenda(meeting, chairUser);

    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
  });

  it('emits agenda:delete when delete button is clicked', () => {
    const emit = vi.fn();
    const mockSocket = { emit } as unknown as TypedSocket;

    const meeting = makeMeeting({
      users: { alice: chairUser },
      chairIds: ['alice'],
      agenda: [{ kind: 'item', id: 'item-1', name: 'To delete', presenterIds: ['alice'] }],
    });
    renderAgenda(meeting, chairUser, mockSocket);

    fireEvent.click(screen.getByRole('button', { name: /delete to delete/i }));
    expect(emit).toHaveBeenCalledWith('agenda:delete', { id: 'item-1' });
  });

  it('renders a badge per presenter when an item has multiple', () => {
    const alice = { ghid: 1, ghUsername: 'alice', name: 'Alice', organisation: 'A Corp' };
    const bob = { ghid: 2, ghUsername: 'bob', name: 'Bob', organisation: 'B Corp' };
    const meeting = makeMeeting({
      users: { alice, bob },
      agenda: [{ kind: 'item', id: '1', name: 'Joint', presenterIds: ['alice', 'bob'] }],
    });
    renderAgenda(meeting);

    // Both users' names appear alongside the item.
    expect(screen.getByText(/Alice/)).toBeInTheDocument();
    expect(screen.getByText(/Bob/)).toBeInTheDocument();
  });

  it('highlights items where the viewer is any of the presenters', () => {
    const bob = { ghid: 2, ghUsername: 'bob', name: 'Bob', organisation: '' };
    const meeting = makeMeeting({
      users: { alice: chairUser, bob },
      agenda: [{ kind: 'item', id: '1', name: 'Joint', presenterIds: ['bob', 'alice'] }],
    });
    renderAgenda(meeting, chairUser);

    const li = screen.getByText('Joint').closest('li')!;
    expect(li.className).toMatch(/border-l-teal-500/);
  });

  it('shows presenter organisation in parentheses', () => {
    const meeting = makeMeeting({
      users: { alice: { ghid: 1, ghUsername: 'alice', name: 'Alice', organisation: 'ACME Corp' } },
      agenda: [
        {
          kind: 'item',
          id: '1',
          name: 'Test',
          presenterIds: ['alice'],
        },
      ],
    });
    renderAgenda(meeting);

    expect(screen.getByText(/ACME Corp/)).toBeInTheDocument();
  });

  describe('Current item styling', () => {
    const a: User = { ghid: 10, ghUsername: 'a', name: 'A', organisation: '' };

    it('dims items strictly before the current one and highlights the current item', () => {
      const meeting = makeMeeting({
        users: { a },
        agenda: [
          { kind: 'item', id: '1', name: 'Past item', presenterIds: ['a'] },
          { kind: 'item', id: '2', name: 'Current item', presenterIds: ['a'] },
          { kind: 'item', id: '3', name: 'Upcoming item', presenterIds: ['a'] },
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
        agenda: [{ kind: 'item', id: '1', name: 'The current one', presenterIds: ['a'] }],
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
          { kind: 'item', id: '1', name: 'Alpha', presenterIds: ['a'] },
          { kind: 'item', id: '2', name: 'Beta', presenterIds: ['a'] },
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
          { kind: 'item', id: '1', name: 'Past', presenterIds: ['a'], conclusion: 'agreed unanimously' },
          { kind: 'item', id: '2', name: 'Current', presenterIds: ['a'] },
        ],
        current: { agendaItemId: '2', topicSpeakers: [] },
      });
      renderAgenda(meeting);

      expect(screen.getByText('agreed unanimously')).toBeInTheDocument();
    });

    it('does not show a conclusion on the current or upcoming items even if one is set', () => {
      // Setting `conclusion` on a current/future item should never happen in
      // practice (the dialog only writes on advance), but if it did the UI
      // must not surface it on those rows.
      const meeting = makeMeeting({
        users: { a },
        agenda: [
          { kind: 'item', id: '1', name: 'Past', presenterIds: ['a'] },
          { kind: 'item', id: '2', name: 'Current', presenterIds: ['a'], conclusion: 'should be hidden — current' },
          { kind: 'item', id: '3', name: 'Upcoming', presenterIds: ['a'], conclusion: 'should be hidden — upcoming' },
        ],
        current: { agendaItemId: '2', topicSpeakers: [] },
      });
      renderAgenda(meeting);

      expect(screen.queryByText('should be hidden — current')).not.toBeInTheDocument();
      expect(screen.queryByText('should be hidden — upcoming')).not.toBeInTheDocument();
    });
  });

  describe('Chair management', () => {
    const otherChair: User = { ghid: 2, ghUsername: 'bob', name: 'Bob', organisation: '' };

    it('shows remove buttons for chairs on other chairs', () => {
      mockAuthState = { ...mockAuthState, user: chairUser, isAdmin: false };
      const meeting = makeMeeting({ users: { alice: chairUser, bob: otherChair }, chairIds: ['alice', 'bob'] });
      renderAgenda(meeting, chairUser);

      // Should see remove button for bob but not for alice (self)
      expect(screen.getByRole('button', { name: /remove chair bob/i })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /remove chair alice/i })).not.toBeInTheDocument();
    });

    it('non-chairs do not see remove buttons', () => {
      mockAuthState = { ...mockAuthState, user: chairUser, isAdmin: false };
      const meeting = makeMeeting({
        users: { bob: otherChair },
        chairIds: ['bob'],
      });
      renderAgenda(meeting, chairUser);

      expect(screen.queryByRole('button', { name: /remove chair/i })).not.toBeInTheDocument();
    });

    it('admins see remove buttons on all chairs including themselves', () => {
      mockAuthState = { ...mockAuthState, user: chairUser, isAdmin: true };
      const meeting = makeMeeting({ users: { alice: chairUser, bob: otherChair }, chairIds: ['alice', 'bob'] });
      renderAgenda(meeting, chairUser);

      expect(screen.getByRole('button', { name: /remove chair alice/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /remove chair bob/i })).toBeInTheDocument();
    });

    it('shows confirmation modal before removing a chair', () => {
      mockAuthState = { ...mockAuthState, user: chairUser, isAdmin: false };
      const meeting = makeMeeting({ users: { alice: chairUser, bob: otherChair }, chairIds: ['alice', 'bob'] });
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
      const meeting = makeMeeting({ users: { alice: chairUser, bob: otherChair }, chairIds: ['alice', 'bob'] });
      renderAgenda(meeting, chairUser, mockSocket);

      fireEvent.click(screen.getByRole('button', { name: /remove chair bob/i }));
      fireEvent.click(screen.getByRole('button', { name: /^remove$/i }));

      expect(emit).toHaveBeenCalledWith('meeting:updateChairs', {
        usernames: ['alice'],
      });
    });

    it('shows add chair button for chairs', () => {
      mockAuthState = { ...mockAuthState, user: chairUser, isAdmin: false };
      const meeting = makeMeeting({ users: { alice: chairUser }, chairIds: ['alice'] });
      renderAgenda(meeting, chairUser);

      expect(screen.getByRole('button', { name: /add chair/i })).toBeInTheDocument();
    });

    it('hides add chair button for non-chairs', () => {
      mockAuthState = { ...mockAuthState, user: chairUser, isAdmin: false };
      const meeting = makeMeeting({ users: { bob: otherChair }, chairIds: ['bob'] });
      renderAgenda(meeting, chairUser);

      expect(screen.queryByRole('button', { name: /add chair/i })).not.toBeInTheDocument();
    });

    it('shows username input when add button is clicked', () => {
      mockAuthState = { ...mockAuthState, user: chairUser, isAdmin: false };
      const meeting = makeMeeting({ users: { alice: chairUser }, chairIds: ['alice'] });
      renderAgenda(meeting, chairUser);

      fireEvent.click(screen.getByRole('button', { name: /add chair/i }));

      expect(screen.getByLabelText(/new chair username/i)).toBeInTheDocument();
    });

    it('emits meeting:updateChairs with new chair added', () => {
      const emit = vi.fn();
      const mockSocket = { emit } as unknown as TypedSocket;
      mockAuthState = { ...mockAuthState, user: chairUser, isAdmin: false };
      const meeting = makeMeeting({ users: { alice: chairUser }, chairIds: ['alice'] });
      renderAgenda(meeting, chairUser, mockSocket);

      fireEvent.click(screen.getByRole('button', { name: /add chair/i }));
      fireEvent.change(screen.getByLabelText(/new chair username/i), { target: { value: 'newperson' } });
      fireEvent.submit(screen.getByLabelText(/new chair username/i));

      expect(emit).toHaveBeenCalledWith('meeting:updateChairs', {
        usernames: ['alice', 'newperson'],
      });
    });

    it('does not add duplicate chair username', () => {
      const emit = vi.fn();
      const mockSocket = { emit } as unknown as TypedSocket;
      mockAuthState = { ...mockAuthState, user: chairUser, isAdmin: false };
      const meeting = makeMeeting({ users: { alice: chairUser }, chairIds: ['alice'] });
      renderAgenda(meeting, chairUser, mockSocket);

      fireEvent.click(screen.getByRole('button', { name: /add chair/i }));
      fireEvent.change(screen.getByLabelText(/new chair username/i), { target: { value: 'Alice' } });
      fireEvent.submit(screen.getByLabelText(/new chair username/i));

      expect(emit).toHaveBeenCalledWith('meeting:updateChairs', {
        usernames: ['alice'],
      });
    });

    // Users may type or paste handles in GitHub-style `@name` form; the
    // chair-add input strips a leading `@` and surrounding whitespace
    // before the username is added.
    it('strips a leading @ and surrounding whitespace from the new chair username', () => {
      const emit = vi.fn();
      const mockSocket = { emit } as unknown as TypedSocket;
      mockAuthState = { ...mockAuthState, user: chairUser, isAdmin: false };
      const meeting = makeMeeting({ users: { alice: chairUser }, chairIds: ['alice'] });
      renderAgenda(meeting, chairUser, mockSocket);

      fireEvent.click(screen.getByRole('button', { name: /add chair/i }));
      fireEvent.change(screen.getByLabelText(/new chair username/i), { target: { value: ' @newperson ' } });
      fireEvent.submit(screen.getByLabelText(/new chair username/i));

      expect(emit).toHaveBeenCalledWith('meeting:updateChairs', {
        usernames: ['alice', 'newperson'],
      });
    });
  });

  describe('inline edit', () => {
    // Edit the presenters of an existing item using comma-separated
    // `@name` handles — each entry is normalised before emit.
    it('strips a leading @ and surrounding whitespace from edited presenters', () => {
      const emit = vi.fn();
      const mockSocket = { emit } as unknown as TypedSocket;
      mockAuthState = { ...mockAuthState, user: chairUser, isAdmin: false };
      const meeting = makeMeeting({
        users: { alice: chairUser },
        chairIds: ['alice'],
        agenda: [{ kind: 'item', id: '1', name: 'Topic', presenterIds: ['alice'] }],
      });
      renderAgenda(meeting, chairUser, mockSocket);

      // Open the inline edit form on the only item
      fireEvent.click(screen.getByRole('button', { name: /^edit topic$/i }));

      const presentersInput = screen.getByLabelText('Presenters');
      fireEvent.change(presentersInput, {
        target: { value: ' @alice , @ bob, charlie ' },
      });

      fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

      expect(emit).toHaveBeenCalledWith('agenda:edit', {
        id: '1',
        name: 'Topic',
        presenterUsernames: ['alice', 'bob', 'charlie'],
        duration: null,
      });
    });
  });

  describe('sessions', () => {
    it('shows the "New Session" button for chairs alongside "New Agenda Item"', () => {
      const meeting = makeMeeting({ users: { alice: chairUser }, chairIds: ['alice'] });
      renderAgenda(meeting, chairUser);

      expect(screen.getByText('New Agenda Item')).toBeInTheDocument();
      expect(screen.getByText('New Session')).toBeInTheDocument();
    });

    it('hides the "New Session" button for non-chairs', () => {
      const meeting = makeMeeting({
        users: { other: { ghid: 99, ghUsername: 'other', name: 'Other', organisation: '' } },
        chairIds: ['other'],
      });
      renderAgenda(meeting, chairUser);

      expect(screen.queryByText('New Session')).not.toBeInTheDocument();
    });

    it('opens a session form and emits session:add on submit', () => {
      const emit = vi.fn();
      const mockSocket = { emit } as unknown as TypedSocket;
      const meeting = makeMeeting({ users: { alice: chairUser }, chairIds: ['alice'] });
      renderAgenda(meeting, chairUser, mockSocket);

      fireEvent.click(screen.getByText('New Session'));
      fireEvent.change(screen.getByLabelText(/session name/i), { target: { value: 'Morning block' } });
      fireEvent.change(screen.getByLabelText(/^capacity$/i), { target: { value: '90' } });
      fireEvent.submit(screen.getByLabelText(/session name/i));

      expect(emit).toHaveBeenCalledWith('session:add', { name: 'Morning block', capacity: 90 });
    });

    it('renders a session header with capacity / used / remaining', () => {
      const meeting = makeMeeting({
        users: { alice: chairUser },
        agenda: [
          { kind: 'session', id: 's1', name: 'Morning', capacity: 90 },
          { kind: 'item', id: 'a', name: 'First', presenterIds: ['alice'], duration: 15 },
          { kind: 'item', id: 'b', name: 'Second', presenterIds: ['alice'], duration: 30 },
        ],
      });
      renderAgenda(meeting);

      // "Morning" session header present (rendered in upper case by Tailwind
      // but the text node itself preserves the original casing).
      expect(screen.getByText('Morning')).toBeInTheDocument();
      // Capacity 1h30m, used 45m, remaining 45m.
      expect(screen.getByText('1h30m')).toBeInTheDocument();
      // Two "45m" elements: one for used, one for remaining.
      expect(screen.getAllByText('45m').length).toBeGreaterThanOrEqual(2);
      expect(screen.getByText(/remaining/i)).toBeInTheDocument();
    });

    it('flips to "overflow" label when the run exceeds capacity', () => {
      const meeting = makeMeeting({
        users: { alice: chairUser },
        agenda: [
          { kind: 'session', id: 's1', name: 'Tight', capacity: 30 },
          { kind: 'item', id: 'a', name: 'First', presenterIds: ['alice'], duration: 15 },
          { kind: 'item', id: 'b', name: 'Second', presenterIds: ['alice'], duration: 15 },
          { kind: 'item', id: 'c', name: 'Third', presenterIds: ['alice'], duration: 10 },
        ],
      });
      renderAgenda(meeting);

      // Capacity 30m, used 30m (first two fit exactly), overflow = 40 - 30 = 10m.
      expect(screen.getByText(/overflow/i)).toBeInTheDocument();
      expect(screen.queryByText(/remaining/i)).not.toBeInTheDocument();
      // Both the session overflow amount and the "Third" item render as "10m".
      // Presence of at least two matching nodes confirms the overflow amount is shown.
      expect(screen.getAllByText('10m').length).toBeGreaterThanOrEqual(2);
    });

    it('numbers agenda items sequentially, skipping session headers', () => {
      const meeting = makeMeeting({
        users: { alice: chairUser },
        agenda: [
          { kind: 'item', id: 'a', name: 'First', presenterIds: ['alice'] },
          { kind: 'session', id: 's1', name: 'Block', capacity: 30 },
          { kind: 'item', id: 'b', name: 'Second', presenterIds: ['alice'] },
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
        users: { alice: chairUser },
        chairIds: ['alice'],
        agenda: [{ kind: 'session', id: 's1', name: 'Block', capacity: 30 }],
      });
      renderAgenda(meeting, chairUser, mockSocket);

      fireEvent.click(screen.getByRole('button', { name: /delete session block/i }));
      expect(emit).toHaveBeenCalledWith('session:delete', { id: 's1' });
    });
  });
});
