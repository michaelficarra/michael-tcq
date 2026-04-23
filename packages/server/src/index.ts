// Load environment-specific .env file from the project root before anything else.
// When run via `npm run dev -w packages/server`, cwd is packages/server,
// so we resolve relative to this file's location (src/) → up to project root.
import { join } from 'node:path';
import dotenv from 'dotenv';
const projectRoot = join(import.meta.dirname, '../../..');
const envSuffix =
  process.env.NODE_ENV === 'production' ? 'production' : process.env.NODE_ENV === 'test' ? 'test' : 'development';
dotenv.config({ path: join(projectRoot, `.env.${envSuffix}`) });

import express from 'express';
import session from 'express-session';
import { createServer } from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '@tcq/shared';
import './session.js'; // session type augmentation
import { MeetingManager } from './meetings.js';
import { FileMeetingStore } from './fileStore.js';
import { FirestoreMeetingStore } from './firestoreStore.js';
import type { MeetingStore } from './store.js';
import { createMeetingRoutes } from './routes.js';
import { createAuthRoutes } from './auth.js';
import { requireAuth } from './requireAuth.js';
import { mockAuth, isOAuthConfigured } from './mockAuth.js';
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
});

const PORT = process.env.PORT ?? 3000;
const SESSION_SECRET = process.env.SESSION_SECRET ?? 'dev-secret-replace-me';
const STORE_TYPE = process.env.STORE ?? 'file';

// --- Persistence layer selection ---
// "file" (default) writes JSON files to .data/meetings/ — for local dev.
// "firestore" uses Google Cloud Firestore — for production.

let meetingStore: MeetingStore;
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
  sessionStore = new FirestoreStore({
    database: db,
    collection: 'sessions',
  });
} else {
  // File-based store for local development
  const dataDir = process.env.DATA_DIR ?? join(process.cwd(), '.data', 'meetings');
  info('file_store_initialised', { dataDir });
  const fileStore = new FileMeetingStore(dataDir);
  await fileStore.init();
  meetingStore = fileStore;
  // sessionStore left as undefined — uses express-session's default MemoryStore
}

const meetingManager = new MeetingManager(meetingStore);

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
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
  },
});

// Trust the Cloud Run reverse proxy so secure cookies work
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

// --- Express middleware ---

app.use(express.json());
app.use(sessionMiddleware);

// Mock auth: when GitHub OAuth credentials are not configured, inject
// a fake user so features work without an OAuth App. Does nothing when
// GITHUB_CLIENT_ID is set.
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

// All other /api routes require an authenticated session
app.use('/api', requireAuth, createMeetingRoutes(meetingManager, io));

// --- Static file serving (production) ---
// In production, the Express server serves the Vite-built client assets.
// In development, the Vite dev server handles this via proxy.
const CLIENT_DIST = join(import.meta.dirname, '../../client/dist');
app.use(express.static(CLIENT_DIST));

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

// Apply mock auth to socket handshake requests (only effective when
// OAuth is not configured — otherwise it's a no-op).
io.engine.use(mockAuth);

// Register all Socket.IO event handlers (join, disconnect, etc.)
registerSocketHandlers(io, meetingManager);

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
  info('auth_mode', { mode: isOAuthConfigured() ? 'github_oauth' : 'mock' });

  // Restore any persisted meetings from the store. If this fails
  // (e.g. Firestore not yet set up), log the error but continue
  // starting — the server should still be reachable so Cloud Run's
  // health check passes and we can diagnose via logs.
  try {
    await meetingManager.restore();
  } catch (err) {
    logError('restore_failed', { error: serialiseError(err) });
  }

  // Start periodic sync (writes dirty meetings to the store every 30 seconds)
  meetingManager.startPeriodicSync();

  // Start periodic expiry sweep (removes meetings with no connections in 90 days)
  meetingManager.startExpirySweep();

  httpServer.listen(PORT, () => {
    info('server_listening', { port: PORT });
  });
}

start().catch((err) => {
  critical('startup_failed', { error: serialiseError(err) });
  process.exit(1);
});
