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
│           ├── auth.ts          # Generic OAuth routes (/auth/:providerId)
│           ├── auth/            # AuthenticationProvider interface, registry, GitHub impl
│           ├── meetings.ts      # MeetingManager class and mutations
│           ├── socket.ts        # Socket.IO event handlers
│           ├── meetingId.ts     # Word-based ID generation (human-id)
│           ├── store.ts         # MeetingStore interface
│           ├── fileStore.ts     # File-backed store (local dev)
│           ├── firestoreStore.ts # Firestore-backed store (production)
│           ├── mockAuth.ts      # Mock auth for development
│           └── requireAuth.ts   # Auth middleware for API routes
├── scripts/
│   ├── seed-meeting.mjs         # Populate a meeting with sample data
│   └── deploy.sh                # Build, push, and deploy to a Compute Engine VM
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

### Modals: native `<dialog>` via `useNativeDialog`

Every modal (preferences, keyboard-shortcuts, the agenda-advance conclusion, poll setup, the active poll, and admin delete-confirm) is a native modal `<dialog>` opened with `showModal()`, so focus trapping, focus restoration, top-layer stacking, and Esc/back-gesture dismissal come from the platform rather than hand-rolled handlers. The shared `hooks/useNativeDialog` hook owns the lifecycle: it mirrors a React `open` boolean onto `showModal()`/`close()`, bridges platform-driven closes back to an `onClose` callback, enables light dismiss via `closedby="any"` (with a coordinate-based outside-click fallback for browsers without it, e.g. Safari), and supports a non-dismissable mode (`closedby="none"` + Escape-keydown suppression) for the server-driven active-poll modal.

Two subtleties the hook handles: it tracks the `<dialog>` node as state (set by a callback ref) so its listeners attach even when the element mounts later than the hook first runs (e.g. a dialog inside a panel that renders nothing until data loads); and it **gates the dialog's contents** behind a `renderContents` flag that stays true through the exit transition but is otherwise false — a dismissed modal contributes no form controls to the DOM, which keeps its labels/text from colliding with unrelated test queries (Playwright's `getByLabel`/`getByText` match hidden elements). The `.tcq-dialog` class in `index.css` supplies the `::backdrop` tint and the `@starting-style`/`allow-discrete` entry-and-exit animation.

### Dropdowns: native `popover` via `usePopover`

The non-modal overlays — the hamburger menu (`UserMenu`), the saved-topics dropdown (`SpeakerControls`), and the username-combobox suggestion list (`UserCombobox`) — are native `popover` elements rather than `createPortal`'d `<div>`s. The Popover API gives top-layer stacking (so they escape the navbar's `overflow-x-auto` clipping and `z-index` cap without a portal), plus, for `popover="auto"`, platform light-dismiss and Esc. The two menus use the shared `hooks/usePopover` hook (the dropdown analogue of `useNativeDialog`): it shows the element on mount, bridges platform closes back to `onClose` via the `toggle` event, and resolves the auto-popover "click the open trigger" race (a pointerdown light-dismisses the menu, and the same click would otherwise reopen it) by snapshotting the open state on the trigger's pointerdown. The combobox list uses `popover="manual"` instead, because it owns its own open/close (light dismiss would fight typing in the input, which sits outside the list).

**Positioning stays in JS** — each overlay measures its anchor with `getBoundingClientRect` and sets a fixed `top`/`left`. CSS anchor positioning would be the declarative replacement, but it still isn't in Firefox or Safari, and a JS path would be needed for them regardless; keeping one positioning mechanism for all engines is simpler than maintaining two. The `.tcq-popover` class in `index.css` neutralises the UA popover box (`inset`/`margin`/`border`/`padding`) so those measured insets and the Tailwind chrome take over. jsdom ships only a partial Popover API (it never flips the UA `display:none`), so `test/setup.ts` replaces `showPopover`/`hidePopover` with stubs that toggle inline display; real dismissal behaviour is covered by the Playwright e2e suite.

### Toasts: in-app notifications via `popover="manual"`

Transient in-app messages — server-reported errors, failed actions, and the agenda edit-conflict warning — are unified into one toast region built on the same Popover-API foundation as the dropdowns. `ToastProvider` (`contexts/ToastContext.tsx`) sits above the router so any surface (home page, meeting page, and the socket layer inside `MeetingProvider`) can call `useToast().showToast(...)`; it owns the queue and renders `ToastRegion` (`components/ToastRegion.tsx`). Each toast is a `popover="manual"` element — `manual` (not `auto`) because toasts must survive interaction elsewhere on the page, where `auto`'s light-dismiss would close them. They promote to the top layer on mount via `showPopover()` (the same callback-ref → state → effect pattern as `usePopover`), funnel every close — the native `popovertargetaction="hide"` button, the JS auto-dismiss timer's `hidePopover()`, Esc — back through the `toggle` event so React state stays in sync, and dismissal is made idempotent so those paths can't double-fire a toast's `onDismiss`. Transient toasts auto-dismiss on a timer; the edit-conflict toast is persistent (`durationMs: null`) and is driven _controlled_ by `AgendaPanel`, whose local `conflict` flag still gates the overwrite confirmation — the toast is only its presentation. Stacking offsets are measured in JS (a `ResizeObserver` per toast feeds a `--toast-offset` custom property) rather than with `sibling-index()`: that CSS feature isn't Baseline and couldn't handle variable-height toasts anyway. The `.tcq-toast` class supplies the bottom-right anchor and the `@starting-style`/`allow-discrete` entry-and-exit animation (guarded by `@supports`), with a `prefers-reduced-motion` fallback. The app-out-of-date `StaleVersionBanner` adopts the same `popover="manual"` foundation (for guaranteed top-layer placement) but stays a standalone full-width banner with its own countdown and auto-reload — it is not part of the toast stack.

