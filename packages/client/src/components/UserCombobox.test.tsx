import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { UserCombobox } from './UserCombobox.js';

/** Stub /api/users/autocomplete with an in-test fetch. Returns the canned users. */
function stubFetch(users: Array<{ login: string; name: string; avatarUrl: string }>) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify({ users }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  );
}

describe('UserCombobox (single)', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // Use fake timers so we can flush the 250ms debounce deterministically.
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  it('commits the typed value on Enter even with no suggestion match (free-text fallback)', () => {
    globalThis.fetch = stubFetch([]) as unknown as typeof fetch;
    const onCommit = vi.fn();

    render(<UserCombobox mode="single" onCommit={onCommit} ariaLabel="Username" />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'no-such-user' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onCommit).toHaveBeenCalledWith('no-such-user');
  });

  it('debounces fetches by 250ms', async () => {
    const fetchMock = stubFetch([]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    render(<UserCombobox mode="single" onCommit={vi.fn()} ariaLabel="Username" />);
    const input = screen.getByRole('combobox');

    // Three quick keystrokes — only the final value should hit the network.
    fireEvent.change(input, { target: { value: 'a' } });
    fireEvent.change(input, { target: { value: 'al' } });
    fireEvent.change(input, { target: { value: 'ali' } });

    // Before the debounce window elapses, no call has been made.
    // (The mount-time effect also schedules a fetch, so just make sure the
    // *most recent* state is the one queried after timers flush.)
    act(() => {
      vi.advanceTimersByTime(249);
    });
    expect(fetchMock).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('q=ali');
  });

  it('does NOT auto-select the first suggestion — Enter without ArrowDown commits the typed text', async () => {
    vi.useRealTimers();
    const fetchMock = stubFetch([
      { login: 'alice', name: 'Alice', avatarUrl: 'a.png' },
      { login: 'allison', name: 'Allison', avatarUrl: 'b.png' },
    ]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const onCommit = vi.fn();

    render(<UserCombobox mode="single" onCommit={onCommit} ariaLabel="Username" />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'al' } });

    await waitFor(() => screen.getByRole('option', { name: /alice/i }));

    // Even though suggestions are visible, Enter alone commits the typed
    // text — no suggestion is highlighted yet.
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith('al');
  });

  it('does not fetch suggestions until the user types at least one character', async () => {
    const fetchMock = stubFetch([]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    render(<UserCombobox mode="single" onCommit={vi.fn()} ariaLabel="Username" autoFocus />);

    // The input mounts focused, but no fetch should fire from focus alone.
    // Advance past the debounce window to be sure.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(fetchMock).not.toHaveBeenCalled();

    // First user-driven edit unlocks the fetch.
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'a' } });
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not fetch suggestions when an initialValue pre-fills the input', () => {
    const fetchMock = stubFetch([]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    render(<UserCombobox mode="single" onCommit={vi.fn()} ariaLabel="Username" initialValue="admin" autoFocus />);

    // Pre-filled, focused, debounce window elapsed — still no fetch, because
    // the user hasn't actually edited the value.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not show the dropdown when the input is empty (focus alone is not a query)', async () => {
    vi.useRealTimers();
    const fetchMock = stubFetch([{ login: 'alice', name: 'Alice', avatarUrl: 'a.png' }]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    render(<UserCombobox mode="single" onCommit={vi.fn()} ariaLabel="Username" autoFocus />);

    // Even after the focus + debounce + would-be-network roundtrip, no
    // listbox renders because the input is empty.
    await new Promise((r) => setTimeout(r, 350));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('only commits a suggestion on a primary-button click', async () => {
    vi.useRealTimers();
    const fetchMock = stubFetch([{ login: 'alice', name: 'Alice', avatarUrl: 'a.png' }]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const onCommit = vi.fn();

    render(<UserCombobox mode="single" onCommit={onCommit} ariaLabel="Username" />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'al' } });
    const option = await screen.findByRole('option', { name: /alice/i });

    // Right-click (button 2) and middle-click (button 1) must NOT commit —
    // those are context-menu / paste gestures, not selections.
    fireEvent.mouseDown(option, { button: 2 });
    fireEvent.mouseDown(option, { button: 1 });
    expect(onCommit).not.toHaveBeenCalled();

    // Primary click (button 0) commits.
    fireEvent.mouseDown(option, { button: 0 });
    expect(onCommit).toHaveBeenCalledWith('alice');
  });

  it('selects the first suggestion after ArrowDown + Enter', async () => {
    vi.useRealTimers();
    const fetchMock = stubFetch([
      { login: 'alice', name: 'Alice', avatarUrl: 'a.png' },
      { login: 'allison', name: 'Allison', avatarUrl: 'b.png' },
    ]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const onCommit = vi.fn();

    render(<UserCombobox mode="single" onCommit={onCommit} ariaLabel="Username" />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'al' } });

    await waitFor(() => screen.getByRole('option', { name: /alice/i }));

    // ArrowDown moves the highlight from "nothing" to the first suggestion;
    // Enter then commits it.
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith('alice');
  });
});

