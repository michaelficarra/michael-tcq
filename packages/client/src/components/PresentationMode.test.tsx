import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { MeetingState, User } from '@tcq/shared';
import { QueuePanel } from './QueuePanel.js';
import { AgendaPanel } from './AgendaPanel.js';
import { PollReactions } from './PollReactions.js';
import { TestMeetingProvider } from '../test/TestMeetingProvider.js';
import { PreferencesProvider } from '../contexts/PreferencesContext.js';
import { makeMeeting as buildMeeting } from '../test/makeMeeting.js';
import { SocketContext, type TypedSocket } from '../contexts/SocketContext.js';

const chairUser: User = {
  provider: 'github',
  accountId: 'alice',
  handle: 'alice',
  name: 'Alice',
  organisation: '',
  avatarUrl: 'https://github.com/alice.png?size=80',
};
const otherUser: User = {
  provider: 'github',
  accountId: 'bob',
  handle: 'bob',
  name: 'Bob',
  organisation: '',
  avatarUrl: 'https://github.com/bob.png?size=80',
};

function makeMeeting(overrides?: Partial<MeetingState>): MeetingState {
  return buildMeeting(overrides, { id: 'test', users: { 'github:alice': chairUser }, chairIds: ['github:alice'] });
}

/**
 * Render a component inside a presentation-mode wrapper.
 * The `.presentation-mode` class on the wrapper activates the CSS
 * hiding rules for elements tagged with `.presentation-hidden`.
 */
function renderInPresentationMode(ui: React.ReactElement) {
  return render(<div className="presentation-mode">{ui}</div>);
}

function wrapWithProviders(
  ui: React.ReactElement,
  meeting: MeetingState,
  user: User = chairUser,
  socket: TypedSocket | null = null,
) {
  return (
    <TestMeetingProvider meeting={meeting} user={user}>
      <PreferencesProvider>
        <SocketContext value={socket}>{ui}</SocketContext>
      </PreferencesProvider>
    </TestMeetingProvider>
  );
}

