/**
 * Self-tests for the mock socket harness — they pin down the contract
 * the production hook tests rely on (synchronous deliver, recorded
 * emits, listener count tracking, disconnect bookkeeping).
 */

import { describe, expect, it, vi } from 'vitest';
import { createMockSocket } from './mockSocket.js';

describe('mockSocket', () => {
  it('delivers events synchronously to listeners attached via `on`', () => {
    const harness = createMockSocket();
    const listener = vi.fn();
    harness.socket.on('hello', listener);

    harness.deliver('hello', { x: 1 });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ x: 1 });
  });

  it('records outbound emits in arrival order', () => {
    const harness = createMockSocket();

    harness.socket.emit('a', 1);
    harness.socket.emit('b', 2, 3);

    expect([...harness.emitted]).toEqual([
      { event: 'a', args: [1] },
      { event: 'b', args: [2, 3] },
    ]);
  });

  it('off removes a listener so subsequent delivers do not fire it', () => {
    const harness = createMockSocket();
    const listener = vi.fn();
    harness.socket.on('hello', listener);
    harness.socket.off('hello', listener);

    harness.deliver('hello');

    expect(listener).not.toHaveBeenCalled();
  });

  it('disconnect sets the flag and fires the disconnect event', () => {
    const harness = createMockSocket();
    const listener = vi.fn();
    harness.socket.on('disconnect', listener);

    expect(harness.disconnected).toBe(false);
    harness.socket.disconnect();

    expect(harness.disconnected).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('listenerCount reflects attached listeners for unmount assertions', () => {
    const harness = createMockSocket();
    const listenerA = vi.fn();
    const listenerB = vi.fn();

    harness.socket.on('foo', listenerA);
    harness.socket.on('foo', listenerB);
    expect(harness.listenerCount('foo')).toBe(2);

    harness.socket.off('foo', listenerA);
    expect(harness.listenerCount('foo')).toBe(1);
  });
});
