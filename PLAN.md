# TCQ — Implementation Plan

This plan is ordered so that the application is runnable and testable as early as possible. Each step builds on the previous one. Infrastructure setup steps are called out with detailed instructions where they occur.

## Step 0: Project Scaffolding ✅

Set up the monorepo structure, tooling, and dev scripts so that subsequent steps have a working foundation to build on.

- Initialise the repository with a root `package.json` configured for npm workspaces.
- Create the three workspace packages: `packages/shared`, `packages/server`, `packages/client`.
- **shared:** Configure TypeScript. No dependencies. Exports will be consumed by both client and server.
- **server:** Configure TypeScript. Install Express, Socket.IO, and `tsx` (for dev-mode execution). Set up `src/index.ts` with a minimal Express server that listens on a port (from `PORT` env var, defaulting to 3000) and returns "ok" on `GET /`.
- **client:** Scaffold a Vite + React + TypeScript project. Install Tailwind CSS and configure it. The default Vite welcome page is fine for now.
- Add root-level `npm run dev` script using `concurrently` to start both the Vite dev server and the Express server (via `tsx --watch`). Configure the Vite dev server to proxy `/api`, `/auth`, and `/socket.io` requests to the Express server.
- Add a `.env.example` file with placeholder values for `PORT`, `SESSION_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `GITHUB_CALLBACK_URL`.
- Add a root `.gitignore` covering `node_modules`, `dist`, `.env`, and `.data`.

**Checkpoint:** `npm install && npm run dev` starts both servers. Visiting the Vite dev server URL shows the React welcome page. Visiting `/api` through the proxy returns "ok" from Express.

## Step 1: Shared Types ✅

Completed as part of Step 0. The queue entry type `poo` was renamed to `point-of-order`.

- `types.ts` — `User`, `AgendaItem`, `QueueEntry` (with `type: 'topic' | 'reply' | 'question' | 'point-of-order'`), `Reaction`, `MeetingState`.
- `messages.ts` — `ClientToServerEvents` (`join`) and `ServerToClientEvents` (`state`).
- `constants.ts` — Queue entry type priority ordering, reaction type list.

## Step 2: Meeting Creation and Joining (Server) ✅

Built the server-side meeting lifecycle with mock auth. Meeting IDs use the `human-id` library (three lowercase hyphenated words, e.g. `plain-cobras-rule`).

- Implement `meetingId.ts` — uses the `human-id` library with lowercase words and `-` separator.
- Implement the `MeetingStore` interface and `FileMeetingStore` (writes JSON files to `.data/meetings/`).
- Implement in-memory meeting state management: a `Map<string, MeetingState>`, the `POST /api/meetings` endpoint (accepts `{ chairs: string[] }`, returns the created meeting with its ID), and the `GET /api/meetings/:id` endpoint (returns meeting state or 404).
- Add session middleware (`express-session` with a simple in-memory store for now — the file-backed session store is not needed until persistence is wired up).
- Add a temporary mock auth middleware that sets a hardcoded user on the session, bypassing GitHub OAuth. This allows all subsequent features to be developed and tested without configuring OAuth.

**Checkpoint:** `curl -X POST http://localhost:3000/api/meetings -H 'Content-Type: application/json' -d '{"chairs":["testuser"]}'` returns a meeting with a word-based ID. `curl http://localhost:3000/api/meetings/<id>` returns the meeting state.

## Step 3: Real-Time Connection (Socket.IO) ✅

Wired up Socket.IO with shared Express session middleware, room-based meeting join, full state broadcast, and client count tracking with delayed cleanup.

- Set up Socket.IO on the server, sharing the Express session middleware so sockets are authenticated.
- Implement the `join` event handler: client sends a meeting ID, server adds the socket to that meeting's room, and emits the full `MeetingState` back via a `state` event.
- Implement broadcasting: a helper function that, given a meeting ID, emits the current `MeetingState` to all sockets in that room.
- On disconnect, track connected clients per meeting. When the last client disconnects, start a cleanup timer. If no one reconnects within 5 minutes, remove the meeting from memory and the file store.

**Checkpoint:** Two browser tabs can connect to the same meeting via Socket.IO and both receive the meeting state. Server logs show join/disconnect events.

## Step 4: Meeting UI Shell (Client) ✅

Built the client-side meeting page with routing, Socket.IO connection, MeetingContext state management, and the Agenda/Queue tab layout. All read-only for now.

