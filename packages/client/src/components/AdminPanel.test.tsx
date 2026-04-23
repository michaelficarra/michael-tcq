import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AdminPanel } from './AdminPanel.js';

const mockFetch = vi.fn();
beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});

function renderPanel() {
  return render(
    <MemoryRouter>
      <AdminPanel />
    </MemoryRouter>,
  );
}

const sampleMeetings = [
  {
    id: 'bright-pine-lake',
    createdAt: '2026-04-22T09:00:00.000Z',
    participants: 12,
    currentConnections: 7,
    lastConnection: 'now',
  },
  {
    id: 'calm-wave-fox',
    createdAt: '2026-04-13T08:00:00.000Z',
    participants: 4,
    currentConnections: 0,
    lastConnection: '2026-04-13T12:00:00.000Z',
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

  it('renders the created-at column with the raw ISO timestamp as tooltip', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(sampleMeetings),
    });

    renderPanel();

    await waitFor(() => {
      expect(screen.getByTitle('2026-04-22T09:00:00.000Z')).toBeInTheDocument();
      expect(screen.getByTitle('2026-04-13T08:00:00.000Z')).toBeInTheDocument();
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

  it('deletes a meeting when confirmed', async () => {
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
      // Meeting should be removed from the list
      expect(screen.queryByText('bright-pine-lake')).not.toBeInTheDocument();
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

    // Dialog should be gone, meeting still in list
    expect(screen.queryByText(/are you sure/i)).not.toBeInTheDocument();
    expect(screen.getByText('bright-pine-lake')).toBeInTheDocument();
  });
});
