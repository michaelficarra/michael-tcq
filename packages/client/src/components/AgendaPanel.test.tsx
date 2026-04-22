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
        { id: '1', name: 'First item', presenterIds: ['alice'], timebox: 20 },
        { id: '2', name: 'Second item', presenterIds: ['alice'] },
      ],
    });
    renderAgenda(meeting);

    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('First item')).toBeInTheDocument();
    expect(screen.getByText(/20 minutes/)).toBeInTheDocument();
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
    expect(screen.getByLabelText('Timebox')).toBeInTheDocument();
  });

  it('shows delete buttons for chairs', () => {
    const meeting = makeMeeting({
      users: { alice: chairUser },
      chairIds: ['alice'],
      agenda: [{ id: '1', name: 'Deletable item', presenterIds: ['alice'] }],
    });
    renderAgenda(meeting, chairUser);

    expect(screen.getByRole('button', { name: /delete deletable item/i })).toBeInTheDocument();
  });

  it('hides delete buttons for non-chairs', () => {
    const meeting = makeMeeting({
      users: { other: { ghid: 99, ghUsername: 'other', name: 'Other', organisation: '' }, alice: chairUser },
      chairIds: ['other'],
      agenda: [{ id: '1', name: 'Item', presenterIds: ['alice'] }],
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
      agenda: [{ id: 'item-1', name: 'To delete', presenterIds: ['alice'] }],
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
      agenda: [{ id: '1', name: 'Joint', presenterIds: ['alice', 'bob'] }],
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
      agenda: [{ id: '1', name: 'Joint', presenterIds: ['bob', 'alice'] }],
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
          id: '1',
          name: 'Test',
          presenterIds: ['alice'],
        },
      ],
    });
    renderAgenda(meeting);

    expect(screen.getByText(/ACME Corp/)).toBeInTheDocument();
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
  });
});