- Add client-side routing: a home/landing page at `/` and a meeting page at `/meeting/:id`.
- Implement `MeetingContext` with `useReducer`. The reducer accepts a `state` action (full state replacement from the server).
- Implement the `useSocket` hook: connects to the server with the meeting ID, emits `join`, listens for `state`, and dispatches to the context.
- Build the meeting page layout: top navigation bar with "TCQ" branding, Agenda/Queue tab toggle, and a placeholder Log Out link. Two tab views (Agenda and Queue) that switch based on the selected tab.
- **Queue tab:** Display the current agenda item section (showing "Waiting for the meeting to start..."), the current speaker section (showing "Nobody speaking yet..."), and an empty speaker queue section. All read-only for now.
- **Agenda tab:** Display the agenda as a numbered list (will be empty initially).

**Checkpoint:** Navigating to `/meeting/<id>` connects via Socket.IO, receives the meeting state, and renders the shell UI with both tabs. Multiple browser tabs show the same state.

## Step 5: Agenda Management ✅

Implemented the full agenda feature. The reorder event uses UUID-based targeting (`id` + `afterId`) rather than indices to avoid race conditions with concurrent chairs.

- **Shared:** Added `agenda:add`, `agenda:delete`, `agenda:reorder` events with typed payloads. Added `error` server-to-client event.
- **Server:** Agenda mutation methods on MeetingManager with chair-only validation. Socket handlers broadcast updated state after each mutation.
- **Client:** Interactive `AgendaPanel` with `AgendaForm`, drag-and-drop via `@dnd-kit`, delete buttons. Chair vs participant view logic via `useIsChair()`. `SocketContext` added for components to emit events.

## Step 6: Meeting Flow — Start Meeting and Agenda Advancement ✅

Implemented with a single `meeting:nextAgendaItem` event that handles both starting the meeting and advancing. The agenda item's owner becomes the current speaker with "Introducing: <item name>". Queue and current topic are cleared on advancement. Agenda advancement is persisted immediately via `syncOne`.

- **Client:** Start Meeting button (before meeting starts) and Next Agenda Item button (inline, after current item info). Both hidden for non-chairs. Next Agenda Item hidden on last item.

## Step 7: Home Page — Create and Join Meeting ✅

The home page now has two cards: Join Meeting (enter a meeting ID, validates it exists before navigating) and New Meeting (comma-separated chair usernames, creates via API and redirects). Works with mock auth.

**Deferred to Step 10 (GitHub OAuth):**
- Pre-populate the Chairs field with the current user's GitHub username.
- Server-side validation of chair usernames against the GitHub API when creating a meeting (resolve each username to a full User object with ghid, name, and organisation). Return an error if any username is invalid.

## Step 8: Speaker Queue — Core ✅

Implemented the full speaker queue: entering, displaying, removing, and advancing through speakers.

- **Shared:** Added `queue:add`, `queue:remove`, `queue:next` events. `queue:next` includes `currentTopicId` for stale-state prevention (avoids double-advancement from concurrent chair clicks).
- **Server:** Priority-ordered insertion (point-of-order > question > reply > topic, FIFO within type). Removal with owner/chair permission check. `nextSpeaker` pops from queue, sets currentTopic on topic-type entries.
- **Client:** Entry type buttons (New Topic, Discuss Current Topic, Clarifying Question, Point of Order — Reply hidden when no current topic). Inline form with Enter Queue / Cancel. Queue list with delete buttons (own entries + all for chairs). Next Speaker button for chairs.
- **Deferred to Step 9:** Move Up / Move Down buttons for chairs (queue reordering).

## Step 9: Queue Reordering ✅

Implemented chair-only queue reordering with UUID-based targeting (`{ id, afterId }`) to avoid index-based race conditions (same approach as agenda reordering). When an entry crosses a type boundary, its type changes to match its neighbour at the new position.

- **Client:** Move Up / Move Down buttons for chairs on each queue entry. Buttons resolve adjacent entry UUIDs before emitting. Hidden at list boundaries (no Move Up on first, no Move Down on last). Hidden for non-chairs.

## Step 10: GitHub OAuth ✅

Implemented GitHub OAuth with graceful fallback to mock auth when OAuth credentials are not configured.

- **Server:**
  - `auth.ts` — OAuth routes: `/auth/github` (redirect to GitHub), `/auth/github/callback` (code exchange, profile fetch, session creation), `/auth/logout` (session destruction).
  - `requireAuth.ts` — middleware that returns 401 for unauthenticated `/api/*` requests.
  - `session.ts` — shared session type augmentation (`user`, `returnTo`).
  - `fetchGitHubUser()` — resolves GitHub usernames to User objects (used for chair validation when creating meetings).
  - `routes.ts` — meeting creation now validates chair usernames against the GitHub API when OAuth is configured.
  - Mock auth remains as automatic fallback when `GITHUB_CLIENT_ID` is not set.
