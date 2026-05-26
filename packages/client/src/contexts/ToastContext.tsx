/* eslint-disable react-refresh/only-export-components */
/**
 * App-wide toast notifications.
 *
 * A single place to surface transient, in-app messages — server-reported
 * errors, failed actions, edit conflicts — instead of the ad-hoc banners and
 * inline `role="alert"` snippets each surface used to roll on its own. Every
 * toast renders as a `popover="manual"` element in the top layer (see
 * {@link ToastRegion}), so they stack above everything without z-index wars.
 *
 * The provider owns the queue; {@link useToast} hands callers `showToast` /
 * `dismissToast`. It sits high in the tree (above the router) so both the home
 * page and the meeting page — including the socket layer inside MeetingProvider
 * — can raise toasts.
 */

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { ToastRegion } from '../components/ToastRegion.js';

export type ToastVariant = 'error' | 'warning';

export interface Toast {
  id: string;
  message: string;
  variant: ToastVariant;
  /** Auto-dismiss delay in ms, or `null` to stay until closed/dismissed. */
  durationMs: number | null;
}

export interface ShowToastOptions {
  message: string;
  /** Defaults to `'error'`. */
  variant?: ToastVariant;
  /** Auto-dismiss delay in ms; `null` to persist. Defaults to {@link DEFAULT_DURATION_MS}. */
  durationMs?: number | null;
  /**
   * Called exactly once when the toast leaves the queue — whether the user
   * closed it, the auto-dismiss timer fired, or a caller invoked
   * `dismissToast`. Used by controlled callers (e.g. the agenda edit-conflict
   * toast) to keep their own state in sync with a manual close.
   */
  onDismiss?: () => void;
}

interface ToastApi {
  /** Enqueue a toast; returns its id so it can be dismissed programmatically. */
  showToast: (opts: ShowToastOptions) => string;
  /** Remove a toast by id (no-op if already gone). */
  dismissToast: (id: string) => void;
}

/** Default auto-dismiss for transient messages (errors, failed actions). */
const DEFAULT_DURATION_MS = 6000;

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idRef = useRef(0);
  // onDismiss callbacks live outside React state so we can fire them exactly
  // once on removal without threading them through render. Presence in the map
  // also doubles as the "is this toast still live?" check that makes
  // dismissal idempotent — the native close button, the auto-dismiss timer,
  // and a programmatic dismissToast can all race to remove the same toast.
  const onDismissRef = useRef<Map<string, (() => void) | undefined>>(new Map());

  const showToast = useCallback((opts: ShowToastOptions): string => {
    const id = `toast-${idRef.current++}`;
    const toast: Toast = {
      id,
      message: opts.message,
      variant: opts.variant ?? 'error',
      durationMs: opts.durationMs === undefined ? DEFAULT_DURATION_MS : opts.durationMs,
    };
    onDismissRef.current.set(id, opts.onDismiss);
    setToasts((prev) => [...prev, toast]);
    return id;
  }, []);

  const dismissToast = useCallback((id: string): void => {
    // Already removed — bail so onDismiss never fires twice.
    if (!onDismissRef.current.has(id)) return;
    const onDismiss = onDismissRef.current.get(id);
    onDismissRef.current.delete(id);
    setToasts((prev) => prev.filter((t) => t.id !== id));
    onDismiss?.();
  }, []);

  return (
    <ToastContext value={{ showToast, dismissToast }}>
      {children}
      <ToastRegion toasts={toasts} onDismiss={dismissToast} />
    </ToastContext>
  );
}

/** Access the toast API. Throws if used outside a {@link ToastProvider}. */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within a ToastProvider');
  return ctx;
}
