import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
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
  return render(
    <MemoryRouter>
      <HomePage />
    </MemoryRouter>,
  );
}

describe('HomePage', () => {
  it('renders the TCQ branding and Log Out link', () => {
    renderHomePage();
    expect(screen.getByText('TCQ')).toBeInTheDocument();
    expect(screen.getByText('Log Out')).toBeInTheDocument();
  });

  it('renders Join Meeting and New Meeting cards', () => {
    renderHomePage();
    expect(screen.getByText('Join Meeting')).toBeInTheDocument();
    expect(screen.getByText('New Meeting')).toBeInTheDocument();
  });

  // -- Join Meeting --

  it('has a meeting ID input and Join button', () => {
    renderHomePage();
    expect(screen.getByLabelText('Meeting ID')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Join' })).toBeInTheDocument();
  });

  it('navigates to the meeting page on successful join', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });

    renderHomePage();

    fireEvent.change(screen.getByLabelText('Meeting ID'), {
      target: { value: 'bright-pine-lake' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Join' }));

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/meeting/bright-pine-lake');
    });
  });

  it('shows an error when meeting is not found', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false });

    renderHomePage();

    fireEvent.change(screen.getByLabelText('Meeting ID'), {
      target: { value: 'no-such-meeting' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Join' }));

    await waitFor(() => {
      expect(screen.getByText('Meeting not found')).toBeInTheDocument();
    });
  });

  // -- New Meeting --

  it('has a chairs input and Start button', () => {
    renderHomePage();
    expect(screen.getByLabelText('Chairs')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start a New Meeting' })).toBeInTheDocument();
  });

  it('creates a meeting and navigates to it', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ id: 'calm-wave-fox' }),
    });

    renderHomePage();

    fireEvent.change(screen.getByLabelText('Chairs'), {
      target: { value: 'alice, bob' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start a New Meeting' }));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith('/api/meetings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chairs: ['alice', 'bob'] }),
      });
      expect(mockNavigate).toHaveBeenCalledWith('/meeting/calm-wave-fox');
    });
  });

  it('shows an error when meeting creation fails', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ error: 'Something went wrong' }),
    });

    renderHomePage();

    fireEvent.change(screen.getByLabelText('Chairs'), {
      target: { value: 'alice' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start a New Meeting' }));

    await waitFor(() => {
      expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    });
  });

  it('shows a validation error when chairs field is empty commas', () => {
    renderHomePage();

    fireEvent.change(screen.getByLabelText('Chairs'), {
      target: { value: ', , ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start a New Meeting' }));

    expect(screen.getByText('At least one chair is required')).toBeInTheDocument();
  });
});
