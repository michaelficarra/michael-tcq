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

## Step 4: Meeting UI Shell (Client)

Build the client-side meeting page with navigation, Socket.IO connection, and state management — but no interactive features yet.

- Add client-side routing: a home/landing page at `/` and a meeting page at `/meeting/:id`.
- Implement `MeetingContext` with `useReducer`. The reducer accepts a `state` action (full state replacement from the server).
- Implement the `useSocket` hook: connects to the server with the meeting ID, emits `join`, listens for `state`, and dispatches to the context.
- Build the meeting page layout: top navigation bar with "TCQ" branding, Agenda/Queue tab toggle, and a placeholder Log Out link. Two tab views (Agenda and Queue) that switch based on the selected tab.
- **Queue tab:** Display the current agenda item section (showing "Waiting for the meeting to start..."), the current speaker section (showing "Nobody speaking yet..."), and an empty speaker queue section. All read-only for now.
- **Agenda tab:** Display the agenda as a numbered list (will be empty initially).

**Checkpoint:** Navigating to `/meeting/<id>` connects via Socket.IO, receives the meeting state, and renders the shell UI with both tabs. Multiple browser tabs show the same state.

## Step 5: Agenda Management

Implement the full agenda feature: adding, deleting, and reordering agenda items.

- **Shared:** Add Socket.IO event types for `agenda:add`, `agenda:delete`, `agenda:reorder` (client-to-server) and corresponding server-to-client state broadcasts.
- **Server:** Implement handlers for each agenda action. Validate that the acting user is a chair. For `agenda:add`, validate the GitHub username by calling the GitHub API (requires the user's access token — skip this validation for now while using mock auth; add a TODO). Broadcast updated state to the room after each mutation.
- **Client (Agenda tab):**
  - Display agenda items as a numbered list showing name, owner (display name and organisation), and timebox if set.
  - Chair view: show a "New Agenda Item" button that opens a form with fields for name, owner (GitHub username), and timebox (minutes). Show a delete button on each item.
  - Implement drag-and-drop reordering for chairs (using a library such as `@dnd-kit/core`).
  - Participant view: read-only list, no controls.
- Since we don't have real auth yet, the mock user should be treated as a chair for testing.

**Checkpoint:** A chair can add agenda items via the form, see them appear in the list, reorder them via drag-and-drop, and delete them. A second browser tab sees all changes in real time.

## Step 6: Meeting Flow — Start Meeting and Agenda Advancement

Implement starting the meeting and advancing through agenda items.

- **Shared:** Add event types for `meeting:start` and `meeting:nextAgendaItem`.
- **Server:** Implement `meeting:start` — sets the first agenda item as `currentAgendaItem` and its owner as `currentSpeaker`. Implement `meeting:nextAgendaItem` — advances to the next item in the agenda, sets its owner as current speaker. Both are chair-only actions.
- **Client (Queue tab):**
  - Show "Waiting for the meeting to start..." with a **Start Meeting** button when there is no current agenda item (button visible to chairs only).
  - Once started, display the current agenda item's name, owner, and timebox.
  - Show a **Next Agenda Item** button (chair only).
  - Display the current speaker section: speaker name, organisation, and topic.

**Checkpoint:** Chair clicks Start Meeting, the first agenda item becomes active, and its owner is shown as the current speaker. Chair clicks Next Agenda Item to advance. All participants see the changes in real time.

## Step 7: Speaker Queue — Core

Implement the speaker queue: entering the queue, displaying it, and advancing through speakers.

- **Shared:** Add event types for `queue:add`, `queue:remove`, `queue:next`.
- **Server:**
  - `queue:add` — accepts `{ type, topic }`. Inserts the entry at the correct position based on type priority (Point of Order > Clarifying Question > Reply > New Topic), FIFO within the same type. Any authenticated user can do this.
  - `queue:remove` — accepts `{ id }`. A user can remove their own entry; a chair can remove any entry.
  - `queue:next` — chair-only. Pops the first entry from the queue and makes that person the current speaker. If the entry type is "topic", it also becomes the `currentTopic`. If the queue is empty, clears the current speaker.
  - Broadcast updated state after each mutation.
- **Client (Queue tab):**
  - Show four entry type buttons: New Topic, Discuss Current Topic (Reply), Clarifying Question, Point of Order. The Reply button is only visible when there is a current topic.
  - Clicking a button opens an inline form with a text input for the topic description and Enter Queue / Cancel buttons.
  - Display the speaker queue as a numbered list with type badge, topic, speaker name, and organisation.
  - Show a delete button on the user's own entries. Show delete, move up, and move down buttons for chairs.
  - Show **Next Speaker** button (chair only) in the current speaker section.
  - Display the current topic section when a topic is active.

**Checkpoint:** Participants can enter the queue with different entry types. Entries appear in priority order. Chair can advance to the next speaker. The current topic updates when a new topic speaker begins. All changes visible in real time across tabs.

## Step 8: Queue Reordering

Implement chair-only queue reordering with type changes on boundary crossing.

- **Shared:** Add event type for `queue:reorder`.
- **Server:** Implement `queue:reorder` — accepts `{ id, newIndex }`. When an entry moves across a type boundary, its type changes to match the entries at its new position. Chair-only.
- **Client:** Wire the move up / move down buttons to emit `queue:reorder`. Update the queue display to reflect the reordered state.

**Checkpoint:** Chair moves a "New Topic" entry above a "Clarifying Question" entry; the moved entry's type changes to "Clarifying Question". Changes are broadcast to all clients.

## Step 9: GitHub OAuth

Replace the mock auth with real GitHub OAuth.

---

**Infrastructure: GitHub OAuth App (Development)**

Register a GitHub OAuth App for local development:

1. Go to https://github.com/settings/developers (or, for an organisation-owned app, the organisation's developer settings).
2. Click **New OAuth App**.
3. Fill in:
   - **Application name:** TCQ (Development)
   - **Homepage URL:** `http://localhost:3000`
   - **Authorization callback URL:** `http://localhost:3000/auth/github/callback`
4. Click **Register application**.
5. On the app's settings page, note the **Client ID**.
6. Click **Generate a new client secret** and note the **Client Secret**. This is shown only once.
7. Copy the Client ID and Client Secret into your `.env` file as `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`. Set `GITHUB_CALLBACK_URL=http://localhost:3000/auth/github/callback`.

---

- **Server:** Implement `auth.ts`:
  - `GET /auth/github` — redirects to GitHub's OAuth authorisation URL with the client ID, callback URL, and scopes (`read:user`).
  - `GET /auth/github/callback` — receives the authorisation `code` query parameter, exchanges it for an access token via `POST https://github.com/login/oauth/access_token`, fetches the user's profile via `GET https://api.github.com/user` (using the access token), stores the user (`ghid`, `ghUsername`, `name`, `organization`) in the session, and redirects to `/`.
  - `GET /auth/logout` — destroys the session and redirects to `/`.
  - `GET /api/me` — returns the current user from the session, or 401 if not authenticated.
  - Add an auth middleware that protects `/api/*` routes and Socket.IO connections, returning 401 for unauthenticated requests.
- **Client:**
  - On page load, call `GET /api/me`. If 401, show the landing page with a "Log in with GitHub" button linking to `/auth/github`. If authenticated, show the meeting creation / join UI.
  - Replace any hardcoded mock user references with the authenticated user from the session.
  - Add a working Log Out link in the nav bar pointing to `/auth/logout`.
- Remove the mock auth middleware.

**Checkpoint:** Clicking "Log in with GitHub" redirects to GitHub, authenticates, and returns to the app with the user's real identity. The user's name and organisation appear in queue entries and as agenda item owners.

## Step 10: Home Page — Create and Join Meeting

Build the landing page for authenticated users.

- **Client:**
  - **Create Meeting** section: a form with a text input for chair GitHub usernames (comma-separated), pre-populated with the current user's username. A "Start a New Meeting" button. On submit, `POST /api/meetings` and redirect to `/meeting/:id`.
  - **Join Meeting** section: a text input for the meeting ID and a "Join" button. On submit, navigate to `/meeting/:id`. Show an error if the meeting does not exist.
- **Server:** The `POST /api/meetings` endpoint should look up each chair username via the GitHub API to resolve them to user objects (ghid, name, organisation). Return an error if any username is invalid.

**Checkpoint:** An authenticated user can create a meeting (specifying chairs) and is redirected to it. Another user can join by entering the meeting ID. Users can also join via the permalink `/meeting/:id` directly.

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
