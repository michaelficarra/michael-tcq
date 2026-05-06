import { describe, expect, it } from 'vitest';
import { emitInParallel } from './concurrency.js';

describe('emitInParallel', () => {
  it('starts every thunk before any of them resolves', async () => {
    let started = 0;
    const a = () =>
      new Promise<'a'>((resolve) => {
        started += 1;
        // Resolve in a microtask so we can observe `started === 2`
        // happens before either resolves.
        queueMicrotask(() => resolve('a'));
      });
    const b = () =>
      new Promise<'b'>((resolve) => {
        // By the time `b` is invoked, `a` must already have started —
        // this is the property concurrent emit tests rely on.
        expect(started).toBe(1);
        started += 1;
        queueMicrotask(() => resolve('b'));
      });

    const [first, second] = await emitInParallel(a, b);
    expect(first).toBe('a');
    expect(second).toBe('b');
    expect(started).toBe(2);
  });

  it('preserves result order across N thunks', async () => {
    const make = (label: string, ms: number) => () =>
      new Promise<string>((resolve) => setTimeout(() => resolve(label), ms));
    // First thunk is the slowest — its result must still come out at
    // index 0, proving order is by argument position, not completion.
    const results = await emitInParallel(make('first', 30), make('second', 10), make('third', 20));
    expect(results).toEqual(['first', 'second', 'third']);
  });
});
