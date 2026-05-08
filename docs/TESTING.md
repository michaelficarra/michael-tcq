# Testing

TCQ runs three test suites under `npm run ci`. Each one sits at a different layer of the stack and catches a different class of bug. Choosing the right layer for a given test matters — the layers have different speed, different fidelity, and (importantly) different things they cannot reliably synthesise. A test written at the wrong layer either runs slower than it needs to, or never sees the bug it was meant to catch, or flakes for reasons unrelated to the application.

| Suite                   | Runner                                  | Location                                 |
| ----------------------- | --------------------------------------- | ---------------------------------------- |
| Server unit/integration | Vitest in Node                          | `packages/server/src/**/*.test.ts`       |
| Client component/unit   | Vitest in jsdom + React Testing Library | `packages/client/src/**/*.test.{ts,tsx}` |
| End-to-end browser      | Playwright (Chromium, Firefox, WebKit)  | `e2e/*.spec.ts`                          |

Running and debugging the suites is documented in [`CONTRIBUTING.md`](CONTRIBUTING.md). This document covers what belongs where and why.

## Server unit/integration

Tests in this suite import server modules directly. For tests that need wire coverage, the setup spins up a real `SocketIOServer` on a random port and connects a real `socket.io-client` — handler code runs end-to-end including framing and msgpack, but without an HTTP application or persistent storage (the data store is in-memory). This is the bulk of the test mass: socket handlers, the meeting model, parsers, logging middleware, error handling.

It is also where distributed-systems behaviour is tested. The in-process harness can drive faults nothing higher in the stack can synthesise reliably:

- A `clientSurrogate` mirrors the production hook's gap-detection and resync logic, with single-shot fault-injection hooks for dropping, delaying, reordering, or partitioning incoming deltas.
- An `emitInParallel(...thunks)` helper fires N socket emits in the same microtask tick, so the actual JS event-loop interleaving determines server-side ordering rather than a sequenced "A then B" simulation.

Most files live directly in `packages/server/src/`, one per source file under test. Self-tests for the test helpers themselves (`clientSurrogate.test.ts`, `concurrency.test.ts`) live alongside their helpers under `packages/server/src/test/`.

Real-world TC39 agenda fixtures live verbatim under `packages/server/src/test/fixtures/agendas/<year>-<month>.md` (kept byte-identical to upstream via `.prettierignore`); their parser snapshots sit next to them as `<year>-<month>.parsed.json` and are produced by the fixture-based block in `parseAgenda.test.ts`. Update by re-running `curl ... -o ...` for the fixture and `vitest -u` for the snapshot — review the diff manually before committing, since the parser's re-serialisation can produce CommonMark-canonical escape forms that look different but render identically.

The shared markdown subsystem (validator, lenient stripper, plain-text extractor) is exercised by `packages/server/src/markdown.test.ts` — the shared package itself has no test runner, so its unit tests live in the server workspace where vitest is already configured.

## Client component/unit

Tests in this suite render React trees in jsdom via React Testing Library. They cover components, hooks, contexts, formatting helpers, and keyboard-shortcut wiring — everything user-facing on the client side that isn't a page-level interaction.

Two things are worth calling out because they aren't visible from the file layout:

- **Component tests use `TestMeetingProvider`** rather than mounting a real socket. They render with a fixed `MeetingState` fixture and assert on what's drawn. That's the right shape for almost every UI test — components don't need a network to be tested.
- **The production socket hook has its own tests.** `useSocketConnection.test.tsx` drives the hook against a small `mockSocket` (an EventEmitter-backed Socket.IO stand-in) so React-specific behaviour the surrogate cannot simulate is verified directly: synchronous cursor reseed in the same JS turn as the bootstrap `state` event, listener cleanup on unmount, `userGhid`-driven socket rebuild, window `offline`/`online` integration. The surrogate and the production hook are separate implementations of the same algorithm — bug-for-bug parity is not enforced anywhere except by these tests.

