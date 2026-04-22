# TCQ — Architecture Design Document

This document describes the technical architecture for TCQ, a real-time meeting discussion queue application. All decisions are guided by the constraints that the application will serve at most ~50 concurrent users, should be easy to run locally for development, and should use common, well-understood technologies.

## Overview

TCQ is a monolithic Node.js application that serves a single-page React frontend and handles real-time communication via Socket.IO. Meeting state is held in memory on the server and periodically synchronised to Google Cloud Firestore for persistence across restarts. Firestore also stores user sessions.

```
┌─────────────────────────────────────────────────┐
│                    Client                        │
│  React SPA (served as static files by Express)   │
│                                                  │
│  ┌──────────────┐    ┌───────────────────────┐   │
│  │ HTTP (fetch)  │    │ Socket.IO Client      │   │
│  │ - OAuth flow  │    │ - Join meeting room   │   │
│  │ - Create mtg  │    │ - Send actions        │   │
│  │ - Get user    │    │ - Receive broadcasts  │   │
│  └──────┬───────┘    └──────────┬────────────┘   │
└─────────┼───────────────────────┼────────────────┘
          │                       │
          │       HTTPS / WSS     │
          │                       │
┌─────────┼───────────────────────┼────────────────┐
│         │        Server         │                 │
│  ┌──────▼───────┐    ┌──────────▼────────────┐   │
│  │ Express      │    │ Socket.IO Server      │   │
│  │ - REST routes│    │ - Room per meeting    │   │
│  │ - Sessions   │    │ - Auth via session    │   │
│  │ - Static     │    │ - Validate & mutate   │   │
│  │   files      │    │ - Broadcast state     │   │
│  └──────┬───────┘    └──────────┬────────────┘   │
│         │                       │                 │
│  ┌──────▼───────────────────────▼────────────┐   │
│  │           In-Memory Meeting State          │   │
│  │         Map<meetingId, MeetingState>        │   │
│  └──────────────────┬─────────────────────────┘   │
│                     │ periodic sync                │
│  ┌──────────────────▼─────────────────────────┐   │
│  │    Firestore (meeting state + sessions)     │   │
│  └────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────┘
```

## Repository Structure

A single repository using npm workspaces with three packages:

```
tcq/
├── package.json                 # Workspace root
├── Dockerfile
├── packages/
│   ├── shared/                  # Shared TypeScript types and constants
│   │   └── src/
│   │       ├── types.ts         # MeetingState, User, QueueEntry, PollOption, etc.
│   │       ├── messages.ts      # Socket.IO event type definitions
│   │       ├── constants.ts     # Queue entry types, default poll options
│   │       └── helpers.ts       # Shared utilities (userKey)
│   ├── client/                  # React + Vite frontend
│   │   └── src/
│   │       ├── App.tsx
│   │       ├── contexts/        # MeetingContext, AuthContext, SocketContext
│   │       ├── components/      # NavBar, AgendaPanel, QueuePanel, HelpPanel, etc.
│   │       ├── hooks/           # useSocketConnection, useAdvanceAction
│   │       └── pages/           # HomePage, MeetingPage, LoginPage
│   └── server/                  # Express + Socket.IO backend
│       └── src/
│           ├── index.ts         # Server entry point, store selection
│           ├── auth.ts          # GitHub OAuth routes
│           ├── meetings.ts      # MeetingManager class and mutations
│           ├── socket.ts        # Socket.IO event handlers
│           ├── meetingId.ts     # Word-based ID generation (human-id)
│           ├── store.ts         # MeetingStore interface
│           ├── fileStore.ts     # File-backed store (local dev)
│           ├── firestoreStore.ts # Firestore-backed store (production)
│           ├── mockAuth.ts      # Mock auth for development
│           └── requireAuth.ts   # Auth middleware for API routes
├── scripts/
│   ├── seed-meeting.sh          # Populate a meeting with sample data
│   └── deploy.sh               # Build, push, and deploy to Cloud Run
└── docs/                        # PRD, Architecture, Contributing, Deployment
```

**Why a monorepo?** The primary motivation is the `shared` package. The type definitions for meeting state, queue entries, and Socket.IO event payloads must be identical on client and server. With npm workspaces, both sides import from `@tcq/shared` and get compile-time type checking across the boundary.

