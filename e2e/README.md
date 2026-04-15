# End-to-End Tests

These are Playwright-based end-to-end conformance tests. They verify that the application behaves as described in [`docs/PRD.md`](../docs/PRD.md) — the PRD is the sole source of truth for what is tested here.

## Running

Start the dev server (if not already running), then run tests:

```sh
npm run test:e2e
```

Or start the dev server separately and run tests against it:

```sh
npm run dev          # in one terminal
```

```sh
npm run test:e2e     # in another
```

## Structure

Each test file corresponds to a section of the PRD:

| File                                | PRD sections                                                                 |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| `auth-and-home.spec.ts`             | Authentication, Home Page                                                    |
| `meetings-and-navigation.spec.ts`   | Meetings, Meeting Flow, Navigation                                           |
| `agenda.spec.ts`                    | Agenda (including Chair Management)                                          |
| `queue.spec.ts`                     | Queue, Current Speaker and Topic, Timers                                     |
| `polls.spec.ts`                     | Polls                                                                        |
| `log.spec.ts`                       | Log                                                                          |
| `keyboard-shortcuts-and-ui.spec.ts` | Keyboard Shortcuts, Error Handling, Real-Time Updates, User Identity Display |

`helpers.ts` contains shared utilities (creating meetings, adding agenda items, etc.).

## Browsers

Tests run against Chromium, Firefox, and WebKit (Safari). Tests run in parallel with a concurrency limit derived from the number of CPU cores.