A join failure that arrives before any meeting state (e.g. "Meeting not found") is the exception: it's dispatched to `MeetingContext.error` for the page's full-page error fallback rather than a toast that would vanish. `useSocketConnection` branches on whether the version cursor is still null to tell the two apart.

### Form validation: native `:user-invalid` + `useAriaInvalidSync`

Constrained form controls style their validity with the native `:user-invalid` / `:user-valid` pseudo-classes, so error/success feedback is deferred to _after_ the user interacts rather than firing on first paint, with no per-field "touched" bookkeeping in React. The shared variant classes live in `lib/inputStyles.ts` (`inputValidation`). Since the pseudo-classes are purely visual, the `hooks/useAriaInvalidSync` hook — installed once at the app root — bridges them to `aria-invalid` for assistive tech, setting the attribute from capture-phase listeners (React owns these inputs' `value` but never renders `aria-invalid`, so it won't clobber it).

### State Management: React Context + useReducer

The server is the single source of truth for meeting state. The client receives the full state on connection and state patches on updates. A single `MeetingContext` with a reducer that applies server messages is sufficient.

No external state library (Redux, Zustand, Jotai) is needed. The state shape is small and well-defined, and there is only one source of state updates (the server).

`MeetingState` is grouped into domain subobjects: `queue` (entries, ordering, closed flag), `current` (agenda item, speaker, topic, topic-group accumulator), `poll` (present when a poll is running), and `operational` (advancement attribution and last-connection timestamp) — alongside the durable top-level fields `users`, `chairIds`, `agenda`, and `log`. The current speaker is a first-class struct on `current.speaker` rather than a reference into the queue entries map.

`current.startedAt` is the lifecycle marker for "the meeting has been advanced at least once". It's stamped the first time `nextAgendaItem` advances, and is **never cleared** — so when the chair advances past the final agenda item the meeting enters a **past-final** state (`current.agendaItemId` becomes undefined again while `current.startedAt` remains set). Three states are derivable from `current` alone: pre-start (`startedAt` and `agendaItemId` both undefined), in-progress (`agendaItemId` set), and past-final (only `startedAt` set). Past-final is what enables conclusions to be recorded for the final item via the same advance dialog, and it's the signal `addAgendaItem` checks to auto-activate a newly added item rather than waiting for a separate Start Meeting click. The field is backfilled on `MeetingManager.restore` from the `meeting-started` log entry's timestamp for meetings persisted before the field existed.

The `agenda` field is an ordered list of `AgendaEntry`s — a discriminated union on `kind` (`'item' | 'session'`) of `AgendaItem` (regular items) and `Session` (session headers that group items by capacity). Items and sessions share the same UUID id-space and the same reorder protocol (`agenda:reorder`). Session containment — which items are rendered inside which session, and the used/remaining/overflow values — is a pure display concern derived on the client from the agenda order and item durations; it is not stored in the meeting state. `AgendaItem.duration` is dual-purpose: for items ahead of the current one it holds the chair's estimate; when the chair advances past an item, the server overwrites it with the realised elapsed time rounded up to the nearest minute, and the client labels the value accordingly ("Estimate" vs "Duration").

## Backend

### Framework: Express

Express is the most widely known Node.js server framework. For an application with a handful of REST endpoints (OAuth callback, meeting creation, user info) plus WebSocket connections serving 50 users, Express is perfectly adequate. Its middleware ecosystem is extensive and every session/auth library supports it.

**Alternatives considered:**

- **Fastify** — Genuinely better TypeScript support and faster, but the performance difference is irrelevant at 50 users. Some ecosystem libraries (session stores, OAuth helpers) have more mature Express integrations.
- **Hono** — Designed for edge/serverless runtimes. TCQ requires a long-lived server process for WebSocket connections and in-memory state, which is not Hono's sweet spot.
- **NestJS** — A full enterprise framework with decorators, dependency injection, and modules. Massively over-engineered for an application with ~5 REST routes and a Socket.IO handler.

### REST Endpoints

The server exposes a small number of REST endpoints:

| Route                        | Method | Purpose                                                      |
| ---------------------------- | ------ | ------------------------------------------------------------ |
| `/auth/:providerId`          | GET    | Redirect to a provider's OAuth (e.g. `/auth/github`)         |
| `/auth/:providerId/callback` | GET    | Handle OAuth callback, create session                        |
| `/auth/logout`               | GET    | Destroy session                                              |
| `/api/auth/providers`        | GET    | List enabled login providers (`{ id, label }`)               |
| `/api/health`                | GET    | Health check                                                 |
| `/api/me`                    | GET    | Return current authenticated user (includes `mockAuth` flag) |
| `/api/meetings`              | POST   | Create a new meeting                                         |
| `/api/meetings/:id`          | GET    | Get a meeting's current state                                |
| `/api/meetings/:id/log`      | GET    | Fetch the meeting log (supports `?since=<id>` and ETag)      |
| `/api/dev/switch-user`       | POST   | Switch mock auth identity (dev mode only)                    |

