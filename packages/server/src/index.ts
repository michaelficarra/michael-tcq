// Load environment-specific .env file from the project root before anything else.
// When run via `npm run dev -w packages/server`, cwd is packages/server,
// so we resolve relative to this file's location (src/) → up to project root.
import { join, sep } from 'node:path';
import dotenv from 'dotenv';
const projectRoot = join(import.meta.dirname, '../../..');
const envSuffix =
  process.env.NODE_ENV === 'production' ? 'production' : process.env.NODE_ENV === 'test' ? 'test' : 'development';
dotenv.config({ path: join(projectRoot, `.env.${envSuffix}`) });

import express from 'express';
import session from 'express-session';
import { createServer } from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import msgpackParser from 'socket.io-msgpack-parser';
import type { ClientToServerEvents, ServerToClientEvents } from '@tcq/shared';
import './session.js'; // session type augmentation
import { MeetingManager } from './meetings.js';
import { FileMeetingStore } from './fileStore.js';
import { FirestoreMeetingStore } from './firestoreStore.js';
import { sessionDocParser } from './sessionDocParser.js';
import type { MeetingStore } from './store.js';
import { AppSettingsManager } from './appSettingsManager.js';
import { FileAppSettingsStore, FirestoreAppSettingsStore, type AppSettingsStore } from './appSettingsStore.js';
import { createMeetingRoutes } from './routes.js';
import { createAuthRoutes, authProvidersHandler } from './auth.js';
import { enabledProviders } from './auth/registry.js';
import { requireAuth } from './requireAuth.js';
import { mockAuth, isMockAuthEnabled } from './mockAuth.js';
import { upgradeSessionUser } from './session.js';
import { securityHeaders } from './securityHeaders.js';
import { registerSocketHandlers } from './socket.js';
import { versionHandler } from './versionRoute.js';
import { httpLogger } from './httpLogger.js';
import { errorHandler } from './errorHandler.js';
import { info, error as logError, critical, serialiseError } from './logger.js';

const app = express();
const httpServer = createServer(app);

const io = new SocketIOServer<ClientToServerEvents, ServerToClientEvents>(httpServer, {
  // In production, the client is served from the same Express server (same
  // origin), so no CORS configuration is needed. In development, the Vite
  // dev server proxies Socket.IO requests from a different port, so we
  // allow any localhost origin.
  cors:
    envSuffix === 'production'
      ? undefined
      : {
          origin: (origin, callback) => {
            if (!origin || /^https?:\/\/localhost(:\d+)?$/.test(origin)) {
              callback(null, true);
            } else {
              callback(new Error('Not allowed by CORS'));
            }
          },
          credentials: true,
        },
  // Enable WebSocket per-message deflate. Socket.IO v4 disables it by
  // default (most apps send many small messages where compression is a
  // net loss), but TCQ broadcasts a full MeetingState on every mutation,
  // and that state is dominated by repetitive JSON (user keys, agenda
  // entry shapes, log entries). The threshold skips compression for
  // anything under 1 KB so acks and tiny events stay uncompressed.
  perMessageDeflate: { threshold: 1024 },
  // Replace the default JSON parser with MessagePack. Encodes typed
  // values directly (a number is a few bytes, not a decimal string;
  // a boolean is one byte, not "true"), so payloads are 20–40 % smaller
  // before compression kicks in. The client must be configured with
  // the same parser — see `packages/client/src/hooks/useSocketConnection.ts`.
  parser: msgpackParser,
});

const PORT = process.env.PORT ?? 3000;
const SESSION_SECRET = process.env.SESSION_SECRET ?? 'dev-secret-replace-me';
const STORE_TYPE = process.env.STORE ?? 'file';

// --- Persistence layer selection ---
// "file" (default) writes JSON files to .data/meetings/ — for local dev.
// "firestore" uses Google Cloud Firestore — for production.

let meetingStore: MeetingStore;
let appSettingsStore: AppSettingsStore;
let sessionStore: session.Store | undefined;

