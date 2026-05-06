/**
 * Test-only mock for a Socket.IO client. Mirrors the surface area
 * `useSocketConnection` actually uses (`on`, `off`, `emit`,
 * `disconnect`, plus the lifecycle events `connect` / `disconnect`)
 * via a Node EventEmitter, so tests can drive inbound events into the
 * hook synchronously and assert on outbound emits.
 *
 * The harness is intentionally minimal — it does NOT model Socket.IO's
 * acknowledgements, transports, reconnection backoff, or namespace
 * behaviour. Anything beyond "deliver an event, see what the hook
 * does" belongs in the in-process surrogate tests in the server
 * package, where a real Socket.IO server is available.
 */

import type { TypedSocket } from '../contexts/SocketContext.js';

/**
 * Minimal event emitter — just the surface area the harness needs.
 * Inlined to avoid pulling in `@types/node` solely for the `events`
 * module: the client otherwise has no Node-only dependencies and we
 * don't want to add a typings package just for a test helper.
 */
type Listener = (...args: unknown[]) => void;
class TinyEmitter {
  private listeners = new Map<string, Listener[]>();
  on(event: string, listener: Listener) {
    const list = this.listeners.get(event);
    if (list) list.push(listener);
    else this.listeners.set(event, [listener]);
  }
  off(event: string, listener: Listener) {
    const list = this.listeners.get(event);
    if (!list) return;
    const i = list.indexOf(listener);
    if (i !== -1) list.splice(i, 1);
  }
  emit(event: string, ...args: unknown[]) {
    // Snapshot the list before iterating: a listener that calls `off`
    // (or attaches more) during dispatch shouldn't reorder or re-fire
    // for this dispatch. Matches Node EventEmitter semantics.
    const list = this.listeners.get(event);
    if (!list) return;
    for (const listener of [...list]) listener(...args);
  }
  listenerCount(event: string) {
    return this.listeners.get(event)?.length ?? 0;
  }
}

export interface MockSocketHarness {
  /** Cast as TypedSocket for use in the hook. */
  socket: TypedSocket;

  /**
   * Log of every outbound emit the hook produced, in order. Each
   * entry's `args` is the raw argument tuple passed to `socket.emit`.
   */
  readonly emitted: ReadonlyArray<{ event: string; args: unknown[] }>;

  /** Whether `socket.disconnect()` has been called. */
  readonly disconnected: boolean;

  /** Number of currently-attached listeners — useful for unmount tests. */
  listenerCount(event: string): number;

  /**
   * Push an inbound event into the hook (as if it arrived on the wire).
   * Listeners run synchronously, so multiple `deliver` calls in the
   * same JS turn observe each other's effects.
   */
  deliver(event: string, ...args: unknown[]): void;

  /** Convenience for the `connect` lifecycle event. */
  simulateConnect(): void;

  /** Convenience for the `disconnect` lifecycle event. */
  simulateDisconnect(): void;
}

export function createMockSocket(): MockSocketHarness {
  const ee = new TinyEmitter();
  const emitted: { event: string; args: unknown[] }[] = [];
  let disconnected = false;

  const fakeSocket = {
    on(event: string, listener: (...args: unknown[]) => void) {
      ee.on(event, listener);
      return fakeSocket;
    },
    off(event: string, listener: (...args: unknown[]) => void) {
      ee.off(event, listener);
      return fakeSocket;
    },
    emit(event: string, ...args: unknown[]) {
      emitted.push({ event, args });
      return fakeSocket;
    },
    disconnect() {
      disconnected = true;
      // Fire `disconnect` so listeners that rely on it (e.g. the hook's
      // `setConnected: false` dispatch) execute, matching real
      // Socket.IO's behaviour where `disconnect()` triggers the event.
      ee.emit('disconnect');
      return fakeSocket;
    },
    // Some Socket.IO consumers read these. Provide stubs so a stray
    // access doesn't crash the test even though the hook itself
    // doesn't use them.
    connected: true,
    id: 'mock-socket',
    io: { engine: {} },
  };

  const harness: MockSocketHarness = {
    socket: fakeSocket as unknown as TypedSocket,
    emitted,
    get disconnected() {
      return disconnected;
    },
    listenerCount(event) {
      return ee.listenerCount(event);
    },
    deliver(event, ...args) {
      ee.emit(event, ...args);
    },
    simulateConnect() {
      ee.emit('connect');
    },
    simulateDisconnect() {
      ee.emit('disconnect');
    },
  };

  return harness;
}
