# Contributing to TCQ

## Prerequisites

- **Node.js** v20 or later
- **npm** v10 or later

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
