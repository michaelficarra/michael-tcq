# Contributing to TCQ

## Prerequisites

- **Node.js** v20 or later
- **npm** v10 or later
- A **GitHub account** (optional — only needed for real OAuth; mock auth works without it)

## Local Development Setup

### 1. Clone and install

```sh
git clone <repository-url>
cd <repository-name>
npm install
```

### 2. Start the development servers

```sh
npm run dev
```

This starts both the Express API server (port 3000) and the Vite dev server (port 5173) concurrently. Open [http://localhost:5173](http://localhost:5173) in your browser.

The Vite dev server proxies `/api`, `/auth`, and `/socket.io` requests to the Express server, so you should always access the app through port 5173 during development.

**Authentication:** By default, the server runs in mock auth mode — the authentication button automatically logs you into an administator account so you can develop and test without configuring GitHub OAuth. Click the user in the top right to change the mocked user. To test with real GitHub authentication, see the section below.

### 3. (Optional) Configure GitHub OAuth

To use real GitHub authentication instead of mock auth:

1. Go to [GitHub Developer Settings](https://github.com/settings/developers).
2. Click **New OAuth App**.
3. Fill in:
   - **Application name:** `TCQ (Development)`
   - **Homepage URL:** `http://localhost:5173`
   - **Authorization callback URL:** `http://localhost:3000/auth/github/callback`
4. Click **Register application**.
5. Note the **Client ID** displayed on the app's page.
6. Click **Generate a new client secret** and note it immediately (it is shown only once).
7. Add the credentials to `.env.development`:
   ```
   GITHUB_CLIENT_ID=your_client_id
   GITHUB_CLIENT_SECRET=your_client_secret
   ```

When `GITHUB_CLIENT_ID` is set, the server uses real GitHub OAuth. When it's not set, mock auth is used automatically.

## Project Structure

```
packages/
  shared/   — TypeScript types and constants shared between client and server
  server/   — Express + Socket.IO backend
  client/   — React + Vite frontend
e2e/        — Playwright end-to-end tests
```

## Available Scripts

### Root workspace

| Command                | Description                                            |
| ---------------------- | ------------------------------------------------------ |
| `npm run dev`          | Start both servers in development mode with hot reload |
| `npm run build`        | Build all packages for production                      |
| `npm run typecheck`    | Type-check all packages                                |
| `npm run lint`         | Lint server and client                                 |
| `npm run format`       | Auto-fix formatting with Prettier                      |
| `npm run format:check` | Check formatting without making changes                |
| `npm test`             | Run all unit and integration tests                     |
| `npm run test:e2e`     | Run Playwright end-to-end tests                        |
| `npm run ci`           | Run all CI checks locally                              |

### Per-workspace scripts

Lint, typecheck, and test commands can be scoped to a single workspace:

```sh
npm run typecheck -w packages/shared
npm run lint -w packages/client
npm test -w packages/server
```

Watch mode is available per-workspace:

```sh
npm run test:watch -w packages/server
npm run test:watch -w packages/client
```

## Unit and Integration Tests

Tests use [Vitest](https://vitest.dev/).

Run server and client tests together:

```sh
npm test
```

### Server Tests

**Server tests** (`packages/server/`) run in a Node environment.

```sh
npm test -w packages/server
```

Watch mode (re-runs on file changes)

```sh
npm run test:watch -w packages/server
```

### Client Tests

**Client tests** (`packages/client/`) run in a jsdom environment using [React Testing Library](https://testing-library.com/docs/react-testing-library/intro/).

```sh
npm test -w packages/client
```

Watch mode (re-runs on file changes)

```sh
npm run test:watch -w packages/client
```

### End-to-End Tests

E2E tests use [Playwright](https://playwright.dev/) and live in the `e2e/` directory. They each align directly with a claim from [`docs/PRD.md`](PRD.md).

#### Setup

Install the Playwright browsers (first time only, or after upgrading `@playwright/test`):

```sh
npx playwright install --with-deps
```

#### Running

```sh
npm run test:e2e
```

This automatically builds the shared package, starts the server and client on test ports (3001 and 5174), runs all tests, and tears everything down afterwards. A fresh temporary data directory is created for each run.

Tests run against **Chromium, Firefox, and WebKit** in parallel.

#### Useful flags

```sh
# Run tests in a single browser only
npm run test:e2e -- --project=chromium

# Run tests matching a pattern
npm run test:e2e -- --grep "Queue"

# Run tests in headed mode (opens a visible browser)
npm run test:e2e -- --headed

# Open the Playwright Inspector for step-by-step debugging
npm run test:e2e -- --debug
```

## Validating Changes

Run all CI checks locally before pushing:

```sh
npm run ci
```

This runs `format:check`, `typecheck`, `lint`, and `build` concurrently, then runs `test` and `test:e2e` concurrently once the first group succeeds.
