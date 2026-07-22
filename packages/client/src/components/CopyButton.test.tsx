import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { CopyButton } from './CopyButton.js';

// navigator.clipboard doesn't exist in jsdom; install a spy we can drive per
// test. writeText resolves by default (success path); individual tests make it
// reject to exercise the failure path.
let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('CopyButton', () => {
  it('copies the text from getText and confirms with role="status"', async () => {
    render(<CopyButton getText={() => 'New Topic: hello (alice)'}>Copy Queue</CopyButton>);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy Queue' }));
    });

    expect(writeText).toHaveBeenCalledWith('New Topic: hello (alice)');
    const confirmation = screen.getByRole('status');
    expect(confirmation).toHaveTextContent('Copied');
    // Rendered as a top-layer popover, not a plain span.
    expect(confirmation).toHaveAttribute('popover', 'manual');
  });

  it('evaluates getText at click time (live state), not at render time', async () => {
    let queue = 'first';
    render(<CopyButton getText={() => queue}>Copy Queue</CopyButton>);

    queue = 'second';
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy Queue' }));
    });

    expect(writeText).toHaveBeenCalledWith('second');
  });

  it('shows a "Copy failed" alert when the clipboard write is denied', async () => {
    writeText.mockReturnValueOnce(Promise.reject(new Error('denied')));
    render(<CopyButton getText={() => 'anything'}>Copy Results</CopyButton>);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy Results' }));
    });

    const failure = screen.getByRole('alert');
    expect(failure).toHaveTextContent('Copy failed');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('auto-dismisses the confirmation after ~1.5s', async () => {
    vi.useFakeTimers();
    render(<CopyButton getText={() => 'x'}>Copy Queue</CopyButton>);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy Queue' }));
    });
    expect(screen.getByRole('status')).toBeInTheDocument();

    // Just before the deadline it's still up; right after, it's gone.
    act(() => {
      vi.advanceTimersByTime(1499);
    });
    expect(screen.getByRole('status')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