**Why npm workspaces over alternatives?** npm workspaces is built into npm — no additional tooling is required. Turborepo, Nx, and Lerna add complexity that is not justified for a three-package repository. A root-level `npm run dev` script can use `concurrently` to start both the Vite dev server and the Express server.

## Frontend

### Framework: React with Vite

React is the most widely known frontend framework, which maximises the pool of potential contributors. The ecosystem for the specific things TCQ needs — drag-and-drop reordering (for agenda items and queue entries), accessible form components, and WebSocket integration patterns — is most mature in React.

Vite provides fast dev server startup, hot module replacement, and a straightforward production build.

**Alternatives considered:**

- **Vue** — A solid choice with a good reactivity model, but a smaller contributor pool. No meaningful advantage for this use case over React.
- **Svelte** — Excellent developer experience and small bundles, but the ecosystem for drag-and-drop libraries is thinner. Bundle size is irrelevant at 50 users.
- **SolidJS** — Best raw performance, but the smallest ecosystem and community. Would raise the contribution barrier without providing any practical benefit at this scale.

### Styling: Tailwind CSS

The application has a simple visual design: text, badges, buttons, and lists. Tailwind CSS avoids the need for a component library while keeping styles co-located and easy to iterate on. It adds no runtime overhead.

**Alternatives considered:**

- **Component libraries (MUI, Chakra, Mantine)** — Bring opinionated visual design and large bundle sizes. The app's UI is simple enough that these would add more friction than value.
- **CSS Modules / vanilla CSS** — Viable, but Tailwind's utility classes are faster to work with for a small team and produce more consistent output.

### State Management: React Context + useReducer

The server is the single source of truth for meeting state. The client receives the full state on connection and state patches on updates. A single `MeetingContext` with a reducer that applies server messages is sufficient.

No external state library (Redux, Zustand, Jotai) is needed. The state shape is small and well-defined, and there is only one source of state updates (the server).

`MeetingState` is grouped into domain subobjects: `queue` (entries, ordering, closed flag), `current` (agenda item, speaker, topic, topic-group accumulator), `poll` (present when a poll is running), and `operational` (advancement attribution and last-connection timestamp) — alongside the durable top-level fields `users`, `chairIds`, `agenda`, and `log`. The current speaker is a first-class struct on `current.speaker` rather than a reference into the queue entries map.

The `agenda` field is an ordered list of `AgendaEntry`s — a discriminated union of `AgendaItem` (regular items) and `Session` (session headers that group items by capacity). Items and sessions share the same UUID id-space and the same reorder protocol (`agenda:reorder`). Session containment — which items are rendered inside which session, and the used/remaining/overflow values — is a pure display concern derived on the client from the agenda order and item durations; it is not stored in the meeting state. Agenda items persist unchanged from before the session feature: they have no `kind` discriminator, so existing stored meetings deserialise as `AgendaEntry[]` without migration. `AgendaItem.duration` is dual-purpose: for items ahead of the current one it holds the chair's estimate; when the chair advances past an item, the server overwrites it with the realised elapsed time rounded up to the nearest minute, and the client labels the value accordingly ("Estimate" vs "Duration").

## Backend

### Framework: Express

Express is the most widely known Node.js server framework. For an application with a handful of REST endpoints (OAuth callback, meeting creation, user info) plus WebSocket connections serving 50 users, Express is perfectly adequate. Its middleware ecosystem is extensive and every session/auth library supports it.

**Alternatives considered:**

- **Fastify** — Genuinely better TypeScript support and faster, but the performance difference is irrelevant at 50 users. Some ecosystem libraries (session stores, OAuth helpers) have more mature Express integrations.
- **Hono** — Designed for edge/serverless runtimes. TCQ requires a long-lived server process for WebSocket connections and in-memory state, which is not Hono's sweet spot.
- **NestJS** — A full enterprise framework with decorators, dependency injection, and modules. Massively over-engineered for an application with ~5 REST routes and a Socket.IO handler.

### REST Endpoints

The server exposes a small number of REST endpoints:

