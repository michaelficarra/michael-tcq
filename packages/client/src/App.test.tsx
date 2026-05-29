import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext.js';
import { PreferencesProvider } from './contexts/PreferencesContext.js';
import { ToastProvider } from './contexts/ToastContext.js';
import { LoginPage } from './pages/LoginPage.js';
import { HomePage } from './pages/HomePage.js';

// Mock fetch globally for these tests. URL-routed rather than FIFO so the
// HomePage's background `<MyMeetingsPanel/>` fetch can't accidentally consume
// a response queued for the user-driven action a test is about to drive.
const mockResponses = new Map<string, unknown[]>();
const mockFetch = vi.fn(async (url: string, _init?: unknown) => {
  const queue = mockResponses.get(url);
  if (queue && queue.length > 0) return queue.shift();
  // Default: empty list for the home page's My Meetings panel so it stays
  // hidden in tests that don't care; everything else explicitly opts in.
  if (url === '/api/my-meetings') return { ok: true, json: () => Promise.resolve([]) };
  return undefined;
});

function queueResponse(url: string, response: unknown) {
  let queue = mockResponses.get(url);
  if (!queue) {
    queue = [];
    mockResponses.set(url, queue);
  }
  queue.push(response);
}

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockClear();
  mockResponses.clear();
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
  // Simulate an authenticated user for HomePage tests. /api/my-meetings is
  // covered by the URL-routed default ([]).
  queueResponse('/api/me', {
    ok: true,
    json: () =>
      Promise.resolve({
        provider: 'github',
        accountId: 'alice',
        handle: 'alice',
        name: 'Alice',
        organisation: 'ACME',
        avatarUrl: 'https://github.com/alice.png?size=80',
      }),
  });

  return render(
    <PreferencesProvider>
      <ToastProvider>
        <MemoryRouter>
          <AuthProvider>
            <HomePage />
          </AuthProvider>
        </MemoryRouter>
      </ToastProvider>
    </PreferencesProvider>,
  );
}

