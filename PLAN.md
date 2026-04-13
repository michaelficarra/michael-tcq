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

## Step 11: Temperature Checks

Implement the temperature check feature.

- **Shared:** Add event types for `temperature:start`, `temperature:stop`, `temperature:react`.
- **Server:**
  - `temperature:start` — chair-only. Sets `trackTemperature` to true, clears any existing reactions. Broadcasts.
  - `temperature:stop` — chair-only. Sets `trackTemperature` to false, clears reactions. Broadcasts.
  - `temperature:react` — accepts `{ reaction }`. Toggles the reaction for the acting user (adds if not present, removes if present). Each user can have at most one of each reaction type. Broadcasts.
- **Client (Queue tab):**
  - Show a **Check Temperature** button (chair only) in the agenda item section. When a temperature check is active, replace it with a **Stop Temperature** button.
  - When `trackTemperature` is true, display the reaction panel: six buttons with emoji and label, each showing a count. Clicking a reaction emits `temperature:react`. Hovering shows a tooltip with the names of users who reacted.

**Checkpoint:** Chair starts a temperature check. All participants see the reaction panel. Participants click reactions; counts update in real time. Chair stops the check; reactions are cleared.

## Step 12: Persistence — Periodic Firestore Sync

Wire up the persistence layer for meeting state and sessions so that data survives container restarts.

---

**Infrastructure: Google Cloud Project and Firestore**

1. **Create a GCP account** (if you don't have one) at https://cloud.google.com/. The Always Free tier does not require a credit card for Firestore, but GCP may require billing to be enabled on the project (you will not be charged within free-tier limits).

2. **Create a new GCP project:**
   - Go to https://console.cloud.google.com/projectcreate.
   - Enter a project name (e.g. `tcq`) and click **Create**.
   - Note the **Project ID** (e.g. `tcq-123456`).

3. **Enable the Firestore API:**
   - Go to https://console.cloud.google.com/firestore (with your project selected).
   - Choose **Native mode** (not Datastore mode).
   - Select a region eligible for Always Free tier: `us-east1`, `us-central1`, or `us-west1`.
   - Click **Create Database**.

4. **Create a service account for local development:**
   - Go to https://console.cloud.google.com/iam-admin/serviceaccounts.
   - Click **Create Service Account**.
   - Name: `tcq-dev`. Click **Create and Continue**.
   - Grant the role **Cloud Datastore User** (this covers Firestore Native mode access). Click **Continue**, then **Done**.
   - Click the newly created service account, go to the **Keys** tab, click **Add Key > Create new key**, select **JSON**, and click **Create**. A JSON key file will be downloaded.
   - Save this file as `service-account.json` in the project root (it is already in `.gitignore`). Set the environment variable `GOOGLE_APPLICATION_CREDENTIALS=./service-account.json` in your `.env` file.

---

- **Server:**
  - Implement `FirestoreMeetingStore` using the `@google-cloud/firestore` npm package. Each meeting is a document in a `meetings` collection, keyed by the meeting ID. The document body is the serialised `MeetingState`.
  - Implement the periodic sync: a `setInterval` (e.g. every 30 seconds) iterates all in-memory meetings and writes any with a dirty flag to Firestore. Clear the dirty flag after a successful write. Also write immediately after high-value mutations (agenda advancement, speaker advancement).
  - On server startup, call `loadAll()` on the active store to restore meetings from the persistent store into the in-memory map.
  - Implement a Firestore-backed session store for `express-session` (or use an existing library such as `firestore-store`).
  - Select the store implementation based on the `STORE` environment variable (`file` or `firestore`), defaulting to `file`.
- Update `.env.example` with `STORE` and `GOOGLE_APPLICATION_CREDENTIALS`.
- Add `service-account.json` to `.gitignore`.

**Checkpoint:** With `STORE=firestore`, create a meeting and add some agenda items. Restart the server. The meeting state is restored from Firestore. Verify in the GCP Console (Firestore data viewer) that the document exists.

## Step 13: Production Deployment

Deploy the application to Google Cloud Run.

---

**Infrastructure: Cloud Run and Artifact Registry**

1. **Install the Google Cloud CLI** (`gcloud`) if not already installed: https://cloud.google.com/sdk/docs/install.

2. **Authenticate and set the project:**
   ```
   gcloud auth login
   gcloud config set project <your-project-id>
   ```

3. **Enable required APIs:**
   ```
   gcloud services enable run.googleapis.com artifactregistry.googleapis.com
   ```

4. **Create an Artifact Registry repository** (for storing the Docker image):
   ```
   gcloud artifacts repositories create tcq --repository-format=docker --location=us-central1
   ```

5. **Configure Docker to authenticate with Artifact Registry:**
   ```
   gcloud auth configure-docker us-central1-docker.pkg.dev
   ```

6. **Register a production GitHub OAuth App:**
   - Follow the same steps as in Step 9, but use the production URL:
     - **Homepage URL:** `https://<your-cloud-run-url>` (you will know this after the first deploy; you can update it then)
     - **Authorization callback URL:** `https://<your-cloud-run-url>/auth/github/callback`
   - Note the Client ID and Client Secret.

---

- **Write a `Dockerfile`:**
  - Multi-stage build: first stage installs dependencies and builds all three packages (shared, client, server). Second stage copies only the compiled server, the built client assets, and production `node_modules`.
  - The entry point runs `node packages/server/dist/index.js`.
- **Deploy to Cloud Run:**
  ```
  # Build and push the image
  docker build -t us-central1-docker.pkg.dev/<project-id>/tcq/tcq:latest .
  docker push us-central1-docker.pkg.dev/<project-id>/tcq/tcq:latest

  # Deploy
  gcloud run deploy tcq \
    --image us-central1-docker.pkg.dev/<project-id>/tcq/tcq:latest \
    --region us-central1 \
    --allow-unauthenticated \
    --set-env-vars "STORE=firestore,SESSION_SECRET=<generate-a-secret>,GITHUB_CLIENT_ID=<prod-client-id>,GITHUB_CLIENT_SECRET=<prod-client-secret>,GITHUB_CALLBACK_URL=https://<cloud-run-url>/auth/github/callback" \
    --request-timeout 3600 \
    --session-affinity
  ```
  - After the first deploy, note the Cloud Run service URL and update the production GitHub OAuth App's callback URL to match.
  - Cloud Run's default service account has Firestore access, so no additional credentials are needed in production.
- **Configure the request timeout** to 3,600 seconds (the maximum) to minimise WebSocket reconnections.
- **Verify:** Visit the production URL, log in with GitHub, create a meeting, test the full flow.

**Checkpoint:** The application is live on Cloud Run. OAuth works with the production GitHub App. Meetings persist across container restarts via Firestore.

## Step 14: Polish and Remaining Details

Address UI polish, edge cases, and any remaining PRD requirements.

- **GitHub username validation on agenda items:** When adding an agenda item, validate the owner's GitHub username by calling the GitHub API. Show an error if the username does not exist.
- **Responsive design:** Ensure the UI works on mobile viewports (the nav bar should collapse to a hamburger menu or similar).
- **Error handling:** Show user-facing error messages for failed actions (meeting not found, unauthorised, etc.).
- **Meeting not found:** Show a clear error page when navigating to a non-existent meeting ID.
- **Edge cases:**
  - Attempting to enter the queue when not in a meeting.
  - Attempting chair actions as a non-chair.
  - Advancing past the last agenda item.
  - Duplicate queue entries by the same user (decide whether to allow or prevent).
