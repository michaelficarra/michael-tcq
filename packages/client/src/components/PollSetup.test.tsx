import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { MeetingState, User } from '@tcq/shared';
import { DEFAULT_POLL_OPTIONS } from '@tcq/shared';
import { PollSetup } from './PollSetup.js';
import { TestMeetingProvider } from '../test/TestMeetingProvider.js';
import { SocketContext, type TypedSocket } from '../contexts/SocketContext.js';

import { makeMeeting as buildMeeting } from '../test/makeMeeting.js';

const chairUser: User = {
  provider: 'github',
  accountId: 'alice',
  handle: 'alice',
  name: 'Alice',
  organisation: '',
  avatarUrl: 'https://github.com/alice.png?size=80',
};

const baseMeeting: MeetingState = buildMeeting(undefined, {
  id: 'test',
  users: { 'github:alice': chairUser },
  chairIds: ['github:alice'],
});

function renderSetup(
  socket: TypedSocket | null = null,
  onCancel = () => {},
  onSubmitted = () => {},
  mode: 'start' | 'request' | 'approve' = 'start',
  extra: Partial<React.ComponentProps<typeof PollSetup>> = {},
) {
  return render(
    <TestMeetingProvider meeting={baseMeeting} user={chairUser}>
      <SocketContext value={socket}>
        <PollSetup mode={mode} onCancel={onCancel} onSubmitted={onSubmitted} {...extra} />
      </SocketContext>
    </TestMeetingProvider>,
  );
}

const pendingRequest = {
  id: 'req-1',
  requesterId: 'github:bob' as const,
  topic: 'Ship it?',
  multiSelect: false,
  options: [
    { id: 'o1', emoji: '👍', label: 'Yes' },
    { id: 'o2', emoji: '👎', label: 'No' },
    { id: 'o3', emoji: '🤷', label: 'Abstain' },
  ],
  requestedAt: '2026-01-01T00:00:00.000Z',
};

const bobUser: User = {
  provider: 'github',
  accountId: 'bob',
  handle: 'bob',
  name: 'Bob',
  organisation: '',
  avatarUrl: 'https://github.com/bob.png?size=80',
};