describe('LoginPage', () => {
  // LoginPage reads useLocation() to attach the current URL to the login
  // link as a returnTo param, so every render needs a Router context.
  function renderAt(path: string) {
    return render(
      <MemoryRouter initialEntries={[path]}>
        <LoginPage />
      </MemoryRouter>,
    );
  }

  it('renders the TCQ branding', () => {
    renderAt('/');
    expect(screen.getByText('TCQ')).toBeInTheDocument();
  });

  it('renders a "Sign in with GitHub" link without returnTo on the root path', async () => {
    // The login page renders a button per configured provider, fetched
    // from /api/auth/providers.
    queueResponse('/api/auth/providers', {
      ok: true,
      json: () => Promise.resolve({ providers: [{ id: 'github', label: 'GitHub' }] }),
    });
    renderAt('/');
    const link = await screen.findByText('Sign in with GitHub');
    expect(link).toBeInTheDocument();
    // No returnTo param: "/" is already the default post-login redirect.
    expect(link.closest('a')).toHaveAttribute('href', '/auth/github');
  });

  it('includes a returnTo param when rendered at a non-root deep link', async () => {
    queueResponse('/api/auth/providers', {
      ok: true,
      json: () => Promise.resolve({ providers: [{ id: 'github', label: 'GitHub' }] }),
    });
    renderAt('/meeting/foo');
    const link = await screen.findByText('Sign in with GitHub');
    expect(link.closest('a')).toHaveAttribute('href', '/auth/github?returnTo=%2Fmeeting%2Ffoo');
  });

  it('renders a branded, logo-bearing button per configured provider', async () => {
    // All four providers enabled — the page renders one button each, in
    // provider order (GitHub → ORCID → Google → Microsoft), each linking to its
    // own /auth/:id route and carrying its brand colour + an inline SVG logo.
    queueResponse('/api/auth/providers', {
      ok: true,
      json: () =>
        Promise.resolve({
          providers: [
            { id: 'github', label: 'GitHub' },
            { id: 'orcid', label: 'ORCID' },
            { id: 'google', label: 'Google' },
            { id: 'microsoft', label: 'Microsoft' },
          ],
        }),
    });
    renderAt('/');

    const githubLink = (await screen.findByText('Sign in with GitHub')).closest('a');
    const orcidLink = screen.getByText('Sign in with ORCID').closest('a');
    // Every provider button reads "Sign in with {label}" — GitHub and ORCID via
    // the default template, Google and Microsoft via their mandated `text`
    // override (whose copy happens to match the default).
    const googleLink = screen.getByText('Sign in with Google').closest('a');
    const microsoftLink = screen.getByText('Sign in with Microsoft').closest('a');

    expect(githubLink).toHaveAttribute('href', '/auth/github');
    expect(orcidLink).toHaveAttribute('href', '/auth/orcid');
    expect(googleLink).toHaveAttribute('href', '/auth/google');
    expect(microsoftLink).toHaveAttribute('href', '/auth/microsoft');

    // Each uses its official brand colour (GitHub charcoal, ORCID green; Google
    // and Microsoft both use a white variant, distinguished by their borders).
    expect(githubLink).toHaveClass('bg-[#24292f]');
    expect(orcidLink).toHaveClass('bg-[#a6ce39]');
    expect(googleLink).toHaveClass('bg-white', 'border-[#747775]');
    expect(microsoftLink).toHaveClass('bg-white', 'border-[#8c8c8c]');

    // Each button carries an inline brand SVG mark.
    expect(githubLink?.querySelector('svg')).toBeInTheDocument();
    expect(orcidLink?.querySelector('svg')).toBeInTheDocument();
    expect(googleLink?.querySelector('svg')).toBeInTheDocument();
    expect(microsoftLink?.querySelector('svg')).toBeInTheDocument();
  });

  it('renders the mock pseudo-provider as a distinct dev-mode button', async () => {
    // In dev (mock-auth) mode the providers endpoint returns the `mock`
    // pseudo-provider. The button must read "Enter dev mode" (not "Sign in
    // with …"), use TCQ teal, and carry a caption flagging it as mock auth.
    queueResponse('/api/auth/providers', {
      ok: true,
      json: () => Promise.resolve({ providers: [{ id: 'mock', label: 'Dev Mode' }], mockAuth: true }),
    });
    renderAt('/');

    const link = (await screen.findByText('Enter dev mode')).closest('a');
    expect(link).toHaveAttribute('href', '/auth/mock');
    expect(link).toHaveClass('bg-teal-700');
    // No "Sign in with …" phrasing for the dev button.
    expect(screen.queryByText(/Sign in with/)).not.toBeInTheDocument();
    // The mock-auth caption is shown beneath the button.
    expect(screen.getByText('Mock authentication — no OAuth provider is configured.')).toBeInTheDocument();
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
    queueResponse('/api/meetings/bright-pine-lake', { ok: true, json: () => Promise.resolve({}) });

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

    queueResponse('/api/meetings/no-such-meeting', { ok: false });

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

    queueResponse('/api/meetings', {
      ok: true,
      json: () => Promise.resolve({ id: 'calm-wave-fox' }),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Start a New Meeting' }));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith('/api/meetings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chairs: [{ provider: 'github', accountId: 'alice' }] }),
      });
      expect(mockNavigate).toHaveBeenCalledWith('/meeting/calm-wave-fox#agenda');
    });
  });

  it('shows an error when meeting creation fails', async () => {
    renderHomePage();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Start a New Meeting' })).toBeInTheDocument();
    });

    queueResponse('/api/meetings', {
      ok: false,
      json: () => Promise.resolve({ error: 'Something went wrong' }),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Start a New Meeting' }));

    await waitFor(() => {
      expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    });
  });
});
