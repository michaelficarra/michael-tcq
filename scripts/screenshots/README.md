# README Screenshot Scripts

Playwright-driven scripts that regenerate every image referenced from the project [`README.md`](../../README.md) "Screenshots" section. Each script seeds a fresh meeting via the same REST + Socket.IO protocol as [`scripts/seed-meeting.mjs`](../seed-meeting.mjs), drives the browser to the relevant page or modal, and writes the resulting PNG to [`docs/screenshots/`](../../docs/screenshots/).

## Running

Regenerate every screenshot in one go (spawns an isolated server + client on ports 3002 / 5175):

```sh
npm run screenshots
```

…or call the master script directly:

```sh
node scripts/regenerate-screenshots.mjs
```

Useful flags:

| Flag                   | Effect                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--use-running-server` | Skip the spawn. Assumes a dev server is already on `localhost:3000` / `5173` (`npm run dev`). **For iteration only.** The dev-mode data store is persistent, so prior meetings will appear in the "My Meetings" panel on `home-page.png`. Commit-ready runs must omit this flag so the harness uses its own fresh-data store.                                                                                             |
| `--filter=<substring>` | Only run scripts whose filename contains the substring. E.g. `--filter=poll` for `create-poll.mjs` and `active-poll.mjs`.                                                                                                                                                                                                                                                                                                 |
| `--skip-compress`      | Skip the post-step `oxipng` lossless compression pass. Useful for fast iteration; commit-ready runs should leave it enabled.                                                                                                                                                                                                                                                                                              |
| `--dry-run`            | Run each script's seeding + rendering paths but skip writing the PNG and skip `oxipng`. Used by the `screenshots-dry-run` CI job to catch protocol drift without producing committable artefacts. Implemented via `TCQ_SCREENSHOTS_DRY_RUN=1` passed through to child processes; scenarios that take their own screenshots gate the `page.screenshot` call on the `dryRun` flag from `runScreenshot`'s scenario callback. |

Run a single screenshot standalone against `npm run dev`:

```sh
# In one terminal:
npm run dev

# In another:
node scripts/screenshots/queue-chair.mjs
```

Standalone runs use the defaults `localhost:3000` / `5173`, matching `scripts/seed-meeting.mjs`. The master script overrides these via `TCQ_SERVER_URL` / `TCQ_CLIENT_URL` when invoking children.

## When to regenerate

`CLAUDE.md` instructs agents to regenerate the screenshots whenever a task involves a significant UI change. The rule of thumb: if you changed something a maintainer would see while skimming the README, regenerate. Tiny text-only tweaks that don't affect layout are exempt.

## Port allocation

| Pair        | Used by                                       |
| ----------- | --------------------------------------------- |
| 3000 / 5173 | Local development (`npm run dev`)             |
| 3001 / 5174 | Playwright e2e tests (`playwright.config.ts`) |
| 3002 / 5175 | This screenshot harness                       |

Do not reuse 3002 / 5175 elsewhere or the master script's isolated server will collide with whatever else is running.

## File layout

```
scripts/
  regenerate-screenshots.mjs          # master orchestrator
  screenshots/
    README.md                         # this file
    seed.mjs                          # REST + Socket helpers (no Playwright)
    lib.mjs                           # Playwright runner + clip helpers
    <name>.mjs                        # one per screenshot
```

Output: `docs/screenshots/<name>.png`.

## How to add a new screenshot

1. Add a new entry to the README's `## Screenshots` section pointing to `docs/screenshots/<name>.png` with a one-sentence caption.
2. Create `scripts/screenshots/<name>.mjs` modelled after an existing script. The standard shape is:

