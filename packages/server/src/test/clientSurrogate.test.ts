/**
 * Self-tests for the test-only `clientSurrogate` harness. These
 * verify the fault-injection hooks (delayNext / reorderNext /
 * partition) at the level of the surrogate's own bookkeeping —
 * `lastSeenVersion`, `events`, `resyncRequestCount`, and the
 * `state:resync` emits it produces. They deliberately use deltas with
 * versions that don't match `lastSeenVersion + 1`, so the surrogate
 * detects gaps and never reaches `applyDelta`. Full integration
 * coverage (where deltas actually mutate state) lives in
 * `socket.test.ts`; these tests pin down the harness mechanics on
 * their own.
 */

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createClientSurrogate, type ClientSurrogate } from './clientSurrogate.js';

/**
 * Build a fake socket and a controller for driving events into it.
 * The surrogate only uses `on` / `off` / `emit`, so an EventEmitter
 * is enough — no real server, no real wire.
 */
function makeFakeSocket() {
  const ee = new EventEmitter();
  const emitted: { event: string; args: unknown[] }[] = [];
  const fake = {
    on: (event: string, listener: (...args: unknown[]) => void) => {
      ee.on(event, listener);
      return fake;
    },
    off: (event: string, listener: (...args: unknown[]) => void) => {
      ee.off(event, listener);
      return fake;
    },
    emit: (event: string, ...args: unknown[]) => {
      emitted.push({ event, args });
      return true;
    },
  };
  return {
    // Cast through `unknown` — the surrogate only touches the three
    // methods above and doesn't inspect the rest of the Socket type.
    socket: fake as unknown as Parameters<typeof createClientSurrogate>[0],
    deliver(event: string, ...args: unknown[]) {
      ee.emit(event, ...args);
    },
    emitted,
  };
}

/** Seed the surrogate with a minimal `state` event at the given version. */
function seed(deliver: (event: string, ...args: unknown[]) => void, version: number) {
  // Only `operational.version` is read by the surrogate's own code; the
  // rest of MeetingState only matters when applyDelta runs (it doesn't,
  // in these tests, because every delta we send produces a gap).
  deliver('state', { operational: { version } });
}

/** Convenience: count events by name on a surrogate. */
function countEvents(surrogate: ClientSurrogate, predicate: (event: string) => boolean): number {
  return surrogate.events.filter((e) => predicate(e.event)).length;
}