## End-to-end browser

Playwright spins up a fresh server (port 3001) and Vite client (port 5174) against a temporary data directory and drives Chromium, Firefox, and WebKit at the live URL. Each spec aligns with a claim from `PRD.md`; the project convention (see `CLAUDE.md`) is that any PRD-affecting change comes with an e2e spec.

This is the only suite that exercises real cross-client propagation. `multi-context.spec.ts` opens a second `BrowserContext` and verifies broadcast convergence (one context mutates, the other observes), the connection-count badge, mock-user identity propagation, and the disconnected indicator.

Two distributed scenarios are intentionally **not** tested here, and are documented inline in the spec:

- **Simultaneous-action races.** By the time the second context's click handler runs, the broadcast from the first click can already have arrived and updated its local state, so the second emit goes out with the new precondition rather than the stale one the test is trying to construct. The server's precondition guard is exercised directly in the server suite via `emitInParallel`, where both emits provably leave before either side can see the other.
- **Offline-then-catch-up.** Playwright's `setOffline` doesn't reliably terminate existing WebSockets across all three browsers, so broadcasts can still leak through "while offline" and the assertion that the offline context misses them fails for reasons unrelated to the application. The reconnect-and-reseed codepath is exercised in the server suite.

E2E tests are slow (running across three browsers) and brittle by their nature. They are for what only the full stack can demonstrate, not for behaviour the lower layers already pin down.

## Where does a distributed-systems test belong?

When something looks like a distributed concern — ordering, drops, delays, concurrency, reconnection — the answer is usually _not_ e2e. The suites split as follows:

| Concern                                                                               | Layer       | Why                                                                                                                                            |
| ------------------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-frame ordering — out-of-order, dropped, or delayed deltas; partitioned delivery   | Server unit | Only the in-process surrogate can synthesise individual wire frames precisely.                                                                 |
| Concurrent client-to-server emits — race on `queue:next`, storm of `queue:add`        | Server unit | `emitInParallel` produces real interleaving; e2e clicks can't, because broadcast feedback within a single click handler invalidates the setup. |
| The production hook's React behaviour — cursor sync, listener cleanup, socket rebuild | Client unit | jsdom + `mockSocket` lets you drive the hook directly; the surrogate is a separate implementation and doesn't simulate React.                  |
| Real cross-context propagation through the full stack                                 | E2E         | Only the full stack can prove that what one browser does is observable in another.                                                             |

## Load testing

Out of the default `npm test` path: a Node-based load harness lives under `scripts/load-test/`. It spawns N virtual Socket.IO participants against a locally running dev server, ramps up in stages, and reports the per-stage breaking point (latency, RSS, persistence dirty backlog, client error rate). Realistic-plenary and adversarial-stress scenarios are both included. Run it before each plenary or after any change to the broadcast/persistence path. See `scripts/load-test/README.md` for the prerequisites (the server must be started with `ADMIN_USERNAMES=load-admin` so the harness can poll diagnostics) and the CLI flags.

---

`packages/shared` has no test suite of its own. Its types and constants are exercised transitively whenever the server or client suites run.

## Notable test files

- `packages/server/src/githubDirectory.test.ts` — tier ordering, ACL (only orgs the searcher belongs to surface), dedup (by ghid and login), tier-3 top-up against `/search/users`, case-insensitive matching against login/name/company, and 401 token-revocation handling. Uses `setFetchForTesting` to install a deterministic stand-in for the module's outbound `fetch` without touching globals.
- `packages/client/src/components/UserCombobox.test.tsx` — the suggestion combobox: 250 ms debounce, free-text fallback (typing a name with no suggestion still commits on Enter), comma-as-commit in the chip variant, dedup against existing tokens, Backspace-to-remove.
- `e2e/autocomplete.spec.ts` — Playwright spec exercising the agenda-form presenters dropdown end-to-end against the mock-auth seed list.
