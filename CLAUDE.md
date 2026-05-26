# TCQ

A real-time queueing tool for agenda-driven meetings with a large number of participants. Monorepo with three workspaces: `packages/shared`, `packages/server`, `packages/client`.

## Getting started

Read `docs/PRD.md` to understand the product requirements and expected behaviour.

## Commands

| Task                   | Command                |
| ---------------------- | ---------------------- |
| Dev server (both)      | `npm run dev`          |
| Build all              | `npm run build`        |
| Type-check all         | `npm run typecheck`    |
| Lint all               | `npm run lint`         |
| Format (write)         | `npm run format`       |
| Format (check)         | `npm run format:check` |
| Unit/integration tests | `npm test`             |
| E2E tests (Playwright) | `npm run test:e2e`     |
| Regenerate screenshots | `npm run screenshots`  |
| Full CI check locally  | `npm run ci`           |

Lint and typecheck are per-workspace. To run them individually:

```
npm run typecheck -w packages/shared
npm run lint -w packages/client
npm test -w packages/server
```

## Validation

After making changes, verify by running (in this order):

1. `npm run typecheck`
2. `npm run format` (writes fixes — check for diffs)
3. `npm run lint`
4. `npm test`

Do **not** run e2e tests routinely — only when changing or adding e2e specs.

## Screenshots

The README's "Screenshots" section embeds images from `docs/screenshots/`. Whenever a task involves a **significant UI change** — visual tweaks to the home page, queue, agenda, log, help tab, polls, dark mode, keyboard-shortcuts dialog, sessions list, or any other surface shown in the README — regenerate the relevant screenshots and commit the updated PNGs alongside the code change:

```
npm run screenshots
```

The master script spawns its own isolated server on ports 3002 / 5175 (so it doesn't collide with `npm run dev` or the e2e suite), runs every per-screenshot Playwright script in `scripts/screenshots/`, and finishes with a lossless `oxipng` pass. Use `--filter=<name>` to regenerate just the affected shots when iterating; do a full run before committing.

CI runs `npm run screenshots -- --dry-run` (the `screenshots-dry-run` job in `.github/workflows/ci.yml`) on every push, so the harness catches REST / Socket protocol drift even when nobody has run the regen manually. If that job fails, fix `scripts/screenshots/seed.mjs` alongside whatever protocol change broke it.

Trivial changes — backend-only work, dev tooling, refactors that don't touch rendered output, doc edits, or text tweaks that don't shift layout — do **not** require a screenshot refresh.

See [`scripts/screenshots/README.md`](scripts/screenshots/README.md) for how the scripts are structured and how to add a new one.

## Important Files

Keep these up to date alongside code changes:

- **`README.md`** — notable new features.
- **`docs/PRD.md`** — any user-facing functionality change, described in enough detail to reproduce. Do not be overly prescriptive about incidental things like styling, size, or positioning.
- **`docs/ARCHITECTURE.md`** — architectural changes.
- **`docs/CONTRIBUTING.md`** — development process changes.
- **`docs/TESTING.md`** — when adding/removing a test suite or changing a runner, environment, or test-file location.
- **`docs/DEPLOYMENT.md`** — deployment process changes. The recommended and manual paths must stay in sync: any new provisioning step (API, IAM binding, resource) needs to appear in both the manual walkthrough and the bootstrap logic in `scripts/deploy.sh`.
- **`scripts/deploy.sh`** — must mirror the manual steps in `docs/DEPLOYMENT.md`. Keep the bootstrap phases idempotent so re-runs after a partial failure just resume.
- **`scripts/seed-meeting.mjs`** — seeds a meeting with sample TC39 members, agenda items, sessions, and queue entries for development/demo. Keep in sync with changes to meeting REST endpoints (`/api/meetings`, `/api/dev/switch-user`), Socket.IO event names/payloads (`agenda:add`, `session:add`, `agenda:reorder`, `meeting:nextAgendaItem`, `queue:add`), and the broadcast protocol — both the initial `state` snapshot and the typed delta events the script applies via `@tcq/shared`'s `applyDelta`.
- **`svgo.config.mjs`** — SVGO config for the build-time SVG optimiser. Consumed by an inline Vite plugin in `packages/client/vite.config.ts` that optimises every SVG in the build output at `closeBundle`. Source SVGs are left as-is — only build artefacts get optimised, so there's nothing to remember when adding a new asset.
- **`scripts/regenerate-screenshots.mjs`** and **`scripts/screenshots/`** — master orchestrator plus per-screenshot Playwright scripts that regenerate every image in the README's "Screenshots" section. Keep `scripts/screenshots/seed.mjs` (especially its `DELTA_EVENTS` list and the emit shapes inside `populate`) in sync with changes to meeting REST endpoints (`/api/meetings`, `/api/dev/switch-user`, `/api/my-meetings`), Socket.IO event names/payloads in `packages/shared/src/messages.ts`, and the typed delta stream / `applyDelta` reducer. The master script uses ports 3002 / 5175 — reserved for screenshots; don't reuse them.
- **`scripts/load-test/`** — Node-based load harness (virtual Socket.IO clients, plenary + stress scenarios, per-stage breaking-point report). Multi-process: `run.mjs` is the parent (chair + diagnostics), `worker.mjs` hosts ~100 participants per process. Each scenario file exports `startChairBehavior` and `startParticipantBehavior` separately. Keep `virtualClient.mjs`'s `DELTA_EVENTS` list and the scenario emit shapes in sync with changes to `ServerToClientEvents` / `ClientToServerEvents` in `packages/shared/src/messages.ts`. The harness depends on the `/api/dev/switch-user` mock-auth endpoint and the `/api/admin/diagnostics` shape — touch either and update `serverProbe.mjs` accordingly.
- **`.github/workflows/ci.yml`** — development process changes.
- **`CLAUDE.md`** - development process changes or project structure changes.

## Testing

Every feature should come with tests. Features that impact the PRD should also have end-to-end Playwright tests in `e2e/`. See [`docs/TESTING.md`](docs/TESTING.md) for a breakdown of the suites — what each covers, why it exists, and which files belong to it.
