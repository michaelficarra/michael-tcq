import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext.js';
import { LoginPage } from './pages/LoginPage.js';
import { HomePage } from './pages/HomePage.js';

// Mock fetch globally for these tests
const mockFetch = vi.fn();
beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});

// Mock useNavigate
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

function renderHomePage() {
  // Simulate an authenticated user for HomePage tests
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve({ ghid: 1, ghUsername: 'alice', name: 'Alice', organisation: 'ACME' }),
  });

  return render(
    <MemoryRouter>
      <AuthProvider>
        <HomePage />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('LoginPage', () => {
  it('renders the TCQ branding', () => {
    render(<LoginPage />);
    expect(screen.getByText('TCQ')).toBeInTheDocument();
  });

  it('renders a "Log in with GitHub" link', () => {
    render(<LoginPage />);
    const link = screen.getByText('Log in with GitHub');
    expect(link).toBeInTheDocument();
    expect(link.closest('a')).toHaveAttribute('href', '/auth/github');
  });
});

describe('HomePage', () => {
  it('renders Join Meeting and New Meeting cards', async () => {
    renderHomePage();
    // Wait for auth to resolve — check for the card headings (h2)
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Join Meeting' })).toBeInTheDocument();
    });
    expect(screen.getByRole('heading', { name: 'New Meeting' })).toBeInTheDocument();
  });

  // -- Join Meeting --

  it('has a meeting ID input and Join button', async () => {
    renderHomePage();
    await waitFor(() => {
      expect(screen.getByLabelText('Meeting ID')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Join' })).toBeInTheDocument();
  });

  it('navigates to the meeting page on successful join', async () => {
    renderHomePage();
    await waitFor(() => {
      expect(screen.getByLabelText('Meeting ID')).toBeInTheDocument();
    });

    // Mock the meeting lookup
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });

    fireEvent.change(screen.getByLabelText('Meeting ID'), {
      target: { value: 'bright-pine-lake' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Join' }));

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/meeting/bright-pine-lake');
    });
  });

  it('shows an error when meeting is not found', async () => {
    renderHomePage();
    await waitFor(() => {
      expect(screen.getByLabelText('Meeting ID')).toBeInTheDocument();
    });

    mockFetch.mockResolvedValueOnce({ ok: false });

    fireEvent.change(screen.getByLabelText('Meeting ID'), {
      target: { value: 'no-such-meeting' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Join' }));

    await waitFor(() => {
      expect(screen.getByText('Meeting not found')).toBeInTheDocument();
    });
  });

  // -- New Meeting --

  it('creates a meeting with the current user as chair and navigates to it', async () => {
    renderHomePage();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Start a New Meeting' })).toBeInTheDocument();
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ id: 'calm-wave-fox' }),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Start a New Meeting' }));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith('/api/meetings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chairs: ['alice'] }),
      });
      expect(mockNavigate).toHaveBeenCalledWith('/meeting/calm-wave-fox');
    });
  });

  it('shows an error when meeting creation fails', async () => {
    renderHomePage();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Start a New Meeting' })).toBeInTheDocument();
    });

    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ error: 'Something went wrong' }),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Start a New Meeting' }));

    await waitFor(() => {
      expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    });
  });
});