| Route                   | Method | Purpose                                                      |
| ----------------------- | ------ | ------------------------------------------------------------ |
| `/auth/github`          | GET    | Redirect to GitHub OAuth                                     |
| `/auth/github/callback` | GET    | Handle OAuth callback, create session                        |
| `/auth/logout`          | GET    | Destroy session                                              |
| `/api/health`           | GET    | Health check                                                 |
| `/api/me`               | GET    | Return current authenticated user (includes `mockAuth` flag) |
| `/api/meetings`         | POST   | Create a new meeting                                         |
| `/api/meetings/:id`     | GET    | Get a meeting's current state                                |
| `/api/dev/switch-user`  | POST   | Switch mock auth identity (dev mode only)                    |

All other interaction happens over Socket.IO. The server also serves the Vite-built client assets in production and has a catch-all for client-side routing.

## Real-Time Communication: Socket.IO

Socket.IO is the right transport for TCQ because it directly maps to the application's needs:

- **Rooms** — Each meeting is a Socket.IO room. When a client joins a meeting, they join the room. When state changes, the server broadcasts to the room. This is a single line of code.
- **Bidirectional communication** — Clients send actions (add to queue, reorder agenda) and the server sends state updates. Both directions use the same connection.
- **Automatic reconnection** — If a participant's connection drops (laptop sleep, network hiccup, or Cloud Run's 60-minute request timeout), Socket.IO reconnects and the client re-syncs state. This is critical for a meeting tool and is what makes Cloud Run's WebSocket timeout a non-issue.
- **Fallback transports** — Socket.IO falls back to long-polling if WebSocket connections are blocked by corporate proxies or firewalls, which is relevant for a standards committee tool where participants may be on restricted networks.
- **Typed events** — Socket.IO supports TypeScript event type definitions on both client and server, using the shared types from `@tcq/shared`.

### Message Architecture

The server is the single source of truth. The flow for every state change is:

1. Client emits an **action** via Socket.IO (e.g. `queue:add` with a payload).
2. Server **validates** the action — the payload is parsed against a shared Zod schema (defined in `@tcq/shared`) for shape / trim / length / enum checks, then authority checks (is the user authenticated? are they in this meeting? do they have permission?) run in the handler.
3. Server **mutates** its in-memory `MeetingState`.
4. Server **broadcasts** the updated state (or a targeted delta) to all clients in the meeting room.
5. Clients **apply** the broadcast to their local state via the reducer.

Clients do not perform optimistic updates — they wait for the server broadcast. At 50 users on a typical network, the round-trip latency is imperceptible, and this eliminates all conflict resolution complexity.

**Alternatives considered:**

- **Native WebSockets (`ws` library)** — Would require reimplementing rooms, reconnection, heartbeats, and message serialisation. Socket.IO provides all of this out of the box. The bundle size overhead (~45KB gzipped) is irrelevant at this scale.
- **Server-Sent Events (SSE)** — Unidirectional (server to client only). TCQ needs bidirectional communication. Using SSE for server-to-client plus REST endpoints for client-to-server is more complex than a single Socket.IO connection and loses the elegance of a unified transport.
- **PartyKit** — An interesting model where each meeting would be a "party", but it is a hosted platform that adds vendor lock-in. For a self-hostable tool, a standard Socket.IO server is more portable.

## Data Storage

### Meeting State: In-Memory with Firestore Sync

The primary copy of meeting state lives in memory on the server as a `Map<string, MeetingState>`. All reads and mutations happen against this in-memory map for minimal latency. In-memory state is periodically synchronised to Google Cloud Firestore so that active meetings can be recovered after a redeployment or container restart.

**Sync strategy:**

