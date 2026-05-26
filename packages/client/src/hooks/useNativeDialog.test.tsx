import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { useNativeDialog, type UseNativeDialogOptions } from './useNativeDialog.js';

/**
 * Renders an always-mounted <dialog> driven by the hook, mirroring how real
 * modals use it. Relies on the jsdom showModal/close stub in src/test/setup.ts
 * (jsdom implements neither natively).
 */
function Harness({ open, onClose, options }: { open: boolean; onClose: () => void; options?: UseNativeDialogOptions }) {
  const { dialogRef, renderContents } = useNativeDialog(open, onClose, options);
  return (
    <dialog ref={dialogRef} aria-label="Test">
      {renderContents && <p>contents</p>}
    </dialog>
  );
}

describe('useNativeDialog', () => {
  it('opens and closes the dialog in step with the `open` prop', () => {
    const onClose = vi.fn();
    const { rerender } = render(<Harness open={false} onClose={onClose} />);

    // Closed: display:none → excluded from the a11y tree, contents not rendered.
    expect(screen.queryByRole('dialog', { name: 'Test' })).not.toBeInTheDocument();
    expect(screen.queryByText('contents')).not.toBeInTheDocument();

    act(() => rerender(<Harness open onClose={onClose} />));
    expect(screen.getByRole('dialog', { name: 'Test' })).toBeInTheDocument();
    expect(screen.getByText('contents')).toBeInTheDocument();
  });

  it('keeps contents mounted while animating closed (content-gating)', () => {
    const onClose = vi.fn();
    const { rerender } = render(<Harness open onClose={onClose} />);
    expect(screen.getByText('contents')).toBeInTheDocument();

    // On close the dialog hides immediately, but contents stay mounted through
    // the exit transition (no `transitionend`/timeout has fired yet).
    act(() => rerender(<Harness open={false} onClose={onClose} />));
    expect(screen.queryByRole('dialog', { name: 'Test' })).not.toBeInTheDocument();
    expect(screen.getByText('contents')).toBeInTheDocument();
  });

  it('bridges a platform `close` event back to onClose', () => {
    const onClose = vi.fn();
    render(<Harness open onClose={onClose} />);
    const dialog = screen.getByRole('dialog', { name: 'Test' });

    act(() => {
      dialog.dispatchEvent(new Event('close'));
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('enables declarative light dismiss with closedby="any" for dismissable dialogs', () => {
    render(<Harness open onClose={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: 'Test' })).toHaveAttribute('closedby', 'any');
  });

  it('blocks Esc close requests when not dismissable', () => {
    const onClose = vi.fn();
    render(<Harness open onClose={onClose} options={{ dismissable: false }} />);
    const dialog = screen.getByRole('dialog', { name: 'Test' });

    // A non-dismissable dialog declares closedby="none" and prevents the
    // Escape keydown's default action (the cross-browser close-request block).
    expect(dialog).toHaveAttribute('closedby', 'none');
    const esc = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true });
    act(() => {
      dialog.dispatchEvent(esc);
    });
    expect(esc.defaultPrevented).toBe(true);
  });
});
