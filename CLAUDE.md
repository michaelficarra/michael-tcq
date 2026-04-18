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

## Important Files

Keep these up to date alongside code changes:

- **`README.md`** — notable new features.
- **`docs/PRD.md`** — any user-facing functionality change, described in enough detail to reproduce. Do not be overly prescriptive about incidental things like styling, size, or positioning.
- **`docs/ARCHITECTURE.md`** — architectural changes.
- **`docs/CONTRIBUTING.md`** — development process changes.
- **`docs/DEPLOYMENT.md`** — deployment process changes. The recommended and manual paths must stay in sync: any new provisioning step (API, IAM binding, resource) needs to appear in both the manual walkthrough and the bootstrap logic in `scripts/deploy.sh`.
- **`scripts/deploy.sh`** — must mirror the manual steps in `docs/DEPLOYMENT.md`. Keep the bootstrap phases idempotent so re-runs after a partial failure just resume.
- **`.github/workflows/ci.yml`** — development process changes.
- **`CLAUDE.md`** - development process changes or project structure changes.

## Testing

Every feature should come with tests. Features that impact the PRD should also have end-to-end Playwright tests in `e2e/`.
