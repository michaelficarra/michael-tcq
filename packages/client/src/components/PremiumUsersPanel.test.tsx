import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PremiumUsersPanel } from './PremiumUsersPanel.js';
import { ToastProvider } from '../contexts/ToastContext.js';

// We mock `fetch` rather than spinning up a real server — same approach as
// AdminPanel.test.tsx. Tests focus on the optimistic update / rollback
// behaviour; the wire contract is covered separately by the server-side
// admin.test.ts suite.
const mockFetch = vi.fn();
beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});

/** Mock a single GET /api/admin/premium-users response. */
function mockListResponse(usernames: string[]) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve({ usernames }),
  });
}

/** Mock a single mutating response (POST or DELETE) — returns the new list. */
function mockMutationResponse(usernames: string[], ok = true, error?: string) {
  mockFetch.mockResolvedValueOnce({
    ok,
    json: () => Promise.resolve(ok ? { ok: true, usernames } : { error }),
  });
}

function renderPanel() {
  return render(
    <ToastProvider>
      <PremiumUsersPanel refreshTick={0} />
    </ToastProvider>,
  );
}

describe('PremiumUsersPanel', () => {
  it('renders the empty-state copy when no premium users are persisted', async () => {
    mockListResponse([]);
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText('No premium users yet.')).toBeInTheDocument();
    });
  });

  it('renders one pill per persisted username', async () => {
    mockListResponse(['alice', 'bob', 'charlie']);
    renderPanel();
    await waitFor(() => {
      expect(screen.getByLabelText(/Remove alice/)).toBeInTheDocument();
      expect(screen.getByLabelText(/Remove bob/)).toBeInTheDocument();
      expect(screen.getByLabelText(/Remove charlie/)).toBeInTheDocument();
    });
  });

  it('POSTs to the server when the combobox commits and renders the returned canonical list', async () => {
    // Initial GET → empty list. After committing "Alice" the panel
    // should POST and then re-render with the server-canonical
    // lowercased form.
    mockListResponse([]);
    mockMutationResponse(['alice']);
    renderPanel();

    await waitFor(() => {
      expect(screen.getByText('No premium users yet.')).toBeInTheDocument();
    });

    const input = screen.getByLabelText('Add premium user');
    fireEvent.change(input, { target: { value: 'Alice' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      // The panel sends the raw typed value; the server canonicalises it
      // (here the mocked response returns the lowercased `alice`).
      expect(mockFetch).toHaveBeenCalledWith('/api/admin/premium-users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'Alice' }),
      });
      expect(screen.getByLabelText(/Remove alice/)).toBeInTheDocument();
    });
  });

  it('rolls back the optimistic add when the server rejects it', async () => {
    mockListResponse([]);
    // 400 response — invalid username from the server's perspective.
    mockMutationResponse([], false, 'Invalid GitHub username');
    renderPanel();

    await waitFor(() => {
      expect(screen.getByText('No premium users yet.')).toBeInTheDocument();
    });

    const input = screen.getByLabelText('Add premium user');
    fireEvent.change(input, { target: { value: 'bad' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      // Error surfaced inline …
      expect(screen.getByRole('alert')).toHaveTextContent('Invalid GitHub username');
      // … and the optimistic pill is gone (empty-state copy is back).
      expect(screen.getByText('No premium users yet.')).toBeInTheDocument();
    });
  });

  it('DELETEs the username when the × button is clicked', async () => {
    mockListResponse(['alice', 'bob']);
    mockMutationResponse(['bob']);
    renderPanel();

    await waitFor(() => {
      expect(screen.getByLabelText(/Remove alice/)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText('Remove alice'));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith('/api/admin/premium-users/alice', { method: 'DELETE' });
      expect(screen.queryByLabelText('Remove alice')).not.toBeInTheDocument();
      expect(screen.getByLabelText(/Remove bob/)).toBeInTheDocument();
    });
  });

  it('rolls back an optimistic remove when the server rejects it', async () => {
    mockListResponse(['alice']);
    mockMutationResponse([], false, 'Some server error');
    renderPanel();

    await waitFor(() => {
      expect(screen.getByLabelText(/Remove alice/)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText('Remove alice'));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Some server error');
      // Pill restored.
      expect(screen.getByLabelText(/Remove alice/)).toBeInTheDocument();
    });
  });
});
