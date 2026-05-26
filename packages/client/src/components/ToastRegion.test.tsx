import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { ToastProvider, useToast, type ToastApi } from '../contexts/ToastContext.js';

// Harness that hands the live toast API back to the test so it can raise and
// dismiss toasts imperatively (mirroring how real call sites use useToast).
function renderToasts(): ToastApi {
  let api!: ToastApi;
  function Capture() {
    api = useToast();
    return null;
  }
  render(
    <ToastProvider>
      <Capture />
    </ToastProvider>,
  );
  return api;
}

/** The popover element for a toast, found via its message text. */
function toastElement(text: string | RegExp): HTMLElement {
  return screen.getByText(text).closest('[popover]') as HTMLElement;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ToastRegion', () => {
  it('renders an error toast with role="alert" and the message', () => {
    const api = renderToasts();
    act(() => {
      api.showToast({ message: 'Something broke' });
    });

    const toast = screen.getByRole('alert');
    expect(toast).toHaveTextContent('Something broke');
    // Promoted to the top layer (jsdom popover stub flips display on show).
    expect(toast).toHaveAttribute('popover', 'manual');
  });

  it('renders a warning toast with role="status"', () => {
    const api = renderToasts();
    act(() => {
      api.showToast({ message: 'Heads up', variant: 'warning' });
    });
    expect(screen.getByRole('status')).toHaveTextContent('Heads up');
  });

  it('gives the close button a declarative popovertargetaction="hide"', () => {
    const api = renderToasts();
    let id = '';
    act(() => {
      id = api.showToast({ message: 'Closeable' });
    });
    const closeButton = screen.getByRole('button', { name: /dismiss notification/i });
    // The invoker targets its own containing popover and hides it.
    expect(closeButton).toHaveAttribute('popovertarget', id);
    expect(closeButton).toHaveAttribute('popovertargetaction', 'hide');
    expect(toastElement('Closeable')).toHaveAttribute('id', id);
  });

  it('auto-dismisses after the duration elapses', () => {
    vi.useFakeTimers();
    const api = renderToasts();
    act(() => {
      api.showToast({ message: 'Transient', durationMs: 3000 });
    });
    expect(screen.getByText('Transient')).toBeInTheDocument();

    // Just before the deadline it's still up; after it, gone.
    act(() => vi.advanceTimersByTime(2999));
    expect(screen.getByText('Transient')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByText('Transient')).not.toBeInTheDocument();
  });

  it('keeps a persistent toast (durationMs: null) until dismissed', () => {
    vi.useFakeTimers();
    const api = renderToasts();
    act(() => {
      api.showToast({ message: 'Sticky', durationMs: null });
    });
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText('Sticky')).toBeInTheDocument();
  });

  it('removes a toast and fires onDismiss when dismissed programmatically', () => {
    const onDismiss = vi.fn();
    const api = renderToasts();
    let id = '';
    act(() => {
      id = api.showToast({ message: 'Bye', durationMs: null, onDismiss });
    });
    act(() => api.dismissToast(id));

    expect(screen.queryByText('Bye')).not.toBeInTheDocument();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('removes a toast and fires onDismiss when the popover is hidden (close button / Esc)', () => {
    const onDismiss = vi.fn();
    const api = renderToasts();
    act(() => {
      api.showToast({ message: 'ClickClose', durationMs: null, onDismiss });
    });
    // Drive hidePopover directly — what the native close button does in a real
    // browser (jsdom doesn't process popover invokers).
    act(() => toastElement('ClickClose').hidePopover());

    expect(screen.queryByText('ClickClose')).not.toBeInTheDocument();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('fires onDismiss exactly once when auto-dismiss and a programmatic dismiss race', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const api = renderToasts();
    let id = '';
    act(() => {
      id = api.showToast({ message: 'Racy', durationMs: 3000, onDismiss });
    });
    act(() => api.dismissToast(id));
    act(() => vi.advanceTimersByTime(5000));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('stacks multiple toasts, newest at the corner (offset 0)', () => {
    const api = renderToasts();
    act(() => {
      api.showToast({ message: 'First' });
    });
    act(() => {
      api.showToast({ message: 'Second' });
    });

    const first = toastElement('First');
    const second = toastElement('Second');
    expect(first).toBeInTheDocument();
    expect(second).toBeInTheDocument();
    // The newest (last raised) sits at the anchor; the older is pushed up.
    // Heights are 0 in jsdom, so the older offset collapses to just the gap.
    expect(second.style.getPropertyValue('--toast-offset')).toBe('0px');
    expect(first.style.getPropertyValue('--toast-offset')).toBe('12px');
  });
});
