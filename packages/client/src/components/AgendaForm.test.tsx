import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { MeetingState, User } from '@tcq/shared';
import { AgendaForm } from './AgendaForm.js';
import { TestMeetingProvider } from '../test/TestMeetingProvider.js';
import { SocketContext, type TypedSocket } from '../contexts/SocketContext.js';

const chairUser: User = {
  provider: 'github',
  accountId: 'alice',
  handle: 'alice',
  name: 'Alice',
  organisation: 'ACME',
  avatarUrl: 'https://github.com/alice.png?size=80',
};

import { makeMeeting as buildMeeting } from '../test/makeMeeting.js';

const baseMeeting: MeetingState = buildMeeting(undefined, {
  id: 'test',
  users: { 'github:alice': chairUser },
  chairIds: ['github:alice'],
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

  it('starts the presenters field empty', () => {
    renderForm();
    // No chip should be pre-rendered, and the input itself is empty —
    // the chair adds presenters explicitly so a self-presented item never
    // happens by accident.
    expect(screen.queryByText('alice')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Presenters')).toHaveValue('');
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

    // The presenter list starts empty — add 'alice' explicitly.
    const presentersInput = screen.getByLabelText('Presenters');
    fireEvent.change(presentersInput, { target: { value: 'alice' } });
    fireEvent.keyDown(presentersInput, { key: 'Enter' });

    // Fill in estimate
    fireEvent.change(screen.getByLabelText('Estimate'), {
      target: { value: '15' },
    });

    // Submit the form
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(emit).toHaveBeenCalledWith('agenda:add', {
      name: 'Test Item',
      // Free-text entry (no suggestion picked) commits as a bare handle.
      presenters: [{ handle: 'alice' }],
      duration: 15,
    });
    expect(onSubmit).toHaveBeenCalled();
  });

  // Users may type presenter handles in GitHub-style `@name` form; the
  // chip combobox normalises a leading `@` and surrounding whitespace
  // when each token is committed (Enter or comma).
  it('strips a leading @ and surrounding whitespace from each entered presenter', () => {
    const emit = vi.fn();
    const mockSocket = { emit } as unknown as TypedSocket;

    renderForm(mockSocket);

    fireEvent.change(screen.getByLabelText('Agenda Item Name'), {
      target: { value: 'Item' },
    });

    const presentersInput = screen.getByLabelText('Presenters');
    for (const raw of [' @alice ', ' @ bob', 'charlie']) {
      fireEvent.change(presentersInput, { target: { value: raw } });
      fireEvent.keyDown(presentersInput, { key: 'Enter' });
    }

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(emit).toHaveBeenCalledWith('agenda:add', {
      name: 'Item',
      presenters: [{ handle: 'alice' }, { handle: 'bob' }, { handle: 'charlie' }],
      duration: undefined,
    });
  });

  it('omits duration when the estimate field is empty', () => {
    const emit = vi.fn();
    const mockSocket = { emit } as unknown as TypedSocket;

    renderForm(mockSocket);

    fireEvent.change(screen.getByLabelText('Agenda Item Name'), {
      target: { value: 'No estimate' },
    });

    const presentersInput = screen.getByLabelText('Presenters');
    fireEvent.change(presentersInput, { target: { value: 'alice' } });
    fireEvent.keyDown(presentersInput, { key: 'Enter' });

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(emit).toHaveBeenCalledWith('agenda:add', {
      name: 'No estimate',
      presenters: [{ handle: 'alice' }],
      duration: undefined,
    });
  });

  it('submits with no presenters', () => {
    // Presenters are optional — a chair can create an agenda item without
    // committing anyone to introduce it; the floor stays open on advance.
    const emit = vi.fn();
    const mockSocket = { emit } as unknown as TypedSocket;
    const onSubmit = vi.fn();

    renderForm(mockSocket, () => {}, onSubmit);

    fireEvent.change(screen.getByLabelText('Agenda Item Name'), {
      target: { value: 'Open floor' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(emit).toHaveBeenCalledWith('agenda:add', {
      name: 'Open floor',
      presenters: [],
      duration: undefined,
    });
    expect(onSubmit).toHaveBeenCalled();
  });
});
