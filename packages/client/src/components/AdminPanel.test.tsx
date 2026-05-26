import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AdminPanel } from './AdminPanel.js';
import { formatFullTimestamp } from '../lib/timeFormat.js';

const mockFetch = vi.fn();
beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});

function renderPanel() {
  return render(
    <MemoryRouter>
      <AdminPanel refreshTick={0} />
    </MemoryRouter>,
  );
}

// Synthetic usernames for sample meetings: 12 for the first, 4 for the
// second. Length stands in for the displayed count; the values populate
// the tooltip.
const pineParticipants = Array.from({ length: 12 }, (_, i) => `pine-user-${String(i + 1).padStart(2, '0')}`);
const foxParticipants = Array.from({ length: 4 }, (_, i) => `fox-user-${String(i + 1).padStart(2, '0')}`);

const sampleMeetings = [
  {
    id: 'bright-pine-lake',
    createdAt: '2026-04-22T09:00:00.000Z',
    participantUsernames: pineParticipants,
    currentConnections: 7,
    lastConnection: 'now',
    deletedAt: null,
  },
  {
    id: 'calm-wave-fox',
    createdAt: '2026-04-13T08:00:00.000Z',
    participantUsernames: foxParticipants,
    currentConnections: 0,
    lastConnection: '2026-04-13T12:00:00.000Z',
    deletedAt: null,
  },
];

describe('AdminPanel', () => {
  it('renders a list of meetings', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(sampleMeetings),
    });

    renderPanel();

    await waitFor(() => {
      expect(screen.getByText('bright-pine-lake')).toBeInTheDocument();
      expect(screen.getByText('calm-wave-fox')).toBeInTheDocument();
    });
  });

  it('shows connection statistics', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(sampleMeetings),
    });

    renderPanel();

    await waitFor(() => {
      // Participants count for first meeting
      expect(screen.getByText('12')).toBeInTheDocument();
      // Last connection for first meeting (with current connection count)
      expect(screen.getByText('now (7)')).toBeInTheDocument();
    });
  });

  it('shows the full participant list in the cell tooltip', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(sampleMeetings),
    });

    renderPanel();

    // Locate each participants cell via its displayed count and assert the
    // raw `title` attribute. `getByTitle` can't be used directly here
    // because it normalises whitespace and would collapse the newlines.
    await waitFor(() => {
      expect(screen.getByText('12').closest('td')).toHaveAttribute('title', pineParticipants.join('\n'));
      expect(screen.getByText('4').closest('td')).toHaveAttribute('title', foxParticipants.join('\n'));
    });
  });

  it('renders the created-at column with a locale-formatted timestamp as tooltip', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(sampleMeetings),
    });

    renderPanel();

    await waitFor(() => {
      // Titles are formatted in the viewer's locale + time zone, so compute
      // the expected strings rather than hard-coding them.
      expect(screen.getByTitle(formatFullTimestamp('2026-04-22T09:00:00.000Z'))).toBeInTheDocument();
      expect(screen.getByTitle(formatFullTimestamp('2026-04-13T08:00:00.000Z'))).toBeInTheDocument();
    });
  });

  it('shows "No active meetings" when list is empty', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([]),
    });

    renderPanel();

    await waitFor(() => {
      expect(screen.getByText(/no active meetings/i)).toBeInTheDocument();
    });
  });

  it('meeting IDs are links to the meeting page', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(sampleMeetings),
    });

    renderPanel();

    await waitFor(() => {
      const link = screen.getByText('bright-pine-lake');
      expect(link.closest('a')).toHaveAttribute('href', '/meeting/bright-pine-lake');
    });
  });

  it('shows a delete confirmation dialog when delete is clicked', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(sampleMeetings),
    });

    renderPanel();

    await waitFor(() => {
      expect(screen.getByText('bright-pine-lake')).toBeInTheDocument();
    });

    // Click the first delete button
    const deleteButtons = screen.getAllByText('Delete');
    fireEvent.click(deleteButtons[0]);

    // Confirmation dialog should appear
    expect(screen.getByText(/are you sure/i)).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: /confirm deletion/i })).toBeInTheDocument();
  });

  it('soft-deletes a meeting when confirmed — row stays in the list, struck-through, with a Restore action', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(sampleMeetings),
    });

    renderPanel();

    await waitFor(() => {
      expect(screen.getByText('bright-pine-lake')).toBeInTheDocument();
    });

    // Click delete on first meeting
    const deleteButtons = screen.getAllByText('Delete');
    fireEvent.click(deleteButtons[0]);

    // Mock the DELETE request
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });

    // Confirm deletion — click the red "Delete" button in the modal
    const confirmButton = screen.getAllByText('Delete').find((el) => el.className.includes('bg-red'))!;
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith('/api/admin/meetings/bright-pine-lake', { method: 'DELETE' });
      // Soft delete: row remains, rendered struck-through, the meeting-ID
      // link is replaced by a plain span, and the action button becomes Restore.
      const idCell = screen.getByText('bright-pine-lake');
      expect(idCell).toBeInTheDocument();
      expect(idCell.closest('a')).toBeNull();
      expect(idCell.closest('td')).toHaveClass('line-through');
      expect(screen.getByText('Restore')).toBeInTheDocument();
    });
  });

  it('restores a soft-deleted meeting when Restore is clicked', async () => {
    // Server returns one live meeting and one already-deleted meeting;
    // the deleted row shows Restore and POSTs to the restore endpoint.
    const meetings = [sampleMeetings[0], { ...sampleMeetings[1], deletedAt: '2026-05-01T12:00:00.000Z' }];
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(meetings),
    });

    renderPanel();

    await waitFor(() => {
      expect(screen.getByText('calm-wave-fox')).toBeInTheDocument();
    });

    // Deleted-row affordances: no link, strikethrough on the id cell,
    // Restore button instead of Delete.
    const deletedIdCell = screen.getByText('calm-wave-fox');
    expect(deletedIdCell.closest('a')).toBeNull();
    expect(deletedIdCell.closest('td')).toHaveClass('line-through');

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });

    fireEvent.click(screen.getByText('Restore'));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith('/api/admin/meetings/calm-wave-fox/restore', { method: 'POST' });
      // After restore, the row reverts: link reinstated, strikethrough
      // gone, action button is Delete again.
      const idCell = screen.getByText('calm-wave-fox');
      expect(idCell.closest('a')).toHaveAttribute('href', '/meeting/calm-wave-fox');
      expect(idCell.closest('td')).not.toHaveClass('line-through');
      expect(screen.queryByText('Restore')).not.toBeInTheDocument();
    });
  });

  it('cancels deletion when cancel is clicked', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(sampleMeetings),
    });

    renderPanel();

    await waitFor(() => {
      expect(screen.getByText('bright-pine-lake')).toBeInTheDocument();
    });

    // Open delete dialog
    const deleteButtons = screen.getAllByText('Delete');
    fireEvent.click(deleteButtons[0]);

    // Click Cancel
    fireEvent.click(screen.getByText('Cancel'));

    // The native <dialog> is now closed (display:none → out of the a11y
    // tree). Its contents linger in the DOM through the exit animation, so
    // assert via the dialog role rather than its text — and target the row's
    // link for the "still in list" check (the lingering dialog also names the
    // meeting in a <strong>).
    expect(screen.queryByRole('dialog', { name: /confirm deletion/i })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'bright-pine-lake' })).toBeInTheDocument();
  });
});
