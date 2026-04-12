import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { MeetingState, User } from '@tcq/shared';
import { AgendaForm } from './AgendaForm.js';
import { TestMeetingProvider } from '../test/TestMeetingProvider.js';
import { SocketContext, type TypedSocket } from '../contexts/SocketContext.js';

const chairUser: User = {
  ghid: 1, ghUsername: 'alice', name: 'Alice', organisation: 'ACME',
};

const baseMeeting: MeetingState = {
  id: 'test', chairs: [chairUser], agenda: [],
  currentAgendaItem: undefined, currentSpeaker: undefined, currentTopic: undefined,
  queuedSpeakers: [], reactions: [], trackTemperature: false, version: 0,
};

function renderForm(
  socket: TypedSocket | null = null,
  onCancel = () => {},
  onSubmit = () => {},
) {
  return render(
    <TestMeetingProvider meeting={baseMeeting} user={chairUser}>
      <SocketContext value={socket}>
        <AgendaForm onCancel={onCancel} onSubmit={onSubmit} />
      </SocketContext>
    </TestMeetingProvider>,
  );
}

describe('AgendaForm', () => {
  it('renders all form fields', () => {
    renderForm();

    expect(screen.getByLabelText('Agenda Item Name')).toBeInTheDocument();
    expect(screen.getByLabelText('Owner')).toBeInTheDocument();
    expect(screen.getByLabelText('Timebox')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('pre-fills the owner field with the current user username', () => {
    renderForm();
    const ownerInput = screen.getByLabelText('Owner') as HTMLInputElement;
    expect(ownerInput.value).toBe('alice');
  });

  it('focuses the name input on mount', () => {
    renderForm();
    expect(screen.getByLabelText('Agenda Item Name')).toHaveFocus();
  });

  it('calls onCancel when Cancel is clicked', () => {
    const onCancel = vi.fn();
    renderForm(null, onCancel);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('emits agenda:add with correct payload on submit', () => {
    const emit = vi.fn();
    const mockSocket = { emit } as unknown as TypedSocket;
    const onSubmit = vi.fn();

    renderForm(mockSocket, () => {}, onSubmit);

    // Fill in the name
    fireEvent.change(screen.getByLabelText('Agenda Item Name'), {
      target: { value: 'Test Item' },
    });

    // Fill in timebox
    fireEvent.change(screen.getByLabelText('Timebox'), {
      target: { value: '15' },
    });

    // Submit the form
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(emit).toHaveBeenCalledWith('agenda:add', {
      name: 'Test Item',
      ownerUsername: 'alice',
      timebox: 15,
    });
    expect(onSubmit).toHaveBeenCalled();
  });

  it('omits timebox when empty', () => {
    const emit = vi.fn();
    const mockSocket = { emit } as unknown as TypedSocket;

    renderForm(mockSocket);

    fireEvent.change(screen.getByLabelText('Agenda Item Name'), {
      target: { value: 'No timebox' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(emit).toHaveBeenCalledWith('agenda:add', {
      name: 'No timebox',
      ownerUsername: 'alice',
      timebox: undefined,
    });
  });
});