All other interaction happens over Socket.IO. The server also serves the Vite-built client assets in production and has a catch-all for client-side routing.

## Real-Time Communication: Socket.IO

Socket.IO is the right transport for TCQ because it directly maps to the application's needs:

- **Rooms** — Each meeting is a Socket.IO room. When a client joins a meeting, they join the room. When state changes, the server broadcasts to the room. This is a single line of code.
- **Bidirectional communication** — Clients send actions (add to queue, reorder agenda) and the server sends state updates. Both directions use the same connection.
- **Automatic reconnection** — If a participant's connection drops (laptop sleep, network hiccup, an upstream restart), Socket.IO reconnects and the client re-syncs state. This is critical for a meeting tool and survives upstream connection-drop conditions transparently.
- **Fallback transports** — Socket.IO falls back to long-polling if WebSocket connections are blocked by corporate proxies or firewalls, which is relevant for a standards committee tool where participants may be on restricted networks.
- **Typed events** — Socket.IO supports TypeScript event type definitions on both client and server, using the shared types from `@tcq/shared`.

**Per-message compression.** The Socket.IO server is configured with `perMessageDeflate: { threshold: 1024 }`. Socket.IO v4 disables WebSocket compression by default because most apps emit many small messages where DEFLATE adds CPU overhead without meaningful savings; TCQ is the opposite case — every state mutation broadcasts the full `MeetingState` (a repetitive JSON document with many shared keys), so compression typically halves on-the-wire size. The threshold skips compression for sub-1 KB messages (acks, small admin events) where it is not worth the work.

**MessagePack parser.** Both ends use `socket.io-msgpack-parser` (`parser: msgpackParser` on the server constructor and the client `io()` call). MessagePack encodes typed values directly — numbers as a few bytes rather than decimal strings, booleans as a single byte rather than `"true"` — so the pre-compression baseline is roughly 20–40 % smaller than JSON. The two parsers must match: a JSON client cannot decode an msgpack server. Note that msgpack is stricter than JSON about `undefined`: `JSON.stringify` silently drops keys whose value is `undefined`, while msgpack-parser will encode them. Keep emit payloads explicitly free of `undefined` properties — the existing TypeScript types make this hard to violate accidentally.

### Message Architecture

The server is the single source of truth. The flow for every state change is:

1. Client emits an **action** via Socket.IO (e.g. `queue:add` with a payload).
2. Server **validates** the action — the payload is parsed against a shared Zod schema (defined in `@tcq/shared`) for shape / trim / length / enum checks, then authority checks (is the user authenticated? are they in this meeting? do they have permission?) run in the handler.
3. Server **mutates** its in-memory `MeetingState`.
4. Server emits a **typed delta event** (e.g. `queue:added` with `{ entry, position, version, users? }`) to every socket in the meeting room. Each delta carries a per-meeting monotonic `version` (mirrored on `OperationalState.version`) so clients can detect missed deltas.
5. Clients **apply** the delta to their locally-cached state via the reducer.

Clients do not perform optimistic updates — they wait for the server delta. At 50 users on a typical network, the round-trip latency is imperceptible, and this eliminates all conflict resolution complexity.

**Versioned deltas instead of full-state broadcasts.** Earlier the server re-broadcast the full `MeetingState` after every mutation. With ~50 users, ~40 agenda items, and multi-day meetings, that pattern dominated egress: each broadcast carried tens of kilobytes of state to every connected socket on every change. The current architecture instead emits one of 15 typed delta events per mutation (defined on `ServerToClientEvents` in `@tcq/shared`), each carrying only the changed fields. State broadcasts are reserved for the resync path:

- **Initial join** — the server `socket.emit('state', meeting)` to the joining socket only.
- **Automatic reconnect** — Socket.IO reconnects, the client re-joins, the same path emits `state`.
- **Explicit `state:resync` request** — when a client detects a gap in delta versions, it emits `state:resync` and the server replies on the same socket with a fresh `state`.
- **Bulk operations** — agenda import calls `emitFullState` once after adding many items, since a single resync is cheaper than dozens of `agenda:added` deltas.

**Gap detection.** Each delta's `version` is exactly `lastSeenVersion + 1` in the happy case. The client tracks `lastSeenVersion` in `MeetingContextState` (seeded from `operational.version` in the bootstrap `state` payload, bumped by each applied delta). A delta whose version doesn't match the expected next value triggers a `state:resync` request and is dropped — the replayed `state` reseeds the cursor. Late or duplicate deltas (`version <= lastSeenVersion`) are dropped silently. This makes divergence self-healing: any path that drops a delta (transient disconnect mid-flight, reducer bug, etc.) is corrected on the next event.

**User-record propagation.** Some deltas (e.g. `chairs:updated`, `agenda:added`, `queue:added`) carry an optional `users?: Record<UserKey, User>` slot with newly-introduced user records. The client merges these into `meeting.users` so badges render immediately without a separate fetch. Already-known users are simply overwritten with their (presumably identical) latest snapshot.

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
- **Admin soft-delete** — Deleting a meeting from the admin panel does **not** remove it from memory or the store; it stamps a `deletedAt` ISO timestamp on the `MeetingState`. Soft-deleted meetings are hidden from non-admin REST/socket access (joins respond as not-found and active sockets are evicted), but stay visible to admins so they can be restored (`POST /api/admin/meetings/:id/restore` clears `deletedAt`). The 90-day inactivity sweep is the eventual hard-deleter — a soft-deleted meeting accrues no new connections, so its `lastConnectionTime` stays frozen and it falls out of the next sweep window naturally.

