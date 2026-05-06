# Test Suites

TCQ has **three** distinct test suites, each with a different runner, environment, and purpose. All three run as part of `npm run ci`. The `packages/shared` workspace has no suite of its own — its types and constants are exercised transitively through the server and client suites.

| Suite                   | Runner                                 | File pattern                             |
| ----------------------- | -------------------------------------- | ---------------------------------------- |
| Server unit/integration | Vitest (Node)                          | `packages/server/src/*.test.ts`          |
| Client component/unit   | Vitest (jsdom + React Testing Library) | `packages/client/src/**/*.test.{ts,tsx}` |
| End-to-end browser      | Playwright                             | `e2e/*.spec.ts`                          |

For instructions on running, scoping, and debugging these suites, see [`CONTRIBUTING.md`](CONTRIBUTING.md). This document covers what each suite is for and why it exists.

## Server unit/integration tests

**How it works.** Vitest in a plain Node environment, configured at [`packages/server/vitest.config.ts`](../packages/server/vitest.config.ts). Each test imports server modules directly and exercises them in-process — there is no real HTTP server, no real Socket.IO transport, and no real filesystem-backed store. Two shared in-process fakes live in `packages/server/src/test/`:

- `inMemoryStore.ts` — an in-memory implementation of the data store, so anything that touches persistence runs without disk I/O.
- `clientSurrogate.ts` — a Socket.IO client stand-in that lets socket handlers be driven without a real network round-trip.

**Why this suite earns its keep.** It is the fastest, most deterministic place to cover backend logic at the module boundary: auth, REST routes, Socket.IO handlers, the meeting model, the agenda/session-doc parsers, log/counter middleware, and error handling. The same coverage at the e2e layer would be orders of magnitude slower, and the client suite cannot see any of it.

**Files.** Every server test lives directly in `packages/server/src/` and matches the glob `packages/server/src/*.test.ts`.

## Client component/unit tests

**How it works.** Vitest in a `jsdom` environment with [React Testing Library](https://testing-library.com/docs/react-testing-library/intro/), configured at [`packages/client/vitest.config.ts`](../packages/client/vitest.config.ts). Tests render React trees into a simulated DOM and assert on what the user would see and do. Setup and shared fixtures live in `packages/client/src/test/`:

- `setup.ts` — wires up jsdom and `@testing-library/jest-dom` matchers.
- `makeMeeting.ts` — fixture factory for `Meeting` objects.
- `TestMeetingProvider.tsx` — wrapper that supplies `MeetingContext` to components under test.

**Why this suite earns its keep.** It exercises components, hooks, contexts, and pure client utilities in isolation — no real browser, no real network, no real meeting state. That makes it the right place to lock down rendering logic, reducer/context behaviour, keyboard shortcut wiring, and formatting helpers, none of which the server suite can see and none of which would be cheap to cover only through Playwright.

**Files.** Client tests are spread across `src/`, `src/pages/`, `src/components/`, `src/contexts/`, `src/hooks/`, and `src/lib/`, and together match the glob `packages/client/src/**/*.test.{ts,tsx}`.

## End-to-end browser tests

**How it works.** Playwright at the repo root, configured at [`playwright.config.ts`](../playwright.config.ts). The runner spins up a fresh server (port 3001) and Vite client (port 5174) backed by a temporary data directory, then drives **Chromium, Firefox, and WebKit** against `http://localhost:5174`. Shared page actions (creating a meeting, switching mock users, navigating tabs) live in [`e2e/helpers.ts`](../e2e/helpers.ts).

**Why this suite earns its keep.** It is the only suite that exercises the full stack — real browser ↔ real Vite client ↔ real server ↔ real Socket.IO transport — so it is the only place that catches integration bugs spanning the client/server boundary, real-time socket flow, and cross-browser quirks. Each spec aligns with a claim in [`PRD.md`](PRD.md); the project convention (see [`CLAUDE.md`](../CLAUDE.md)) is that any change touching the PRD should come with an e2e spec.

**Files.** Every Playwright spec lives directly in `e2e/` and matches the glob `e2e/*.spec.ts`. (`e2e/helpers.ts` is shared support code, not a spec, so the `.spec.ts` suffix excludes it.)

## A note on `packages/shared`

`packages/shared` defines no `*.test.*` files and has no `test` script in its `package.json`. Its types and constants are imported by both the server and the client, so anything that depends on them is exercised transitively whenever the other two suites run.