- **Client:**
  - `AuthContext` — fetches `/api/me` on mount, provides user + loading state to all components.
  - `LoginPage` — shown when not authenticated, with "Log in with GitHub" link.
  - `HomePage` — chairs field pre-populated with the current user's GitHub username.
  - `MeetingPage` — uses AuthContext instead of its own `/api/me` fetch.

**Infrastructure required for real OAuth (not needed for mock auth development):**

Register a GitHub OAuth App at https://github.com/settings/developers:
- **Application name:** TCQ (Development)
- **Homepage URL:** `http://localhost:5173`
- **Authorization callback URL:** `http://localhost:3000/auth/github/callback`

Set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` in `.env`.

## Step 11: Temperature Checks ✅

Implemented with fully customisable options. Chairs configure the response options (emoji + label) before starting a check, with the six standard options as defaults. Minimum 2 options required.

- **Shared:** `TemperatureOption` type (id, emoji, label). `Reaction` references `optionId` instead of a fixed type. `MeetingState` gains `temperatureOptions[]`. `temperature:start` accepts custom options. `DEFAULT_TEMPERATURE_OPTIONS` constant provides the six defaults.
- **Server:** `startTemperature` assigns UUIDs to each option. `toggleReaction` validates option IDs. `stopTemperature` clears options and reactions.
- **Client:**
  - `TemperatureSetup` — configuration form with add/remove option rows, emoji input (use OS emoji picker), label input. Minimum 2 options enforced. Defaults pre-populated.
  - `TemperatureCheck` — reaction panel with buttons for each custom option, count, highlight for own reactions, tooltip with names. "Copy Results" button for chairs (copies emoji + label + count, sorted by count descending).
  - Chair flow: Check Temperature → setup form → Start Temperature Check → reaction panel + Stop Temperature button.

## Step 12: Persistence — Periodic Firestore Sync ✅

Implemented `FirestoreMeetingStore` and Firestore session store. The `STORE` env var selects the implementation (`file` for local dev, `firestore` for production). The periodic sync and startup recovery were already implemented in earlier steps via `MeetingManager`.

- **`firestoreStore.ts`** — `FirestoreMeetingStore` using `@google-cloud/firestore`. Each meeting is a document in a `meetings` collection.
- **`index.ts`** — store selection via `STORE` env var. When `firestore`, uses `firestore-store` for sessions and `FirestoreMeetingStore` for meetings. Sets `trust proxy` and secure cookies for Cloud Run.
- **`firestore-store.d.ts`** — type declaration for the untyped `firestore-store` package.

**Infrastructure required (not yet set up):** See DEPLOYMENT.md for GCP project, Firestore database, and service account setup instructions.

## Step 13: Production Deployment ✅

Implemented Dockerfile and static asset serving. The Express server serves the Vite-built client in production.

- **`Dockerfile`** — Multi-stage build: stage 1 installs deps and builds all packages; stage 2 copies only compiled artefacts and production node_modules. Entry point: `node packages/server/dist/index.js`.
- **`.dockerignore`** — Excludes node_modules, .git, screenshots, etc.
- **`index.ts`** — Added `express.static()` for client dist and a catch-all middleware for SPA client-side routing. Compatible with Express 5.
- **DEPLOYMENT.md** — Full instructions for Artifact Registry, Docker build/push, and Cloud Run deploy with all env vars.

## Step 14: Polish and Remaining Details ✅

- **Error handling:** Added `error` state to MeetingContext. `useSocketConnection` listens for server `error` events. MeetingPage shows a full-page error for fatal errors (e.g. "Meeting not found" with a back-to-home link) and a dismissible red banner for non-fatal errors (e.g. permission denied).
- **Meeting not found:** Navigating to a non-existent meeting ID now shows a clear error page.
- **GitHub username validation:** `agenda:add` handler validates the owner username against the GitHub API when OAuth is configured. In mock auth mode, placeholder users are still allowed.
- **Responsive design:** NavBar uses tighter spacing on mobile (`gap-3 px-3` vs `gap-6 px-6` on larger screens).
- **Duplicate queue entries:** Allowed — a user can have multiple entries of the same type.
- **Advancing past last agenda item:** Already handled (returns "No more agenda items" error).
- **Chair actions as non-chair:** Already handled (returns permission error, now displayed to user).