**Why Firestore?** Firestore is a managed, serverless document database on GCP with an Always Free tier of 50,000 reads, 20,000 writes, and 20,000 deletes per day, plus 1 GiB of storage. Meeting state is a natural fit for a document model — each meeting is a single JSON document. At ~50 users and a handful of active meetings, the free tier is more than sufficient. There is no infrastructure to manage and no connection pooling to configure.

### Meeting Log: Decoupled from Realtime State

The per-meeting **log** (the timeline shown on the Logs tab — `meeting-started`, `agenda-item-started`, `agenda-item-finished`, `topic-discussed`, `poll-ran` entries) is intentionally **not** part of `MeetingState`. State broadcasts go to every connected socket on every mutation, and the log grows monotonically over a multi-day meeting; if it rode along, broadcasts would balloon as the meeting progressed.

**Decoupling.** Logs are stored separately from the main meeting document:

- In memory, `MeetingManager` holds a parallel `Map<meetingId, LogEntry[]>`.
- In Firestore, each meeting has a `log` subcollection (`meetings/{id}/log/{entryId}`), one document per entry. Each persisted doc carries an internal `_seq` field so `loadLog`/`loadAllLogs` can return entries in append order — the `LogEntry.timestamp` field is the _event time_ (e.g. a `topic-discussed` carries the speaker's start time), which can predate the append, so it is not a valid sort key.
- In the file store (local dev), each meeting's log is a sibling JSON file (`{id}.log.json`) — the simplest read-modify-write loop is fine at dev volumes.

**Wire protocol.**

- The dedicated REST endpoint `GET /api/meetings/:id/log` serves entries. It supports `?since=<entryId>` to return only entries after a cursor and uses the latest entry id as an `ETag`; clients send `If-None-Match` and the server returns `304 Not Modified` when nothing has changed.
- The server emits a `log:dirty` Socket.IO event (carrying just the latest entry id) to the meeting room whenever an entry is appended. Clients viewing the Logs tab use this signal to fetch via REST. There is no polling — the freshness signal is push-driven, the data path is HTTP.
- On the client, the `useMeetingLog` hook owns the cursor + ETag and re-fetches on `log:dirty`, on socket reconnect (in case a `log:dirty` was missed during the disconnect window), and on `visibilitychange` becoming visible (in case background-tab throttling delayed an event handler).

**Why this split?** The log is append-only, low-frequency, and view-optional — exactly the kind of data HTTP conditional GET was designed for. Keeping it off the realtime channel keeps state broadcasts small (and stops them from growing as the meeting goes on), while still giving the Logs tab effectively-live updates.

**For local development**, Firestore is replaced by a filesystem-backed implementation that writes meeting state as JSON files to disk. See the [Local Development](#local-development) section for details on the persistence adapter interface.

When the last client disconnects from a meeting, a cleanup timer starts (e.g. 5 minutes). If no one reconnects, the meeting is deleted from both memory and the persistent store.

**Alternatives considered:**

- **Pure in-memory (no persistence)** — Simpler, but all meeting state is lost on redeployment. For a meeting tool where a deploy during an active meeting would force everyone to start over, this is a poor experience.
- **PostgreSQL** — Requires running a database server, which adds docker-compose complexity or a managed database dependency. Overkill for storing a handful of JSON documents.
- **Redis** — Requires an external process. GCP Memorystore (managed Redis) does not have a free tier.
- **SQLite** — Works well locally but the production runtime is a container whose filesystem is rebuilt on every deploy, so SQLite data would be lost on container replacement — defeating the purpose of persistence. (A persistent volume on the VM would solve that, but Firestore gives us the same persistence with less to manage.)
- **GCP Cloud Storage** — Could store meeting state as JSON blobs. Simpler than Firestore but has higher latency for frequent small writes and no document-level operations. Firestore is a better fit for structured data that changes frequently.

### Application Settings: Runtime-Mutable Singleton

A small `AppSettings` document holds global, admin-managed settings that change at runtime — currently just the **premium-tier user list** (the runtime replacement for the former `PREMIUM_USERNAMES` env var; see `docs/PRD.md` for the user-facing description). A single `AppSettingsManager` mediates reads and writes:

- Reads are synchronous — every state broadcast goes through `isPremium(user)`, which is a `Set` membership check against the canonical (trimmed, lowercased) form.
- Writes are eager — each add/remove awaits the underlying store before returning, so a 200 from the admin endpoint implies the change is durable.
- Persistence mirrors the meeting-store split: `FileAppSettingsStore` writes a single JSON file at `.data/app-settings.json` (atomic via tmp + rename) for local dev; `FirestoreAppSettingsStore` writes a single document at `app-settings/singleton` for production. The default-on-missing semantics keep first boot crash-free.

When an admin adds or removes a premium username, the server scans the in-memory meetings map and re-emits a full `state` snapshot to every meeting room containing a GitHub user with that handle (premium membership is matched by handle, since a GitHub key is now the numeric id). Other rooms see no traffic. This rides on the existing `emitFullState` path — `decorateMeetingForClient` already re-runs `stampPremium` from the manager on every emit, so the badge / glow flips on or off for connected participants without a refresh.

### Sessions: Firestore

User sessions are also stored in Firestore, using a Firestore-backed session store for `express-session`. This keeps the persistence layer unified (one backing store rather than two) and means sessions survive container restarts, so users do not need to re-authenticate after a redeployment.

The session cookie has a 7-day lifetime. To prevent the `sessions` collection from growing unboundedly, a custom doc parser writes a top-level `expireAt` `Timestamp` on every session write, and a Firestore TTL policy on `sessions.expireAt` deletes expired documents automatically. `expireAt` is set to **cookie expiry + 24 hours** (so 8 days from session creation): the buffer prevents the race where express-session would still accept a cookie but Firestore has already deleted the backing document. Firestore TTL deletion is best-effort and may run up to ~24h after the timestamp passes, so the explicit buffer is layered on top of that.

For local development, sessions use the default in-memory session store (express-session's `MemoryStore`). This means sessions are lost on server restart, which is acceptable for development.

### Socket.IO Session Sharing

The Express session middleware is shared with Socket.IO, so WebSocket connections are authenticated using the same session cookie. On connection, the server reads the session to identify the user and determine their role (chair or participant) in the meeting they are joining.

## Authentication: pluggable OAuth providers

Authentication is structured around an `AuthenticationProvider` interface (`packages/server/src/auth/provider.ts`) so that multiple OAuth providers can coexist. Today there is a single implementation — `GitHubProvider` (`auth/github.ts`) — but the abstraction is shaped for adding Google (OIDC) and ORCID, which are also OAuth 2.0 authorization-code flows. The set of enabled providers is the registry in `auth/registry.ts`; a provider is "enabled" simply when its credentials are present in the environment. When none are enabled the server runs in mock-auth mode.

A user is identified provider-neutrally. The `User` type (`@tcq/shared`) carries `provider` (e.g. `github`), `accountId` (the provider's stable id — for GitHub the **numeric user id**, which survives a login rename), an optional human-readable `handle` (the GitHub login, used for display and chair/presenter entry), `name`, `organisation`, and a provider-supplied `avatarUrl`. The canonical `UserKey` is `${provider}:${accountId}` (e.g. `github:12345`), which lets accounts from different providers coexist in one meeting without colliding. `userKey()` in `@tcq/shared` is the single source of truth for deriving it. A user selector (chair/presenter inputs) commits a provider-neutral `UserSelection` — either `{ provider, accountId }` for an account picked from the directory, or `{ handle }` for free text typed without a match. The server resolves selections in `resolveUser.ts` (`resolveSelections`): a picked account is re-resolved to an authoritative profile (the acting user, an existing participant, or the provider's `resolveByAccountId`) so client-supplied display fields and avatar URLs are never trusted; a typed handle resolves via the provider's `resolveByHandle`, falling back to a `placeholder:<name>` user (a distinct provider so it can't collide with a real account id). Username autocomplete searches handle/name/organisation and never the opaque account id.

The routes are generic (`packages/server/src/auth.ts`):

1. `GET /auth/:providerId` — Look up the provider and redirect to its authorization URL. The GitHub provider requests the `read:user` scope only; the consent screen therefore mentions only profile data, no org-membership permission. In mock-auth mode (no provider configured) any `:providerId` just clears the logged-out flag and the mock middleware repopulates a fake user.
2. `GET /auth/:providerId/callback` — Exchange the authorisation code for a profile via the provider, store the user **and any provider access token** in the session, fire a background directory warm, and redirect to the application.
3. `GET /auth/logout` — Destroy the session.
4. `GET /api/auth/providers` — Public list of `{ id, label }` for the login page (one button per enabled provider).
5. `GET /api/me` — Return the current user from the session. Provider access tokens are server-only — `toClientUser()` in `session.ts` strips them before any response is shaped.

**Backward compatibility / migration.** Accounts predating the provider abstraction were stored GitHub-only: a `User` was `{ ghid, ghUsername, … }` and the `UserKey` was the bare lowercased login. Persisted data is upgraded lazily on read by `@tcq/shared`'s `migrate.ts` — a meeting/log document or a session is detected as legacy by shape (no `provider` field; an unprefixed key) and rewritten to the new form the first time it's loaded. The legacy data already carries the numeric `ghid`, so the upgrade is lossless: a user becomes `github:<ghid>`. Because that key isn't derivable from the old login key alone, a meeting's cross-references are re-keyed through a login→new-key map built from its own user records (`buildKeyRemap`), reused for the separately-stored log. Meetings are written back on the next sync; sessions are upgraded in place by a middleware on both the HTTP and Socket.IO paths so a returning user isn't forced to re-log-in; logs are upgraded in memory only. The premium list is not migrated — it stays a list of bare GitHub handles (matched against `user.handle` at runtime). The colon-based legacy detection is sound because legacy keys are bare GitHub logins, which never contain a colon.

### Username Autocomplete Directory

The `/api/users/autocomplete` endpoint backs the user selector. It dispatches to the **searcher's provider** directory capability (`providerById(user.provider)?.directory`, an enabled-agnostic lookup so the GitHub seed directory still answers in mock-auth mode) and returns provider-neutral `DirectorySuggestion`s (`{ user, badge? }`). A provider with no directory returns nothing. GitHub's directory (`packages/server/src/githubDirectory.ts`) is a server-wide in-memory cache with two parts: per-user `userOrgs` (the orgs each searcher _publicly_ belongs to) and per-org `orgMembers` (the _public_ members of each org, each enriched with display name and company), filled on the user's behalf using their persisted OAuth access token. Internally it works in GitHub-shaped records and maps them to neutral suggestions at the boundary.

- **Per-org enumeration is a two-step pipeline** — REST `GET /orgs/{org}/public_members` returns the public membership (login + id + avatar_url) in pages of 100, then a batched GraphQL query against `user(login: ...)` aliases — also up to 100 logins per round-trip — fills in display name and company for each. Both calls work under the `read:user` scope alone; we deliberately don't request `read:org`. The cost of the split is one extra HTTP round-trip per page of members; the earlier `organization.membersWithRole` GraphQL path packed the same data into one query per page but required `read:org`, and the consent-screen friction wasn't worth it.
- **ACL** — when answering an autocomplete request, only `orgMembers` for orgs in the searcher's `userOrgs` are consulted. Because both lists are public-only, the ACL is "members of orgs the searcher has chosen to publicly belong to" — concealed memberships are invisible on both sides of the relation.
- **Three-tier search** — meeting users → caller's public-org members → global GitHub user search (`/search/users`, called on the user's behalf, only when tiers 1+2 don't fill the dropdown).
- **Reused for agenda import** — the import handler resolves each parsed presenter name against the same directory via `searchUsersLocal` / `resolvePresenterFromDirectory` (tiers 1+2 only; tier 3 is intentionally skipped) and binds the item to the real user only when there's exactly one match. This is why `searchUsersLocal` is split out from `searchUsers` — autocomplete and import share ranking semantics but not autocomplete's background cache-warm side-effect. Import does, however, **await** `warmDirectoryForUser` before resolving so a chair landing on a freshly restarted instance (the cache is in-process memory) still gets tier-2 hits — a multi-second wait is acceptable for a one-shot import but would ruin the keystroke-driven autocomplete UX, hence the asymmetry.
- **Token revocation** — every server-side call that uses the persisted token routes through a single helper. A 401 / "Bad credentials" response clears the token from the session in place, so subsequent requests degrade silently rather than retrying with a known-bad credential.
- **Mock-auth fallback** — when GitHub OAuth is not configured, the directory returns matches from a hardcoded TC39 public-member seed list (`packages/shared/src/devUsers.ts`, regenerated by `scripts/refresh-dev-users.sh`).
- **Provider capability** — the directory is exposed as the GitHub provider's optional `directory` capability (`DirectoryCapability` in `auth/provider.ts`). Other providers (Google, ORCID) have no equivalent org-membership directory and may omit it.

**Alternatives considered:**

- **Passport.js** — Adds `passport`, `passport-github2`, and a serialise/deserialise abstraction. TCQ's own `AuthenticationProvider` interface is lighter than Passport's strategy/serialise machinery for the handful of OAuth providers in scope, and keeps the provider-neutral `User`/`UserKey` model under our control; Passport would be reconsidered if the provider count grew substantially.
- **Auth.js (NextAuth)** — Tightly coupled to Next.js. The standalone `@auth/core` exists but is less mature and less well-documented.

### Markdown Subsystem

User-authored fields that render formatted (agenda item names, queue topics, session names, item conclusions, poll topics) accept a small inline subset of markdown. The subset is defined once in `packages/shared/src/markdown.ts` and consumed everywhere — by the Zod validators on the server, by the agenda import parser on the server, and by the `<InlineMarkdown>` renderer on the client — so the supported features can never drift between layers.

- **Parser stack** — `unified` + `remark-parse` + `remark-gfm` for parsing; `remark-rehype` + `rehype-raw` + `hast-util-from-html` to produce a hast tree with inline HTML resolved into proper element nodes for rendering; `remark-stringify` (with GFM on) and `mdast-util-to-string` for the lenient "strip-and-reserialise" path.
- **Allowlist** — inline markdown only (text, soft/hard breaks, `**bold**`, `*italic*`, `~~strike~~`, `` `code` ``, `[text](url)`, autolinks) plus a small set of inline HTML tags: `a, b, strong, i, em, u, s, del, sub, sup, code`. URLs (markdown links and `<a href>`) must use `http:`, `https:`, or `mailto:`. No HTML attributes are accepted on any tag except `href` and `title` on `<a>`.
- **Sanitise-then-validate at the write boundary, lenient on render** — every Zod helper in `packages/shared/src/messages.ts` chains `.transform(sanitiseInlineMarkdown)` (or the block variant) before the `superRefine(validate…)` check. Sanitisation rewrites disallowed HTML, markdown images, and links with disallowed URL schemes (`javascript:`, `data:`, …) into text nodes containing the original source — so the offending markup _appears as written_ rather than the save failing or the tag silently vanishing. The validator then surfaces a specific reason only for residual markdown-level problems that have no HTML form (a heading or list typed into an inline-only field, multiple paragraphs, …). The renderer (`<InlineMarkdown>` / `<BlockMarkdown>`) and the agenda import parser run inputs through `stripUnsupportedMarkdown` / `stripUnsupportedBlockMarkdown` first, which does the same escaping _plus_ flattens unsupported block constructs so legacy stored content keeps rendering.
- **No `dangerouslySetInnerHTML`** — the renderer walks the parsed hast tree and emits React elements directly. After the sanitise/strip pre-pass, no disallowed tag should reach the renderer; the inner-text fallback there is purely defensive.

### Cross-Tab Auth Sync

The session cookie is shared across tabs in the same browser, so the server-side identity is always coherent — but each tab maintains its own React `AuthContext` user state. To keep all open tabs in sync after a login, logout, or dev-mode user switch, the client uses a `BroadcastChannel('tcq:auth')`. After every `/api/me` fetch, `AuthContext` compares the observed identity to a marker in `localStorage` (`tcq:auth:id`, holding the user key); on a mismatch, it updates the marker and posts an `auth-changed` message. Receiving tabs re-fetch `/api/me` rather than reloading, so ephemeral state (form drafts, scroll position, the open meeting view) is preserved. The new identity propagates from `AuthContext` into `MeetingContext`, and `useSocketConnection` re-handshakes the WebSocket because the user key is in its effect dependencies — necessary because socket auth is captured once at handshake from the session cookie.

## Logging and Observability

All logging goes through a small zero-dependency module (`packages/server/src/logger.ts`) that writes one JSON object per line to stdout. On the Container-Optimized OS host, the built-in fluent-bit agent (activated by the `google-logging-enabled=true` instance metadata flag) ingests container stdout/stderr and treats entries with a recognised `severity` field as structured `LogEntry` records, so no additional log-forwarding infrastructure is required.

Every entry carries `severity`, `message`, `time`, `service`, and — when `GIT_SHA` is set at deploy time — the deployment commit SHA. Callers add domain-specific fields alongside those defaults.

**Attribution.** Every log entry that names an acting user groups `provider`, `accountId`, `handle`, and `isAdmin` under a nested `user` field, so attribution stays together and does not collide with other top-level fields.

**HTTP access log.** A middleware (`httpLogger.ts`) emits one entry per response via `res.on('finish')`. The HTTP details go inside a top-level `httpRequest` object matching the [`LogEntry.HttpRequest`](https://cloud.google.com/logging/docs/reference/v2/rest/v2/LogEntry#HttpRequest) schema (`requestMethod`, `requestUrl`, `status`, `latency`, `protocol`, `responseSize`, `userAgent`, `referer`, `remoteIp`), which Cloud Logging renders inline in the Logs Explorer and exposes as queryable attributes. 2xx/3xx responses log at `INFO`, 4xx at `WARNING`, 5xx at `ERROR`. The uptime-probe path `/api/health` is skipped to avoid log spam.

**Socket.IO event log.** A per-socket middleware logs one entry per inbound event (`socket_event`), plus `socket_connected` / `socket_disconnected` at the connection lifecycle. Each entry carries the full payload under `args`, with entity IDs denormalised against the current meeting state — an `agenda:reorder` entry records the full agenda item being moved rather than an opaque UUID, a `queue:remove` records the full queue entry, `poll:react` records the selected option, `meeting:updateChairs` records the full user records for each named chair, and so on. Denormalisation is best-effort: unknown or stale ids are preserved verbatim so the entry still shows something useful.

**Periodic task log.** `MeetingManager` emits structured entries for its background work: `meetings_restored` at startup, `periodic_sync_completed` when the 30-second dirty-meeting sweep wrote at least one meeting, `expiry_sweep_completed` for the hourly 90-day cleanup, and a `NOTICE`-level `meeting_expired` per removed meeting. Failures in either sweep log at `ERROR` and the timer keeps running.

**Process-level error handlers.** `uncaughtException` and `unhandledRejection` handlers log at `CRITICAL` and exit with code 1 so the systemd-managed container restarts rather than letting the process continue in an undefined state. An Express error-handling middleware (`errorHandler.ts`) catches thrown errors from routes (including rejected async handlers in Express 5), logs the stack at `ERROR` alongside the `httpRequest` shape, and responds with a 500 JSON body.

**In-memory error ring (`errorBuffer.ts`).** Every `ERROR` or `CRITICAL` log line is mirrored into a 50-entry FIFO ring kept in process memory, alongside a monotonic counter of total errors recorded since startup. The ring is exposed through `GET /api/admin/diagnostics` so the diagnostics panel on the home page's Admin tab can surface recent failures without requiring access to Cloud Logging. State is process-local — when systemd restarts the container the ring resets, which is acceptable because the canonical record of errors lives in Cloud Logging. The buffer is bounded so a flood of errors can't grow memory unbounded; older entries are evicted FIFO and the counter still increments so admins can see that errors are happening even if the entries themselves have rolled off.

## Meeting ID Generation

Meeting IDs are generated using the `human-id` library, which produces three lowercase words joined by hyphens (e.g. `bright-pine-lake`, `calm-wave-fox`). With over 15 million combinations, collisions are vanishingly unlikely. If a collision does occur with an active meeting, a new ID is generated.

## Deployment

### Target: Google Compute Engine VM (Container-Optimized OS)

TCQ runs on a single `e2-micro` VM in Google Compute Engine, with [Container-Optimized OS (COS)](https://cloud.google.com/container-optimized-os/docs) as the host. `e2-micro` is in GCP's Always-Free tier (744 hours/month per region in `us-east1`, `us-central1`, or `us-west1`), which covers a single VM running 24/7. COS auto-updates the OS and Docker on a managed schedule, has no package manager surface area, and ships with the Cloud Logging integration enabled by default — closest thing GCP has to a maintenance-free Linux VM.

The runtime layout on the VM is two Docker containers managed by systemd:

- **`tcq.service`** — the application itself. The systemd unit pulls the latest image from Artifact Registry and runs the container with `--network=host`, `--env-file=/etc/tcq/env`, and `Restart=always` so a crash is recovered automatically.
- **`caddy.service`** — [Caddy 2](https://caddyserver.com/) as a reverse proxy in front of TCQ. Caddy obtains a Let's Encrypt certificate for the configured domain on first start and renews it on its own. Same `Restart=always` policy. Listens on `:80` and `:443`; `:80` is used for HTTP-01 validation and to redirect everything to HTTPS.

A static external IP is reserved for the VM so its address stays stable across stop/start cycles (DNS A record points at it). Firewall rules open only `tcp:80` and `tcp:443`; the application's port (`3000`) is bound to `127.0.0.1` inside the VM and never reachable externally.

**WebSocket handling:** Compute Engine doesn't impose a request-timeout cap (unlike Cloud Run's 60-minute limit). WebSockets stay open indefinitely until the network or one of the endpoints decides to drop them. Socket.IO's automatic reconnection still handles the cases where they do drop (network blips, laptop sleep) — the same way it would on any host.

**Logging:** COS-managed VMs forward container stdout/stderr to Cloud Logging when the instance has `google-logging-enabled=true` set in metadata. The structured JSON `LogEntry` records the server already emits (via `packages/server/src/logger.ts`) show up as queryable Cloud Logging entries with no agent install. Same for Cloud Monitoring metrics via `google-monitoring-enabled=true`.

**Deployment:** `scripts/deploy.sh` builds the Docker image locally, pushes it to Artifact Registry, copies a fresh env file to the VM via `gcloud compute scp`, and `ssh`'s in to pull the image and restart `tcq.service`. The VM is provisioned via cloud-init on first run, which writes both systemd units and the Caddyfile; subsequent deploys leave the VM's configuration alone and only update the running image and env.

**Why this shape over Cloud Run:**

Cloud Run was the original deployment target. It bills request-based vCPU-seconds, and a WebSocket counts as one long request — so the bill scales with `attendees × hours × 1 vCPU` regardless of CPU activity. For TCQ's 24-active-hour, 50–60-attendee meetings, two meetings/month consume the full 180,000 vCPU-seconds Always-Free budget. Compute Engine's `e2-micro` has fixed monthly free hours and no per-WebSocket-second billing, so meeting count is no longer a budget you watch — only RAM headroom on the single small VM.

**Alternatives considered:**

- **Cloud Run** — Hands-off serverless model and scales to zero, but per-WebSocket-second billing tightly couples per-meeting cost to vCPU. Two 24-hour meetings/month consume the entire vCPU free tier.
- **Fly.io** — Hobby-tier credit covers an always-on small VM (~$3/month). Globally distributed and WebSocket-friendly. Smaller resources than e2-micro and less integrated with the existing Firestore/Artifact Registry setup.
- **Oracle Cloud Free Tier** — 4 ARM Ampere cores + 24 GB RAM and 10 TB outbound, all always-free. Vastly more headroom than anything else, but requires running outside GCP (different account, different IAM model, less convenient Firestore access). Worth revisiting if TCQ ever outgrows e2-micro.
- **Cloudflare Durable Objects with WebSocket Hibernation** — DOs can hibernate connections; billing pauses while no messages flow. Architecturally interesting fit for the bursty mutation pattern, but a non-trivial rewrite (different runtime, different state model). Not justified at this scale.
- **Render free tier** — Spins down instances after 15 minutes of inactivity, with a ~30 second cold start. Bad UX for the first joiner of a meeting.
- **Railway** — $5/month credit, then paid. Not a real free tier for a 24/7 service.
- **Vercel** — Serverless functions with no persistent WebSocket support. Fundamentally the wrong deployment model for this application.
- **Cloudflare Workers** — Durable Objects could theoretically model each meeting, but the programming model is very different from standard Node.js and would add significant complexity.
- **GCP App Engine** — The standard environment supports WebSockets in the Node.js runtime, but its programming model expects per-request cleanup that doesn't fit a long-lived in-memory `MeetingState` map.

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

| Concern               | Local Development                                                                                         | Production (Compute Engine VM)                                                |
| --------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **Frontend**          | Vite dev server with HMR on a separate port; proxies API/WebSocket requests to the Express server         | Pre-built static files served directly by Express                             |
| **Server**            | Runs via `tsx --watch` (or similar) for automatic restart on file changes                                 | Compiled JavaScript in a Docker container, managed by systemd                 |
| **Persistence**       | Meeting state and sessions written to JSON files on the local filesystem (the `file` persistence adapter) | Firestore (the `firestore` persistence adapter)                               |
| **OAuth**             | A separate GitHub OAuth App configured with `http://localhost:<port>` as the callback URL                 | A GitHub OAuth App configured with the production URL                         |
| **HTTPS**             | Not used; plain HTTP on localhost                                                                         | Terminated by Caddy in front of TCQ; Let's Encrypt cert auto-renewed          |
| **WebSocket timeout** | None; connections persist indefinitely                                                                    | None at the host; Socket.IO reconnects transparently if the network drops one |

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
