import { describe, it, expect, vi, beforeEach } from 'vitest';
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

  it('hides the delete button for the current agenda item', () => {
    // The chair must advance off an item (Next Agenda Item) before it can
    // be deleted — discussion is in progress.
    const meeting = makeMeeting({
      users: { alice: chairUser },
      chairIds: ['alice'],
      agenda: [
        { kind: 'item', id: 'item-current', name: 'Currently discussing', presenterIds: ['alice'] },
        { kind: 'item', id: 'item-next', name: 'Next up', presenterIds: ['alice'] },
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
    // Own-item highlight is painted by an absolutely-positioned teal
    // strip in the left indicator column (the same column where the
    // overflow bar can overlay).
    const tealStrip = li.querySelector('.bg-teal-500');
    expect(tealStrip).not.toBeNull();
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

    it('shows conclusions on every item in the past-final state (no current item, but meeting has started)', () => {
      // Once the chair advances past the final item, `agendaItemId` is
      // undefined but `startedAt` is set — every item is now in the past
      // and any saved conclusions (including the one just recorded for
      // the final item via the Conclude meeting dialog) must surface on
      // the agenda.
      const meeting = makeMeeting({
        users: { a },
        agenda: [
          { kind: 'item', id: '1', name: 'First', presenterIds: ['a'], conclusion: 'first conclusion' },
          { kind: 'item', id: '2', name: 'Final', presenterIds: ['a'], conclusion: 'final conclusion' },
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

  describe('Auto-scroll on tab visibility', () => {
    const a: User = { ghid: 10, ghUsername: 'a', name: 'A', organisation: '' };

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
          { kind: 'item', id: '1', name: 'Past', presenterIds: ['a'] },
          { kind: 'item', id: '2', name: 'Current', presenterIds: ['a'] },
          { kind: 'item', id: '3', name: 'Upcoming', presenterIds: ['a'] },
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
          { kind: 'item', id: '1', name: 'Past', presenterIds: ['a'] },
          { kind: 'item', id: '2', name: 'Current', presenterIds: ['a'] },
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
        agenda: [{ kind: 'item', id: '1', name: 'Only', presenterIds: ['a'] }],
        current: { agendaItemId: '1', topicSpeakers: [] },
      });
      renderAgenda(meeting);

      expect(scrollSpy).toHaveBeenCalledTimes(1);
    });

    it('does not scroll when the current item changes while the panel is already visible', () => {
      const meeting = makeMeeting({
        users: { a },
        agenda: [
          { kind: 'item', id: '1', name: 'First', presenterIds: ['a'] },
          { kind: 'item', id: '2', name: 'Second', presenterIds: ['a'] },
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
        agenda: [{ kind: 'item', id: '1', name: 'Only', presenterIds: ['a'] }],
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
      const input = screen.getByLabelText(/new chair username/i);
      fireEvent.change(input, { target: { value: 'newperson' } });
      fireEvent.keyDown(input, { key: 'Enter' });

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
      const input = screen.getByLabelText(/new chair username/i);
      fireEvent.change(input, { target: { value: 'Alice' } });
      fireEvent.keyDown(input, { key: 'Enter' });

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
      const input = screen.getByLabelText(/new chair username/i);
      fireEvent.change(input, { target: { value: ' @newperson ' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(emit).toHaveBeenCalledWith('meeting:updateChairs', {
        usernames: ['alice', 'newperson'],
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
        users: { alice: chairUser },
        chairIds: ['alice'],
        agenda: [{ kind: 'item', id: '1', name: 'Topic', presenterIds: ['alice'] }],
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
        users: { alice: chairUser },
        agenda: [
          { kind: 'session', id: 's1', name: 'Tight', capacity: 30 },
          { kind: 'item', id: 'a', name: 'First', presenterIds: ['alice'], duration: 15 },
          { kind: 'item', id: 'b', name: 'Second', presenterIds: ['alice'], duration: 15 },
          { kind: 'item', id: 'c', name: 'Third', presenterIds: ['alice'], duration: 10 },
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
        users: { alice: chairUser },
        agenda: [
          { kind: 'session', id: 's1', name: 'Roomy', capacity: 60 },
          { kind: 'item', id: 'a', name: 'First', presenterIds: ['alice'], duration: 15 },
          { kind: 'item', id: 'b', name: 'Second', presenterIds: ['alice'], duration: 15 },
        ],
      });
      const { container } = renderAgenda(meeting);

      expect(container.querySelector('[aria-label="Overflow"]')).toBeNull();
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

  describe('prologue / epilogue', () => {
    function makeChairMeeting(overrides: Partial<MeetingState> = {}) {
      return makeMeeting({
        users: { alice: chairUser },
        chairIds: ['alice'],
        ...overrides,
      });
    }

    it('hides both sections from non-chairs when unset', () => {
      const meeting = makeMeeting({
        users: { alice: chairUser, other: { ghid: 99, ghUsername: 'other', name: 'Other', organisation: '' } },
        chairIds: ['alice'],
      });
      renderAgenda(meeting, { ghid: 99, ghUsername: 'other', name: 'Other', organisation: '' });

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
      const other: User = { ghid: 99, ghUsername: 'other', name: 'Other', organisation: '' };
      const meeting = makeMeeting({
        users: { alice: chairUser, other },
        chairIds: ['alice'],
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

    it('Save with the conflict banner up opens an overwrite confirmation', () => {
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
      expect(screen.getByRole('alert')).toBeInTheDocument();

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

    it('shows a sticky conflict banner when the value changes mid-edit', () => {
      const meeting = makeChairMeeting({ prologue: 'original' });
      const { rerender } = renderAgenda(meeting, chairUser);

      // Open the editor on the populated section.
      fireEvent.click(screen.getByRole('button', { name: /edit prologue/i }));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();

      // Simulate another chair's update arriving — rerender with new state.
      const updated = makeChairMeeting({ prologue: 'updated by someone else' });
      rerender(
        <TestMeetingProvider meeting={updated} user={chairUser}>
          <SocketContext value={null}>
            <AgendaPanel />
          </SocketContext>
        </TestMeetingProvider>,
      );

      const banner = screen.getByRole('alert');
      expect(banner).toHaveTextContent(/another chair has updated the prologue/i);

      // The banner is sticky: a further update doesn't dismiss it and doesn't
      // re-fire any toast — it just stays.
      const updatedAgain = makeChairMeeting({ prologue: 'another remote change' });
      rerender(
        <TestMeetingProvider meeting={updatedAgain} user={chairUser}>
          <SocketContext value={null}>
            <AgendaPanel />
          </SocketContext>
        </TestMeetingProvider>,
      );
      expect(screen.getByRole('alert')).toBeInTheDocument();

      // The dismiss button clears the banner without exiting the editor.
      fireEvent.click(screen.getByRole('button', { name: /dismiss conflict warning/i }));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: /agenda prologue/i })).toBeInTheDocument();
    });
  });
});
