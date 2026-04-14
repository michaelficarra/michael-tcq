import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { MeetingState, User } from '@tcq/shared';
import { DEFAULT_POLL_OPTIONS } from '@tcq/shared';
import { PollSetup } from './PollSetup.js';
import { TestMeetingProvider } from '../test/TestMeetingProvider.js';
import { SocketContext, type TypedSocket } from '../contexts/SocketContext.js';

const chairUser: User = { ghid: 1, ghUsername: 'alice', name: 'Alice', organisation: '' };

const baseMeeting: MeetingState = {
  id: 'test', users: { alice: chairUser }, chairIds: ['alice'], agenda: [],
  currentAgendaItemId: undefined, currentSpeakerId: undefined,
  currentTopicId: undefined, queueEntries: {}, queuedSpeakerIds: [],
  reactions: [], trackPoll: false, pollOptions: [],
  version: 0, log: [], currentTopicSpeakers: [],
};

function renderSetup(
  socket: TypedSocket | null = null,
  onCancel = () => {},
  onStarted = () => {},
) {
  return render(
    <TestMeetingProvider meeting={baseMeeting} user={chairUser}>
      <SocketContext value={socket}>
        <PollSetup onCancel={onCancel} onStarted={onStarted} />
      </SocketContext>
    </TestMeetingProvider>,
  );
}

describe('PollSetup', () => {
  it('renders the default options', () => {
    renderSetup();

    // Should show all default options
    const emojiInputs = screen.getAllByLabelText('Option emoji');
    expect(emojiInputs.length).toBe(DEFAULT_POLL_OPTIONS.length);

    // First option should be the heart emoji
    expect((emojiInputs[0] as HTMLInputElement).value).toBe('❤️');
  });

  it('renders label inputs for each option', () => {
    renderSetup();

    const labelInputs = screen.getAllByLabelText('Option label');
    expect(labelInputs.length).toBe(DEFAULT_POLL_OPTIONS.length);
    expect((labelInputs[0] as HTMLInputElement).value).toBe('Strong Positive');
  });

  it('allows adding a new option', () => {
    renderSetup();

    const initialCount = screen.getAllByLabelText('Option emoji').length;
    fireEvent.click(screen.getByText('+ Add Option'));
    expect(screen.getAllByLabelText('Option emoji').length).toBe(initialCount + 1);
  });

  it('allows removing an option', () => {
    renderSetup();

    const initialCount = screen.getAllByLabelText('Option emoji').length;
    const removeButtons = screen.getAllByLabelText('Remove option');
    fireEvent.click(removeButtons[0]);
    expect(screen.getAllByLabelText('Option emoji').length).toBe(initialCount - 1);
  });

  it('disables remove buttons when there are only 2 options', () => {
    renderSetup();

    // Remove options one at a time until only 2 remain (default is 6)
    while (screen.getAllByLabelText('Option emoji').length > 2) {
      // Find the first enabled remove button and click it
      const btn = screen.getAllByLabelText('Remove option').find(
        (b) => !(b as HTMLButtonElement).disabled,
      );
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
      options: DEFAULT_POLL_OPTIONS.map((o) => ({
        emoji: o.emoji,
        label: o.label,
      })),
    });
    expect(onStarted).toHaveBeenCalled();
  });

  it('calls onCancel when Cancel is clicked', () => {
    const onCancel = vi.fn();
    renderSetup(null, onCancel);

    fireEvent.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalled();
  });

  it('disables Start button when fewer than 2 valid options', () => {
    renderSetup();

    // Remove until only 2 remain, then clear both labels to make them invalid
    while (screen.getAllByLabelText('Option emoji').length > 2) {
      const btn = screen.getAllByLabelText('Remove option').find(
        (b) => !(b as HTMLButtonElement).disabled,
      );
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
});