if (STORE_TYPE === 'firestore') {
  // Firestore for both meeting state and sessions.
  // Credentials are auto-discovered from GOOGLE_APPLICATION_CREDENTIALS
  // (local dev) or the default service account (Cloud Run).
  const { Firestore } = await import('@google-cloud/firestore');
  // firestore-store uses the connect-style factory: require('firestore-store')(session)
  const firestoreStoreModule = await import('firestore-store');
  const FirestoreStore = (firestoreStoreModule.default ?? firestoreStoreModule)(session);

  // Use the FIRESTORE_DATABASE_ID env var if set, otherwise default.
  // Named databases (e.g. "mtcq-db") require this to be specified.
  const databaseId = process.env.FIRESTORE_DATABASE_ID;
  const firestoreOpts = databaseId ? { databaseId } : {};
  const db = new Firestore(firestoreOpts);
  meetingStore = new FirestoreMeetingStore(firestoreOpts);
  appSettingsStore = new FirestoreAppSettingsStore(firestoreOpts);
  sessionStore = new FirestoreStore({
    database: db,
    collection: 'sessions',
    // Custom parser writes a top-level `expireAt` Timestamp so the Firestore
    // TTL policy on `sessions.expireAt` can prune expired session docs. See
    // sessionDocParser.ts for the buffer rationale.
    parser: sessionDocParser,
  });
} else {
  // File-based store for local development
  const dataDir = process.env.DATA_DIR ?? join(process.cwd(), '.data', 'meetings');
  info('file_store_initialised', { dataDir });
  const fileStore = new FileMeetingStore(dataDir);
  await fileStore.init();
  meetingStore = fileStore;
  // App settings live alongside the meetings directory, not inside it,
  // so `FileMeetingStore.loadAll` doesn't try to parse them as a meeting.
  appSettingsStore = new FileAppSettingsStore(join(dataDir, '..', 'app-settings.json'));
  // sessionStore left as undefined — uses express-session's default MemoryStore
}

const meetingManager = new MeetingManager(meetingStore);
const appSettingsManager = new AppSettingsManager(appSettingsStore);

// --- Session middleware (shared between Express and Socket.IO) ---

const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: sessionStore,
  cookie: {
    // Only use secure cookies in production (behind HTTPS).
    // NODE_ENV is set to 'production' in the Dockerfile.
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  },
});

// Trust the Cloud Run reverse proxy so secure cookies work
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

// --- Express middleware ---

// Send security headers (e.g. Referrer-Policy, to avoid leaking meeting links)
// on every response. Mounted first so it covers auth, API, and static assets.
app.use(securityHeaders);

app.use(express.json());
app.use(sessionMiddleware);

// Upgrade any session persisted in the pre-multi-provider user shape
// (`{ ghid, ghUsername, … }`) to the provider-neutral one on read, so a
// returning user isn't forced to log in again. Mounted right after the
// session middleware and before mock auth, and applied to the Socket.IO
// engine path too (see below) so WebSocket handshakes see the upgraded user.
const normaliseSessionUser: express.RequestHandler = (req, _res, next) => {
  const u = req.session?.user;
  // Legacy session users lack `provider`; idempotent for already-migrated ones.
  if (u && !('provider' in u)) {
    req.session.user = upgradeSessionUser(u);
  }
  next();
};
app.use(normaliseSessionUser);

// Mock auth: when no authentication provider is configured, inject a fake
// user so features work without an OAuth App. Does nothing otherwise.
app.use(mockAuth);

// Structured access logging — emits a GCP HttpRequest-shaped entry when
// each response finishes. Mounted after session/auth so req.session.user
// is populated on the logged entry.
app.use(httpLogger);

// --- Auth routes (no requireAuth — these handle the login flow) ---

app.use('/auth', createAuthRoutes());

// --- Protected API routes ---

// Health check doesn't require authentication
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Version endpoint: returns the deployed commit SHA, or 204 in dev.
app.get('/api/version', versionHandler);

// Public list of login options for the login page (no auth required).
app.get('/api/auth/providers', authProvidersHandler);

// All other /api routes require an authenticated session
app.use('/api', requireAuth, createMeetingRoutes(meetingManager, io, appSettingsManager));