describe('PollSetup', () => {
  it('renders the default options', () => {
    renderSetup();

    // Should show all default options
    const emojiInputs = screen.getAllByLabelText('Choose emoji');
    expect(emojiInputs.length).toBe(DEFAULT_POLL_OPTIONS.length);

    // First option should be the heart emoji (displayed as button text)
    expect(emojiInputs[0].textContent).toBe('❤️');
  });

  it('renders label inputs for each option', () => {
    renderSetup();

    const labelInputs = screen.getAllByLabelText('Option label');
    expect(labelInputs.length).toBe(DEFAULT_POLL_OPTIONS.length);
    expect((labelInputs[0] as HTMLInputElement).value).toBe('Strong Positive');
  });

  it('allows adding a new option', () => {
    renderSetup();

    const initialCount = screen.getAllByLabelText('Choose emoji').length;
    fireEvent.click(screen.getByText('+ Add Option'));
    expect(screen.getAllByLabelText('Choose emoji').length).toBe(initialCount + 1);
  });

  it('allows removing an option', () => {
    renderSetup();

    const initialCount = screen.getAllByLabelText('Choose emoji').length;
    const removeButtons = screen.getAllByLabelText('Remove option');
    fireEvent.click(removeButtons[0]);
    expect(screen.getAllByLabelText('Choose emoji').length).toBe(initialCount - 1);
  });

  it('disables remove buttons when there are only 2 options', () => {
    renderSetup();

    // Remove options one at a time until only 2 remain (default is 6)
    while (screen.getAllByLabelText('Choose emoji').length > 2) {
      // Find the first enabled remove button and click it
      const btn = screen.getAllByLabelText('Remove option').find((b) => !(b as HTMLButtonElement).disabled);
      if (!btn) break;
      fireEvent.click(btn);
    }

    // Now all remove buttons should be disabled
    const remaining = screen.getAllByLabelText('Remove option');
    expect(remaining).toHaveLength(2);
    remaining.forEach((btn) => {
      expect(btn).toBeDisabled();
    });
  });

  it('emits poll:start with the configured options', () => {
    const emit = vi.fn();
    const mockSocket = { emit } as unknown as TypedSocket;
    const onStarted = vi.fn();

    renderSetup(mockSocket, () => {}, onStarted);

    // Click start with the default options
    fireEvent.click(screen.getByText('Start Poll'));

    expect(emit).toHaveBeenCalledWith('poll:start', {
      multiSelect: true,
      options: DEFAULT_POLL_OPTIONS.map((o) => ({
        emoji: o.emoji,
        label: o.label,
      })),
    });
    expect(onStarted).toHaveBeenCalled();
  });

  it('calls onCancel when the header ✕ (Close) is clicked, and has no footer Cancel', () => {
    const onCancel = vi.fn();
    renderSetup(null, onCancel);

    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('puts the primary action last in the footer, after any secondary action', () => {
    renderSetup(
      null,
      () => {},
      () => {},
      'approve',
      {
        initial: pendingRequest,
        secondaryAction: { label: 'Dismiss request', onClick: () => {} },
      },
    );
    const footer = screen.getByRole('button', { name: 'Approve & Start Poll' }).parentElement!;
    const buttons = Array.from(footer.querySelectorAll('button')).map((b) => b.textContent);
    expect(buttons).toEqual(['Dismiss request', 'Approve & Start Poll']);
  });

  it('disables Start button when fewer than 2 valid options', () => {
    renderSetup();

    // Remove until only 2 remain, then clear both labels to make them invalid
    while (screen.getAllByLabelText('Choose emoji').length > 2) {
      const btn = screen.getAllByLabelText('Remove option').find((b) => !(b as HTMLButtonElement).disabled);
      if (!btn) break;
      fireEvent.click(btn);
    }

    // Clear both remaining labels to make them invalid
    const labels = screen.getAllByLabelText('Option label');
    labels.forEach((input) => {
      fireEvent.change(input, { target: { value: '' } });
    });

    expect(screen.getByText('Start Poll')).toBeDisabled();
  });

  it('includes the poll topic in the emitted payload when provided', () => {
    const emit = vi.fn();
    const mockSocket = { emit } as unknown as TypedSocket;

    renderSetup(mockSocket);

    // Enter a topic
    fireEvent.change(screen.getByLabelText('Poll topic'), { target: { value: 'Should we advance?' } });

    fireEvent.click(screen.getByText('Start Poll'));

    expect(emit).toHaveBeenCalledWith(
      'poll:start',
      expect.objectContaining({
        topic: 'Should we advance?',
      }),
    );
  });

  it('sends multiSelect: false when checkbox is unchecked', () => {
    const emit = vi.fn();
    const mockSocket = { emit } as unknown as TypedSocket;

    renderSetup(mockSocket);

    // Uncheck the multi-select checkbox
    fireEvent.click(screen.getByLabelText(/allow selecting multiple/i));

    fireEvent.click(screen.getByText('Start Poll'));

    expect(emit).toHaveBeenCalledWith(
      'poll:start',
      expect.objectContaining({
        multiSelect: false,
      }),
    );
  });

  it('omits topic from payload when left empty', () => {
    const emit = vi.fn();
    const mockSocket = { emit } as unknown as TypedSocket;

    renderSetup(mockSocket);
    fireEvent.click(screen.getByText('Start Poll'));

    const payload = emit.mock.calls.find((c: unknown[]) => c[0] === 'poll:start')?.[1];
    expect(payload.topic).toBeUndefined();
  });

  describe('request mode', () => {
    it('relabels the heading and submit button', () => {
      renderSetup(
        null,
        () => {},
        () => {},
        'request',
      );

      expect(screen.getByRole('heading', { name: 'Request Poll' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Request Poll' })).toBeInTheDocument();
      expect(screen.queryByText('Start Poll')).not.toBeInTheDocument();
      // No explanatory prose in the dialog.
      expect(screen.queryByText(/chair will see your request/i)).not.toBeInTheDocument();
    });

    it('emits poll:request (not poll:start) with the same payload shape', () => {
      const emit = vi.fn();
      const mockSocket = { emit } as unknown as TypedSocket;
      const onSubmitted = vi.fn();

      renderSetup(mockSocket, () => {}, onSubmitted, 'request');

      fireEvent.change(screen.getByLabelText('Poll topic'), { target: { value: 'Ship it?' } });
      fireEvent.click(screen.getByLabelText(/allow selecting multiple/i));
      fireEvent.click(screen.getByRole('button', { name: 'Request Poll' }));

      expect(emit).toHaveBeenCalledTimes(1);
      expect(emit).toHaveBeenCalledWith('poll:request', {
        topic: 'Ship it?',
        multiSelect: false,
        options: DEFAULT_POLL_OPTIONS.map((o) => ({ emoji: o.emoji, label: o.label })),
      });
      expect(onSubmitted).toHaveBeenCalled();
    });
  });

  describe('approve mode (chair reviewing a request)', () => {
    it('pre-fills the form from the request and names the requester', () => {
      renderSetup(
        null,
        () => {},
        () => {},
        'approve',
        { initial: pendingRequest, requester: bobUser },
      );

      expect(screen.getByRole('heading', { name: 'Review Poll Request' })).toBeInTheDocument();
      expect(screen.getByText('Bob')).toBeInTheDocument();
      expect(screen.getByLabelText('Poll topic')).toHaveValue('Ship it?');
      expect(screen.getByLabelText(/allow selecting multiple/i)).not.toBeChecked();
      const labels = screen.getAllByLabelText('Option label') as HTMLInputElement[];
      expect(labels.map((l) => l.value)).toEqual(['Yes', 'No', 'Abstain']);
      expect(screen.getAllByLabelText('Choose emoji').map((b) => b.textContent)).toEqual(['👍', '👎', '🤷']);
      expect(screen.getByRole('button', { name: 'Approve & Start Poll' })).toBeEnabled();
    });

    it('emits poll:approveRequest with the request id and the (edited) configuration', () => {
      const emit = vi.fn();
      const onSubmitted = vi.fn();
      renderSetup({ emit } as unknown as TypedSocket, () => {}, onSubmitted, 'approve', {
        initial: pendingRequest,
        requester: bobUser,
      });

      // Chair tweaks the topic and drops the last option before approving.
      fireEvent.change(screen.getByLabelText('Poll topic'), { target: { value: 'Ship it today?' } });
      fireEvent.click(screen.getAllByLabelText('Remove option')[2]);
      fireEvent.click(screen.getByRole('button', { name: 'Approve & Start Poll' }));

      expect(emit).toHaveBeenCalledTimes(1);
      expect(emit).toHaveBeenCalledWith('poll:approveRequest', {
        id: 'req-1',
        topic: 'Ship it today?',
        multiSelect: false,
        options: [
          { emoji: '👍', label: 'Yes' },
          { emoji: '👎', label: 'No' },
        ],
      });
      expect(onSubmitted).toHaveBeenCalled();
    });

    it('disables approval with an explanation while another poll is running', () => {
      renderSetup(
        null,
        () => {},
        () => {},
        'approve',
        {
          initial: pendingRequest,
          submitDisabledReason: 'Stop the running poll before approving another.',
        },
      );
      const submit = screen.getByRole('button', { name: 'Approve & Start Poll' });
      expect(submit).toBeDisabled();
      expect(screen.getByText('Stop the running poll before approving another.')).toBeInTheDocument();
    });

    it('renders the secondary action (Dismiss request)', () => {
      const onClick = vi.fn();
      renderSetup(
        null,
        () => {},
        () => {},
        'approve',
        {
          initial: pendingRequest,
          secondaryAction: { label: 'Dismiss request', onClick },
        },
      );
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss request' }));
      expect(onClick).toHaveBeenCalled();
    });
  });

  describe('notice (e.g. revised request)', () => {
    it('renders the notice text and action, and leaves the form contents alone', () => {
      const onAction = vi.fn();
      renderSetup(
        null,
        () => {},
        () => {},
        'approve',
        {
          initial: pendingRequest,
          notice: {
            text: 'The requester has revised this request.',
            actionLabel: 'Load revision',
            onAction,
          },
          approveRequestId: 'req-2',
        },
      );
      expect(screen.getByRole('status')).toHaveTextContent(/revised this request/);
      // Snapshot still shown, not the revision.
      expect(screen.getByLabelText('Poll topic')).toHaveValue('Ship it?');
      fireEvent.click(screen.getByRole('button', { name: 'Load revision' }));
      expect(onAction).toHaveBeenCalled();
    });

    it('approves the on-screen form against the live request id', () => {
      const emit = vi.fn();
      renderSetup(
        { emit } as unknown as TypedSocket,
        () => {},
        () => {},
        'approve',
        {
          initial: pendingRequest,
          approveRequestId: 'req-2',
          notice: { text: 'The requester has revised this request.', actionLabel: 'Load revision', onAction: () => {} },
        },
      );
      const approve = screen.getByRole('button', { name: 'Approve & Start Poll' });
      expect(approve).toBeEnabled();
      fireEvent.click(approve);
      expect(emit).toHaveBeenCalledWith(
        'poll:approveRequest',
        expect.objectContaining({ id: 'req-2', topic: 'Ship it?' }),
      );
    });
  });

  describe('submit guarding', () => {
    it('swallows the submit when beforeSubmit returns false', () => {
      const emit = vi.fn();
      const onSubmitted = vi.fn();
      renderSetup({ emit } as unknown as TypedSocket, () => {}, onSubmitted, 'approve', {
        initial: pendingRequest,
        beforeSubmit: () => false,
      });
      fireEvent.click(screen.getByRole('button', { name: 'Approve & Start Poll' }));
      expect(emit).not.toHaveBeenCalled();
      expect(onSubmitted).not.toHaveBeenCalled();
    });

    it('ignores a rapid second submit (double-click)', () => {
      const emit = vi.fn();
      renderSetup({ emit } as unknown as TypedSocket);
      fireEvent.click(screen.getByText('Start Poll'));
      fireEvent.click(screen.getByText('Start Poll'));
      expect(emit).toHaveBeenCalledTimes(1);
    });

    it('disables the secondary action when asked', () => {
      const onClick = vi.fn();
      renderSetup(
        null,
        () => {},
        () => {},
        'approve',
        {
          initial: pendingRequest,
          secondaryAction: { label: 'Dismiss request', onClick, disabled: true },
        },
      );
      const btn = screen.getByRole('button', { name: 'Dismiss request' });
      expect(btn).toBeDisabled();
      fireEvent.click(btn);
      expect(onClick).not.toHaveBeenCalled();
    });
  });

  describe('request mode with an existing request (requester editing)', () => {
    it('pre-fills, relabels to Update Request, and re-emits poll:request', () => {
      const emit = vi.fn();
      renderSetup(
        { emit } as unknown as TypedSocket,
        () => {},
        () => {},
        'request',
        { initial: pendingRequest },
      );

      expect(screen.getByRole('heading', { name: 'Edit Poll Request' })).toBeInTheDocument();
      fireEvent.change(screen.getByLabelText('Poll topic'), { target: { value: 'Revised' } });
      fireEvent.click(screen.getByRole('button', { name: 'Update Request' }));

      expect(emit).toHaveBeenCalledWith(
        'poll:request',
        expect.objectContaining({ topic: 'Revised', multiSelect: false }),
      );
    });
  });
});