- **Periodic writes** — Each meeting's state is written to Firestore on a regular interval (e.g. every 30 seconds) if it has changed since the last sync. A simple dirty flag on the `MeetingState` tracks this.
- **Write on significant events** — In addition to the periodic sync, state is written immediately after high-value mutations (advancing the agenda item, advancing the speaker) to minimise data loss for important transitions.
- **Recovery on startup** — When the server starts, it reads all meeting documents from Firestore and restores them into the in-memory map. Clients that reconnect (via Socket.IO's automatic reconnection) receive the recovered state.
- **Cleanup** — When a meeting is deleted from memory (after all clients have disconnected and the cleanup timer expires), its Firestore document is also deleted.

**Why Firestore?** Firestore is a managed, serverless document database on GCP with an Always Free tier of 50,000 reads, 20,000 writes, and 20,000 deletes per day, plus 1 GiB of storage. Meeting state is a natural fit for a document model — each meeting is a single JSON document. At ~50 users and a handful of active meetings, the free tier is more than sufficient. There is no infrastructure to manage and no connection pooling to configure.

**For local development**, Firestore is replaced by a filesystem-backed implementation that writes meeting state as JSON files to disk. See the [Local Development](#local-development) section for details on the persistence adapter interface.

When the last client disconnects from a meeting, a cleanup timer starts (e.g. 5 minutes). If no one reconnects, the meeting is deleted from both memory and the persistent store.

**Alternatives considered:**

- **Pure in-memory (no persistence)** — Simpler, but all meeting state is lost on redeployment. For a meeting tool where a deploy during an active meeting would force everyone to start over, this is a poor experience.
- **PostgreSQL** — Requires running a database server, which adds docker-compose complexity or a managed database dependency. Overkill for storing a handful of JSON documents.
- **Redis** — Requires an external process. GCP Memorystore (managed Redis) does not have a free tier.
- **SQLite** — Works well locally but Cloud Run's filesystem is ephemeral, so SQLite data would be lost on container replacement — defeating the purpose of persistence.
- **GCP Cloud Storage** — Could store meeting state as JSON blobs. Simpler than Firestore but has higher latency for frequent small writes and no document-level operations. Firestore is a better fit for structured data that changes frequently.

### Sessions: Firestore

User sessions are also stored in Firestore, using a Firestore-backed session store for `express-session`. This keeps the persistence layer unified (one backing store rather than two) and means sessions survive container restarts, so users do not need to re-authenticate after a redeployment.

For local development, sessions use the default in-memory session store (express-session's `MemoryStore`). This means sessions are lost on server restart, which is acceptable for development.

### Socket.IO Session Sharing

The Express session middleware is shared with Socket.IO, so WebSocket connections are authenticated using the same session cookie. On connection, the server reads the session to identify the user and determine their role (chair or participant) in the meeting they are joining.

## Authentication: Direct GitHub OAuth

GitHub OAuth is a simple three-step flow: redirect to GitHub, receive a code on callback, exchange the code for an access token, fetch the user profile. This is straightforward to implement directly in ~40 lines of code.

The flow:

1. `GET /auth/github` — Redirect to `https://github.com/login/oauth/authorize` with client ID and requested scopes.
2. `GET /auth/github/callback` — Receive the authorisation code, exchange it for an access token, fetch the user profile from the GitHub API, store user info in the session, redirect to the application.
3. `GET /auth/logout` — Destroy the session.
4. `GET /api/me` — Return the current user from the session (used by the frontend on page load to check auth status).

**Alternatives considered:**

- **Passport.js** — Adds `passport`, `passport-github2`, and a serialise/deserialise abstraction. For a single OAuth provider, the abstraction cost exceeds the benefit. If TCQ ever needed multiple OAuth providers, Passport would start making sense.
- **Auth.js (NextAuth)** — Tightly coupled to Next.js. The standalone `@auth/core` exists but is less mature and less well-documented.

## Meeting ID Generation

Meeting IDs are generated using the `human-id` library, which produces three lowercase words joined by hyphens (e.g. `bright-pine-lake`, `calm-wave-fox`). With over 15 million combinations, collisions are vanishingly unlikely. If a collision does occur with an active meeting, a new ID is generated.

## Deployment

### Target: Google Cloud Run

Cloud Run is a container-based platform on GCP with an Always Free tier that includes 180,000 vCPU-seconds, 360,000 GiB-seconds, and 2 million requests per month (in eligible regions: us-central1, us-east1, us-west1). It supports WebSockets and scales to zero when idle, meaning no cost is incurred outside of active meetings.

Cloud Run treats WebSocket connections as long-running HTTP requests. While a connection is open, the container instance remains active and consumes CPU/memory quota. For TCQ's usage pattern — a handful of meetings per month, each lasting a few hours with ~50 participants — this fits comfortably within the free tier. A rough estimate: a 4-hour meeting consumes ~14,400 vCPU-seconds, well under the 180,000 monthly allowance.

**WebSocket timeout:** Cloud Run enforces a maximum request timeout of 60 minutes (default 5 minutes, configurable). WebSocket connections are dropped when this timeout is reached. This is not a problem for TCQ because Socket.IO handles automatic reconnection transparently — when a connection is dropped at the timeout boundary, the client reconnects and the server re-sends the current meeting state. The timeout should be configured to the maximum 3,600 seconds to minimise unnecessary reconnections.

**Session affinity:** Cloud Run provides best-effort session affinity, which helps route reconnecting clients back to the same instance. Since TCQ is sized for a single instance, this is not a concern in practice.

**Deployment:** `gcloud run deploy` from a Dockerfile, or via the Cloud Console. The container image can be built and stored in GCP's Artifact Registry (also has a free tier).

**Alternatives considered:**

- **Fly.io** — Previously had a generous free tier, but removed free allowances for new users in 2024. New accounts now receive only a short trial. No longer a viable free-tier option.
- **Railway** — Has a free tier with a limited monthly credit ($5 as of writing). Could work, but the credit can be consumed quickly by a long-running process and there is less headroom than Cloud Run's Always Free allowances.
- **Render** — The free tier spins down instances after 15 minutes of inactivity, which destroys all in-memory meeting state. This is problematic for a meeting tool where there may be quiet periods during a long meeting. Render's paid tier would work but is not free.
- **Vercel** — Serverless functions with no persistent WebSocket support. Fundamentally the wrong deployment model for this application.
- **Cloudflare Workers** — Durable Objects could theoretically model each meeting, but the programming model is very different from standard Node.js and would add significant complexity.
- **GCP Compute Engine** — The Always Free tier includes one e2-micro instance, which would work as a traditional VM. However, it requires manual server administration (OS updates, process management, SSL termination) that Cloud Run handles automatically. More operational burden for no benefit at this scale.
- **GCP App Engine** — The standard environment has a free tier with 28 instance-hours/day and supports WebSockets in the Node.js runtime. A viable alternative to Cloud Run, but Cloud Run is the more modern GCP product and offers more flexibility (any container, no vendor-specific configuration files).

### Deployment Configuration

A single Dockerfile that:

1. Builds the shared types package.
2. Builds the frontend (Vite production build).
3. Builds the server (TypeScript compilation).
4. Runs the Express server, which serves the frontend as static files and handles WebSocket connections.

One process, one container. The Express server serves the Vite-built static assets in production, so there is no need for a separate web server or CDN.

### Local Development

Local development requires only Node.js and npm. No Docker, no cloud services, no external databases.

**Setup:**

1. `npm install` at the repository root (installs all workspace dependencies).
2. `npm run dev` starts the application in development mode.

GitHub OAuth is optional for local development — when `GITHUB_CLIENT_ID` is not set, the server runs in mock auth mode with a fake user and a dev user-switcher in the navigation bar. See [CONTRIBUTING.md](CONTRIBUTING.md) for details on optionally configuring OAuth.

**How local differs from production:**

| Concern               | Local Development                                                                                         | Production (Cloud Run)                                                     |
| --------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **Frontend**          | Vite dev server with HMR on a separate port; proxies API/WebSocket requests to the Express server         | Pre-built static files served directly by Express                          |
| **Server**            | Runs via `tsx --watch` (or similar) for automatic restart on file changes                                 | Compiled JavaScript, run directly with `node`                              |
| **Persistence**       | Meeting state and sessions written to JSON files on the local filesystem (the `file` persistence adapter) | Firestore (the `firestore` persistence adapter)                            |
| **OAuth**             | A separate GitHub OAuth App configured with `http://localhost:<port>` as the callback URL                 | A GitHub OAuth App configured with the production URL                      |
| **HTTPS**             | Not used; plain HTTP on localhost                                                                         | Terminated by Cloud Run's load balancer                                    |
| **WebSocket timeout** | None; connections persist indefinitely                                                                    | Cloud Run enforces a 60-minute maximum; Socket.IO reconnects transparently |

**Persistence adapter:** The persistence layer is behind a simple interface:

```typescript
interface MeetingStore {
  save(meeting: MeetingState): Promise<void>;
  load(meetingId: string): Promise<MeetingState | null>;
  loadAll(): Promise<MeetingState[]>;
  remove(meetingId: string): Promise<void>;
}
```

Two implementations are provided:

- **`FileMeetingStore`** — Writes each meeting as a JSON file in a local directory (e.g. `.data/meetings/`). Used in development. Simple, inspectable, no dependencies.
- **`FirestoreMeetingStore`** — Reads and writes meeting documents in a Firestore collection. Used in production.

The active implementation is selected by the `STORE` environment variable (`file` or `firestore`), defaulting to `file` when not set.
