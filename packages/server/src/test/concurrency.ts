/**
 * Test-only helpers for driving multiple socket emits in parallel.
 *
 * The existing precondition-guard tests in `socket.test.ts` simulate
 * concurrent chairs by sequencing operations server-side (chair A
 * succeeds, then chair B emits with a now-stale precondition). That
 * verifies the *logical* guard, but it doesn't exercise the actual
 * interleaving the JS event loop produces when two clients fire
 * emits at the same instant. `emitInParallel` does the latter: it
 * fires N thunks via `Promise.all`, so the server processes them in
 * whatever order its async machinery picks, and resolves with all
 * results.
 */

/**
 * Fire an arbitrary number of async operations in parallel and resolve
 * with their results in the same order. Each thunk is invoked at the
 * same microtask tick, before any of them have a chance to await — so
 * the server sees N emits arrive concurrently from its perspective.
 *
 * Use this for tests of precondition guards, optimistic concurrency
 * checks, and any other behaviour that depends on real interleaving
 * rather than serialised "A then B" calls.
 */
export async function emitInParallel<T extends readonly (() => Promise<unknown>)[]>(
  ...thunks: T
): Promise<{ -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
  return (await Promise.all(thunks.map((t) => t()))) as {
    -readonly [K in keyof T]: Awaited<ReturnType<T[K]>>;
  };
}