describe('clientSurrogate fault injection', () => {
  describe('delayNext', () => {
    it('holds the next matching delta until the timer fires', async () => {
      const { socket, deliver, emitted } = makeFakeSocket();
      const surrogate = createClientSurrogate(socket);
      seed(deliver, 5);

      surrogate.delayNext('agenda:added', 30);
      // Version 7 with lastSeen=5 produces a gap (expected 6). The
      // delay holds the gap-detection itself, not just `applyDelta`.
      deliver('agenda:added', { version: 7 });

      // Synchronously after delivery: nothing has been processed yet.
      expect(surrogate.resyncRequestCount).toBe(0);
      expect(emitted.filter((e) => e.event === 'state:resync')).toHaveLength(0);

      // Wait for the surrogate to emit the next event entry, which the
      // timer will produce when it processes the held delta.
      await surrogate.waitForNextEvent();
      expect(surrogate.resyncRequestCount).toBe(1);
      expect(emitted.filter((e) => e.event === 'state:resync')).toHaveLength(1);

      surrogate.detach();
    });

    it('only delays a single delta, not the ones that follow', async () => {
      const { socket, deliver } = makeFakeSocket();
      const surrogate = createClientSurrogate(socket);
      seed(deliver, 5);

      surrogate.delayNext(true, 30);
      deliver('agenda:added', { version: 7 }); // delayed
      deliver('queue:added', { version: 8 }); // immediate

      // The second delta wasn't held — it produces a gap right away,
      // before the timer fires. This proves `delayNext` only takes
      // effect once per arming.
      expect(surrogate.resyncRequestCount).toBe(1);

      // Waiting for the next event lets the delayed delta finally land.
      // It also produces a gap (lastSeen stays at 5 because gap-detection
      // doesn't advance it), so we end with two gap events total.
      await surrogate.waitForNextEvent();
      expect(surrogate.resyncRequestCount).toBe(2);
      expect(countEvents(surrogate, (e) => e.endsWith('[gap]'))).toBe(2);

      surrogate.detach();
    });
  });

  describe('reorderNext', () => {
    it('buffers deltas and releases them in reverse arrival order by default', async () => {
      const { socket, deliver, emitted } = makeFakeSocket();
      const surrogate = createClientSurrogate(socket);
      seed(deliver, 5);

      surrogate.reorderNext(2);
      // Both produce gaps when processed (expected 6, got 7 and 8) so
      // applyDelta is never reached. Order of processing is observable
      // through the recorded `events` array.
      deliver('agenda:added', { version: 7 });
      deliver('queue:added', { version: 8 });

      const gapEvents = surrogate.events.filter((e) => e.event.endsWith('[gap]'));
      // Reverse arrival means queue:added (v8) is processed first, then
      // agenda:added (v7).
      expect(gapEvents.map((e) => e.event)).toEqual(['queue:added[gap]', 'agenda:added[gap]']);
      expect(gapEvents.map((e) => e.version)).toEqual([8, 7]);
      expect(emitted.filter((e) => e.event === 'state:resync')).toHaveLength(2);

      surrogate.detach();
    });

    it('respects a caller-supplied permutation', async () => {
      const { socket, deliver } = makeFakeSocket();
      const surrogate = createClientSurrogate(socket);
      seed(deliver, 5);

      // Three deltas, deliver as [middle, last, first] => indices [1, 2, 0].
      surrogate.reorderNext(3, [1, 2, 0]);
      deliver('agenda:added', { version: 7 });
      deliver('queue:added', { version: 8 });
      deliver('chairs:updated', { version: 9 });

      const gapEvents = surrogate.events.filter((e) => e.event.endsWith('[gap]'));
      expect(gapEvents.map((e) => e.version)).toEqual([8, 9, 7]);

      surrogate.detach();
    });

    it('rejects malformed permutations', () => {
      const { socket } = makeFakeSocket();
      const surrogate = createClientSurrogate(socket);
      expect(() => surrogate.reorderNext(0)).toThrow(/count/);
      expect(() => surrogate.reorderNext(2, [0])).toThrow(/length/);
      expect(() => surrogate.reorderNext(2, [0, 0])).toThrow(/exactly once/);
      expect(() => surrogate.reorderNext(2, [0, 2])).toThrow(/in \[0, count\)/);
      surrogate.detach();
    });
  });

  describe('partition', () => {
    it('buffers all incoming deltas for the duration, then flushes in arrival order', async () => {
      const { socket, deliver, emitted } = makeFakeSocket();
      const surrogate = createClientSurrogate(socket);
      seed(deliver, 5);

      surrogate.partition(30);
      deliver('agenda:added', { version: 7 });
      deliver('queue:added', { version: 8 });

      // Mid-partition: nothing has reached processDelta yet.
      expect(surrogate.resyncRequestCount).toBe(0);
      expect(countEvents(surrogate, (e) => e !== 'state')).toBe(0);
      expect(emitted.filter((e) => e.event === 'state:resync')).toHaveLength(0);

      // Wait for the partition timer to fire and flush the buffer.
      await new Promise((r) => setTimeout(r, 60));

      const gapEvents = surrogate.events.filter((e) => e.event.endsWith('[gap]'));
      // Arrival order is preserved on flush: agenda first, then queue.
      expect(gapEvents.map((e) => e.event)).toEqual(['agenda:added[gap]', 'queue:added[gap]']);
      expect(emitted.filter((e) => e.event === 'state:resync')).toHaveLength(2);

      surrogate.detach();
    });

    it('detach clears outstanding timers without firing', async () => {
      const { socket, deliver, emitted } = makeFakeSocket();
      const surrogate = createClientSurrogate(socket);
      seed(deliver, 5);

      surrogate.partition(50);
      deliver('agenda:added', { version: 7 });
      surrogate.detach();

      // Wait past the partition timer; nothing should have flushed.
      await new Promise((r) => setTimeout(r, 80));
      expect(emitted.filter((e) => e.event === 'state:resync')).toHaveLength(0);
    });
  });

  describe('dropNext (regression)', () => {
    it('still drops when armed, even with the new hooks present', async () => {
      const { socket, deliver, emitted } = makeFakeSocket();
      const surrogate = createClientSurrogate(socket, { dropNext: 'agenda:added' });
      seed(deliver, 5);

      deliver('agenda:added', { version: 6 }); // dropped
      deliver('queue:added', { version: 7 }); // gap

      expect(surrogate.events.some((e) => e.event === 'agenda:added[dropped]')).toBe(true);
      expect(emitted.filter((e) => e.event === 'state:resync')).toHaveLength(1);

      surrogate.detach();
    });
  });
});