describe('UserCombobox (multi)', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  it('commits a free-text token on Enter when no suggestion is selected', () => {
    globalThis.fetch = stubFetch([]) as unknown as typeof fetch;

    function Host() {
      const [values, setValues] = useState<string[]>([]);
      return <UserCombobox mode="multi" values={values} onChange={setValues} ariaLabel="Tokens" />;
    }
    render(<Host />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'plain-text' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(screen.getByText('plain-text')).toBeInTheDocument();
  });

  it('treats comma as a commit key for tokens', () => {
    globalThis.fetch = stubFetch([]) as unknown as typeof fetch;

    function Host() {
      const [values, setValues] = useState<string[]>([]);
      return <UserCombobox mode="multi" values={values} onChange={setValues} ariaLabel="Tokens" />;
    }
    render(<Host />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: '@alice' } });
    fireEvent.keyDown(input, { key: ',' });

    // The leading @ is normalised away by normaliseGithubUsername.
    expect(screen.getByText('alice')).toBeInTheDocument();
  });

  it('does not duplicate an existing token', () => {
    globalThis.fetch = stubFetch([]) as unknown as typeof fetch;
    const onChange = vi.fn();

    render(<UserCombobox mode="multi" values={['alice']} onChange={onChange} ariaLabel="Tokens" />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'Alice' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onChange).not.toHaveBeenCalled();
  });

  it('does NOT commit on blur — typed draft stays put for the user to commit explicitly', () => {
    vi.useRealTimers();
    globalThis.fetch = stubFetch([]) as unknown as typeof fetch;
    const onChange = vi.fn();

    render(<UserCombobox mode="multi" values={[]} onChange={onChange} ariaLabel="Tokens" />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'alice' } });

    // Blurring the input must not turn the draft into a chip; the user
    // explicitly presses Enter / comma / clicks a suggestion to commit.
    fireEvent.blur(input);
    return new Promise<void>((r) =>
      setTimeout(() => {
        expect(onChange).not.toHaveBeenCalled();
        r();
      }, 200),
    );
  });

  it('renders an avatar inside each chip', () => {
    globalThis.fetch = stubFetch([]) as unknown as typeof fetch;

    const { container } = render(
      <UserCombobox mode="multi" values={['alice', 'bob']} onChange={vi.fn()} ariaLabel="Tokens" />,
    );

    // Each chip carries an <img> pointing at the GitHub-served avatar for
    // its login. The img has alt="" (decorative), so it's not exposed as
    // role="img" — query the DOM directly. The fallback silhouette only
    // shows on load error; unit tests don't load images so we just check
    // the `src` pattern.
    const sources = Array.from(container.querySelectorAll('img')).map((img) => img.getAttribute('src'));
    expect(sources).toEqual(
      expect.arrayContaining([
        expect.stringContaining('github.com/alice.png'),
        expect.stringContaining('github.com/bob.png'),
      ]),
    );
  });

  it('removes the last token on Backspace into an empty input', () => {
    globalThis.fetch = stubFetch([]) as unknown as typeof fetch;

    function Host() {
      const [values, setValues] = useState<string[]>(['alice', 'bob']);
      return <UserCombobox mode="multi" values={values} onChange={setValues} ariaLabel="Tokens" />;
    }
    render(<Host />);
    const input = screen.getByRole('combobox');
    fireEvent.keyDown(input, { key: 'Backspace' });

    expect(screen.queryByText('bob')).not.toBeInTheDocument();
    expect(screen.getByText('alice')).toBeInTheDocument();
  });
});