```js
#!/usr/bin/env node
// Top-of-file comment explaining what the shot demonstrates and why
// the chosen height makes sense.
import { getUrls, runScreenshot } from './lib.mjs';
import { populate } from './seed.mjs';

const { serverUrl, clientUrl } = getUrls();

const { meetingId, chairSocket } = await populate(serverUrl, {
  chairs: ['bakkot' /* …other TC39 usernames… */],
  agenda: [/* … */],
  // start, queue, sessions, runPoll, advance*, etc.
});

try {
  await runScreenshot('<name>', { viewport: { width: 800, height: NNN } }, async ({ page, switchUser }) => {
    // Switch off the default `admin` mock user — admin has special
    // admin powers and the name "Admin", which shouldn't appear in
    // README screenshots. Pick a realistic TC39 user appropriate for
    // the screenshot's perspective (chair vs participant).
    await page.goto(`${clientUrl}/`);
    await switchUser('bakkot');
    await page.goto(`${clientUrl}/meeting/${encodeURIComponent(meetingId)}#queue`);
    // …drive the UI to the state you want to capture…
  });
} finally {
  await chairSocket.close();
}
```

For modal captures, set `scenarioTakesShot: true`, compute the dialog's clip rect via `clipFor(panel)` (the modal's inner panel, not the backdrop), and call `page.screenshot({ path: outPath, clip })` yourself — gated on `!dryRun`. See `create-poll.mjs` for an example.

3. Pick the height to fit the interesting content snugly. Standard widths: **800px** (every screenshot in the README). Heights typically land in the 700–1100px range. Don't use `fullPage`; we want polished, scrollable-page-aware crops.

4. Run `npm run screenshots --filter=<name>` to verify your new shot looks right, then re-run the full set for the final commit.

## Module API

### `seed.mjs` (no Playwright)

- `assertServerRunning(serverUrl)` — bail out early if `/api/health` doesn't respond.
- `switchUserCookie(serverUrl, username)` — `POST /api/dev/switch-user`, returns a joined cookie header.
- `createMeeting(serverUrl, { chairs })` — `POST /api/meetings`, returns the meeting id.
- `openMeetingSocket(serverUrl, meetingId, username)` — opens a Socket.IO connection, joins the meeting, and returns helpers (`emit`, `emitAndWait`, `emitWithAckAndWait`, `waitFor`, `getState`, `close`). Auto-applies every delta to a locally-maintained `MeetingState` so passive observation stays consistent.
- `addQueueEntryAs(serverUrl, meetingId, chairSocket, username, payload)` — adds a queue entry attributed to `username` via a throwaway socket; the chair socket's `queue:added` watcher keeps its local state in sync.
- `reactToPollAs(serverUrl, meetingId, chairSocket, username, optionId)` — same pattern, for `poll:react`.
- `populate(serverUrl, spec)` — high-level meeting builder. Accepts chairs, agenda, sessions, prologue/epilogue, queue entries, advancement counts, and an optional poll. Returns `{ meetingId, chairSocket }`.

### `lib.mjs` (Playwright)

- `getUrls()` — reads `TCQ_SERVER_URL` / `TCQ_CLIENT_URL`, falling back to the dev-server defaults.
- `switchUser(page, username)` — drives the dev user-switcher UI to change the mock-auth identity. Same as `e2e/helpers.ts`'s `switchUser`.
- `runScreenshot(name, options, scenario)` — launches Chromium, applies the viewport, runs the scenario, takes the screenshot. Options: `viewport`, `theme` (`'dark'` writes the localStorage key before the first navigation), `scenarioTakesShot`, `clip`.
- `clipFor(locator, padding)` — returns a clip rectangle covering the locator's bounding box plus `padding` on each side.

## Keep in sync

Like [`scripts/seed-meeting.mjs`](../seed-meeting.mjs), these scripts depend directly on the REST + Socket.IO protocol. Whenever you change:

- meeting REST endpoints (`/api/meetings`, `/api/dev/switch-user`, `/api/my-meetings`),
- Socket.IO event names or payload shapes in [`packages/shared/src/messages.ts`](../../packages/shared/src/messages.ts), or
- the typed delta stream / `applyDelta` reducer in the shared package,

update `scripts/screenshots/seed.mjs` (especially its `DELTA_EVENTS` list and the emit shapes inside `populate`) alongside the code change. The same advice that's already in `CLAUDE.md`'s "Important Files" entry for `seed-meeting.mjs` applies here verbatim.