// --- Static file serving (production) ---
// In production, the Express server serves the Vite-built client assets.
// In development, the Vite dev server handles this via proxy.
const CLIENT_DIST = join(import.meta.dirname, '../../client/dist');
app.use(
  express.static(CLIENT_DIST, {
    setHeaders(res, filePath) {
      // Vite emits content-hashed filenames under /assets, so they're
      // safely immutable for a year. Anything else (favicon, robots, the
      // index.html that occasionally comes through here) must revalidate
      // each load so a deploy isn't pinned behind a stale cache entry.
      if (filePath.includes(`${sep}assets${sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else if (filePath.endsWith(`${sep}index.html`)) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  }),
);

// Catch-all: serve index.html for client-side routing (e.g. /meeting/:id).
// This must come after all API and auth routes. Uses a middleware
// instead of app.get('*') for Express 5 compatibility.
app.use((_req, res, next) => {
  // Don't serve index.html for API, auth, or socket.io routes
  if (_req.path.startsWith('/api/') || _req.path.startsWith('/auth/') || _req.path.startsWith('/socket.io/')) {
    next();
    return;
  }
  // Only serve for GET requests (not POST, etc.)
  if (_req.method !== 'GET') {
    next();
    return;
  }
  // The catch-all serves index.html for client-side routes; the same
  // revalidate-each-load policy as above applies, since this response is
  // what bootstraps every fresh tab and must pick up new chunk hashes.
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(join(CLIENT_DIST, 'index.html'), (err) => {
    // If the file doesn't exist (dev mode), just skip
    if (err) next();
  });
});

// Error-handling middleware must be registered last so it catches errors
// from every route and middleware above.
app.use(errorHandler);

// --- Socket.IO ---

// Share the Express session with Socket.IO so that WebSocket connections
// are authenticated using the same session cookie.
io.engine.use(sessionMiddleware);

// Upgrade legacy session users on the socket handshake too, before mock
// auth — otherwise a returning user's WebSocket would carry a pre-migration
// user that fails the key-based chair/participant checks.
io.engine.use(normaliseSessionUser);

// Apply mock auth to socket handshake requests (only effective when no
// provider is configured — otherwise it's a no-op).
io.engine.use(mockAuth);

// Register all Socket.IO event handlers (join, disconnect, etc.)
registerSocketHandlers(io, meetingManager, appSettingsManager);

// --- Start ---

// --- Process-level error handlers ---
// Cloud Run recycles the instance on exit(1), which is safer than letting
// the process continue in an undefined state after an uncaught error. We
// log a CRITICAL entry first so the cause shows up in Cloud Logging even
// though the exit will terminate any buffered writes.
process.on('uncaughtException', (err) => {
  critical('uncaught_exception', { error: serialiseError(err) });
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  critical('unhandled_rejection', { error: serialiseError(reason) });
  process.exit(1);
});

async function start() {
  // Log which modes are active
  info('server_starting', { persistence: STORE_TYPE });
  // 'oauth' when real providers are configured, 'mock' for the dev auto-login,
  // and 'none' when neither applies (e.g. a production deploy missing its OAuth
  // credentials) — that state fails closed, so surface it loudly in the logs.
  const providerIds = enabledProviders().map((p) => p.id);
  info('auth_mode', {
    mode: providerIds.length > 0 ? 'oauth' : isMockAuthEnabled() ? 'mock' : 'none',
    providers: providerIds,
  });

  // Restore any persisted meetings from the store. If this fails
  // (e.g. Firestore not yet set up), log the error but continue
  // starting — the server should still be reachable so Cloud Run's
  // health check passes and we can diagnose via logs.
  try {
    await meetingManager.restore();
  } catch (err) {
    logError('restore_failed', { error: serialiseError(err) });
  }

  // Restore admin-managed app settings (currently: the premium-tier
  // user list). Best-effort: a failure here only loses the premium
  // badge, which is cosmetic. The manager keeps its default empty
  // list and the server still boots.
  try {
    await appSettingsManager.restore();
  } catch (err) {
    logError('appsettings_restore_failed', { error: serialiseError(err) });
  }

  // Start periodic sync (writes dirty meetings to the store every 30 seconds)
  meetingManager.startPeriodicSync();

  // Start periodic expiry sweep (removes meetings with no connections in 90 days)
  meetingManager.startExpirySweep();

  // Surface EADDRINUSE with a banner before exiting — concurrently
  // interleaves output from both workspaces during `npm run dev`, so the
  // structured `critical` log line is easy to miss. Without this, the
  // server dies silently while Vite keeps running and proxying /auth and
  // /api requests to whatever other process is squatting on PORT.
  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error('');
      console.error('==================================================================');
      console.error(`  Port ${PORT} is already in use.`);
      console.error('  Another process (perhaps a previous `npm run dev`) is bound to');
      console.error(`  this port. Stop it (e.g. \`lsof -ti:${PORT} | xargs kill\`) and try again.`);
      console.error('==================================================================');
      console.error('');
      process.exit(1);
    }
    critical('server_error', { error: serialiseError(err) });
    process.exit(1);
  });

  httpServer.listen(PORT, () => {
    info('server_listening', { port: PORT });
  });
}

start().catch((err) => {
  critical('startup_failed', { error: serialiseError(err) });
  process.exit(1);
});