describe('Presentation mode', () => {
  describe('QueuePanel', () => {
    it('hides the speaker entry type buttons', () => {
      const meeting = makeMeeting();
      renderInPresentationMode(
        wrapWithProviders(
          <QueuePanel
            autoEditEntryId={null}
            onAddEntry={() => {}}
            onSavedTopic={() => {}}
            onAutoEditConsumed={() => {}}
          />,
          meeting,
        ),
      );

      // The group containing New Topic, Clarifying Question, etc. should be hidden
      const group = screen.getByRole('group', { name: 'Queue entry types' });
      expect(group.className).toContain('presentation-hidden');
    });

    it('hides the Start Meeting button', () => {
      const meeting = makeMeeting({
        agenda: [{ kind: 'item', id: '1', name: 'Item', presenterIds: ['github:alice'] }],
      });
      renderInPresentationMode(
        wrapWithProviders(
          <QueuePanel
            autoEditEntryId={null}
            onAddEntry={() => {}}
            onSavedTopic={() => {}}
            onAutoEditConsumed={() => {}}
          />,
          meeting,
        ),
      );

      const btn = screen.getByText('Start Meeting');
      expect(btn.className).toContain('presentation-hidden');
    });

    it('hides Next Agenda Item button', () => {
      const meeting = makeMeeting({
        agenda: [
          { kind: 'item', id: '1', name: 'First', presenterIds: ['github:alice'] },
          { kind: 'item', id: '2', name: 'Second', presenterIds: ['github:alice'] },
        ],
        current: { topicSpeakers: [], agendaItemId: '1' },
      });
      renderInPresentationMode(
        wrapWithProviders(
          <QueuePanel
            autoEditEntryId={null}
            onAddEntry={() => {}}
            onSavedTopic={() => {}}
            onAutoEditConsumed={() => {}}
          />,
          meeting,
        ),
      );

      const btn = screen.getByText('Next Agenda Item');
      expect(btn.className).toContain('presentation-hidden');
    });

    it('hides Next Speaker button', () => {
      const meeting = makeMeeting({
        users: { 'github:alice': chairUser, 'github:bob': otherUser },
        current: {
          topicSpeakers: [],
          speaker: {
            id: 's1',
            type: 'topic',
            topic: 'Test',
            userId: 'github:bob',
            source: 'queue',
            startTime: '2026-01-01T00:00:00.000Z',
          },
        },
      });
      renderInPresentationMode(
        wrapWithProviders(
          <QueuePanel
            autoEditEntryId={null}
            onAddEntry={() => {}}
            onSavedTopic={() => {}}
            onAutoEditConsumed={() => {}}
          />,
          meeting,
        ),
      );

      const btn = screen.getByText('Next Speaker');
      expect(btn.className).toContain('presentation-hidden');
    });

    it('hides drag handles on queue entries', () => {
      // Two entries so the drag handle renders — with a single-entry queue
      // there are no valid moves and the handle is omitted entirely.
      const meeting = makeMeeting({
        queue: {
          entries: {
            q1: { id: 'q1', type: 'topic', topic: 'My topic', userId: 'github:alice' },
            q2: { id: 'q2', type: 'topic', topic: 'Other topic', userId: 'github:alice' },
          },
          orderedIds: ['q1', 'q2'],
          closed: false,
        },
      });
      renderInPresentationMode(
        wrapWithProviders(
          <QueuePanel
            autoEditEntryId={null}
            onAddEntry={() => {}}
            onSavedTopic={() => {}}
            onAutoEditConsumed={() => {}}
          />,
          meeting,
        ),
      );

      const handles = screen.getAllByLabelText(/drag to reorder/i);
      expect(handles).not.toHaveLength(0);
      for (const handle of handles) {
        expect(handle.className).toContain('presentation-hidden');
      }
    });

    it('hides edit/delete buttons on queue entries', () => {
      const meeting = makeMeeting({
        queue: {
          entries: { q1: { id: 'q1', type: 'topic', topic: 'My topic', userId: 'github:alice' } },
          orderedIds: ['q1'],
          closed: false,
        },
      });
      renderInPresentationMode(
        wrapWithProviders(
          <QueuePanel
            autoEditEntryId={null}
            onAddEntry={() => {}}
            onSavedTopic={() => {}}
            onAutoEditConsumed={() => {}}
          />,
          meeting,
        ),
      );

      // The container div for edit/delete buttons should be hidden
      const editBtn = screen.getByLabelText(/edit entry/i);
      expect(editBtn.closest('.presentation-hidden')).not.toBeNull();
    });

    it('keeps queue entry content visible', () => {
      const meeting = makeMeeting({
        users: { 'github:alice': chairUser, 'github:bob': otherUser },
        queue: {
          entries: { q1: { id: 'q1', type: 'topic', topic: 'Visible topic', userId: 'github:bob' } },
          orderedIds: ['q1'],
          closed: false,
        },
      });
      renderInPresentationMode(
        wrapWithProviders(
          <QueuePanel
            autoEditEntryId={null}
            onAddEntry={() => {}}
            onSavedTopic={() => {}}
            onAutoEditConsumed={() => {}}
          />,
          meeting,
        ),
      );

      expect(screen.getByText('Visible topic')).toBeInTheDocument();
      expect(screen.getByText('Bob')).toBeInTheDocument();
    });

    it('keeps the type badge visible on queue entries', () => {
      const meeting = makeMeeting({
        users: { 'github:alice': chairUser, 'github:bob': otherUser },
        queue: {
          entries: { q1: { id: 'q1', type: 'topic', topic: 'Test', userId: 'github:bob' } },
          orderedIds: ['q1'],
          closed: false,
        },
      });
      renderInPresentationMode(
        wrapWithProviders(
          <QueuePanel
            autoEditEntryId={null}
            onAddEntry={() => {}}
            onSavedTopic={() => {}}
            onAutoEditConsumed={() => {}}
          />,
          meeting,
        ),
      );

      // Type badge should be visible (either as a span or a button without presentation-hidden)
      expect(screen.getByText(/New Topic:/)).toBeInTheDocument();
    });

    it('keeps current speaker info visible', () => {
      const meeting = makeMeeting({
        users: { 'github:alice': chairUser, 'github:bob': otherUser },
        current: {
          topicSpeakers: [],
          speaker: {
            id: 's1',
            type: 'topic',
            topic: 'Speaking about this',
            userId: 'github:bob',
            source: 'queue',
            startTime: '2026-01-01T00:00:00.000Z',
          },
        },
      });
      renderInPresentationMode(
        wrapWithProviders(
          <QueuePanel
            autoEditEntryId={null}
            onAddEntry={() => {}}
            onSavedTopic={() => {}}
            onAutoEditConsumed={() => {}}
          />,
          meeting,
        ),
      );

      expect(screen.getByText('Speaking about this')).toBeInTheDocument();
      expect(screen.getByText('Bob')).toBeInTheDocument();
    });
  });

  describe('AgendaPanel', () => {
    it('hides the + New Agenda Item button', () => {
      const meeting = makeMeeting();
      renderInPresentationMode(wrapWithProviders(<AgendaPanel />, meeting));

      // The button should exist but have presentation-hidden
      const btn = screen.queryByText('+ New Agenda Item');
      if (btn) {
        expect(btn.className).toContain('presentation-hidden');
      }
    });

    it('hides edit/delete buttons on agenda items', () => {
      const meeting = makeMeeting({
        agenda: [{ kind: 'item', id: '1', name: 'Test Item', presenterIds: ['github:alice'] }],
      });
      renderInPresentationMode(wrapWithProviders(<AgendaPanel />, meeting));

      const deleteBtn = screen.getByLabelText(/delete test item/i);
      expect(deleteBtn.closest('.presentation-hidden')).not.toBeNull();
    });

    it('keeps agenda item content visible', () => {
      const meeting = makeMeeting({
        users: { 'github:alice': chairUser, 'github:bob': otherUser },
        agenda: [{ kind: 'item', id: '1', name: 'Visible Item', presenterIds: ['github:bob'], duration: 15 }],
      });
      renderInPresentationMode(wrapWithProviders(<AgendaPanel />, meeting));

      expect(screen.getByText('Visible Item')).toBeInTheDocument();
      expect(screen.getByText('Bob')).toBeInTheDocument();
      expect(screen.getByText('15m')).toBeInTheDocument();
    });

    it('keeps the chairs list visible', () => {
      const meeting = makeMeeting();
      renderInPresentationMode(wrapWithProviders(<AgendaPanel />, meeting));

      expect(screen.getByText('Chairs')).toBeInTheDocument();
      expect(screen.getByText('Alice')).toBeInTheDocument();
    });
  });

  describe('PollReactions', () => {
    it('keeps reaction buttons visible (they have aria-pressed)', () => {
      const options = [
        { id: 'opt-1', emoji: '👍', label: 'Positive' },
        { id: 'opt-2', emoji: '👎', label: 'Negative' },
      ];
      const meeting = makeMeeting({
        poll: {
          options,
          reactions: [],
          startTime: new Date().toISOString(),
          startChairId: 'github:alice',
          multiSelect: true,
        },
      });
      renderInPresentationMode(wrapWithProviders(<PollReactions />, meeting));

      // Reaction buttons should be visible
      expect(screen.getByLabelText(/positive/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/negative/i)).toBeInTheDocument();
    });

    it('shows chair buttons in poll modal even in presentation mode', () => {
      const options = [
        { id: 'opt-1', emoji: '👍', label: 'Positive' },
        { id: 'opt-2', emoji: '👎', label: 'Negative' },
      ];
      const meeting = makeMeeting({
        poll: {
          options,
          reactions: [],
          startTime: new Date().toISOString(),
          startChairId: 'github:alice',
          multiSelect: true,
        },
      });
      renderInPresentationMode(wrapWithProviders(<PollReactions />, meeting, chairUser));

      expect(screen.getByText('Copy Results')).toBeInTheDocument();
      expect(screen.getByText('Stop Poll')).toBeInTheDocument();
    });
  });
});
