import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { MeetingState, User } from '@tcq/shared';
import { AgendaForm } from './AgendaForm.js';
import { TestMeetingProvider } from '../test/TestMeetingProvider.js';
import { SocketContext, type TypedSocket } from '../contexts/SocketContext.js';

const chairUser: User = {
  ghid: 1,
  ghUsername: 'alice',
  name: 'Alice',
  organisation: 'ACME',
};

import { makeMeeting as buildMeeting } from '../test/makeMeeting.js';

const baseMeeting: MeetingState = buildMeeting(undefined, {
  id: 'test',
  users: { alice: chairUser },
  chairIds: ['alice'],
});

function renderForm(socket: TypedSocket | null = null, onCancel = () => {}, onSubmit = () => {}) {
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
    expect(screen.getByLabelText('Presenters')).toBeInTheDocument();
    expect(screen.getByLabelText('Estimate')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('pre-fills the presenters field with the current user username', () => {
    renderForm();
    const presentersInput = screen.getByLabelText('Presenters') as HTMLInputElement;
    expect(presentersInput.value).toBe('alice');
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

    // Fill in estimate
    fireEvent.change(screen.getByLabelText('Estimate'), {
      target: { value: '15' },
    });

    // Submit the form
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(emit).toHaveBeenCalledWith('agenda:add', {
      name: 'Test Item',
      presenterUsernames: ['alice'],
      duration: 15,
    });
    expect(onSubmit).toHaveBeenCalled();
  });

  it('omits duration when the estimate field is empty', () => {
    const emit = vi.fn();
    const mockSocket = { emit } as unknown as TypedSocket;

    renderForm(mockSocket);

    fireEvent.change(screen.getByLabelText('Agenda Item Name'), {
      target: { value: 'No estimate' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(emit).toHaveBeenCalledWith('agenda:add', {
      name: 'No estimate',
      presenterUsernames: ['alice'],
      duration: undefined,
    });
  });
});
