# Contributing to TCQ

## Prerequisites

- **Node.js** v20 or later
- **npm** v10 or later
- A **GitHub account** (optional — only needed for real OAuth; mock auth works without it)

## Local Development Setup

### 1. Clone and install

```sh
git clone <repository-url>
cd tcq
npm install
```

### 2. Start the development servers

```sh
npm run dev
```

This starts both the Express API server (port 3000) and the Vite dev server (port 5173) concurrently. Open [http://localhost:5173](http://localhost:5173) in your browser.

The Vite dev server proxies API, auth, and WebSocket requests to the Express server, so you should always access the app through port 5173 during development.

**Authentication:** By default, the server runs in mock auth mode — a fake user is automatically logged in on every request, so you can develop and test without configuring GitHub OAuth. To test with real GitHub authentication, see the section below.

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
7. Copy `.env.example` to `.env` and fill in:
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
```

## Available Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start both servers in development mode with hot reload |
| `npm run build` | Build all packages for production |
| `npm test` | Run all tests |
| `npm run typecheck` | Type-check all packages |

## Running Tests

```sh
# Run all tests
npm test

# Run tests for a specific package
npm test -w packages/server
npm test -w packages/client

# Run tests in watch mode
npm run test:watch -w packages/server
```

## Code Style

- TypeScript throughout (strict mode enabled).
- The frontend uses React with Tailwind CSS for styling.
