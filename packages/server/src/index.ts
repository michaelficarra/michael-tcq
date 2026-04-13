import express from 'express';
import session from 'express-session';
import { createServer } from 'node:http';
import { join } from 'node:path';
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

const app = express();
const httpServer = createServer(app);

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
  const { FirestoreStore } = await import('firestore-store');

  const db = new Firestore();
  meetingStore = new FirestoreMeetingStore();
  sessionStore = new FirestoreStore({
    dataset: db,
    kind: 'sessions',
  });
} else {
  // File-based store for local development
  const dataDir = join(process.cwd(), '.data', 'meetings');
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
    // In production behind Cloud Run's HTTPS termination, we need
    // secure cookies. Detect via the "trust proxy" setting.
    secure: STORE_TYPE === 'firestore',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
  },
});

// Trust the Cloud Run reverse proxy so secure cookies work
if (STORE_TYPE === 'firestore') {
  app.set('trust proxy', 1);
}

// --- Express middleware ---

app.use(express.json());
app.use(sessionMiddleware);

// Mock auth: when GitHub OAuth credentials are not configured, inject
// a fake user so features work without an OAuth App. Does nothing when
// GITHUB_CLIENT_ID is set.
app.use(mockAuth);

// --- Auth routes (no requireAuth — these handle the login flow) ---

app.use('/auth', createAuthRoutes());

// --- Protected API routes ---

// Health check doesn't require authentication
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// All other /api routes require an authenticated session
app.use('/api', requireAuth, createMeetingRoutes(meetingManager));

// --- Socket.IO ---

const io = new SocketIOServer<ClientToServerEvents, ServerToClientEvents>(httpServer, {
  // In development, the Vite dev server proxies Socket.IO requests to Express,
  // so we need to allow the Vite origin for CORS.
  cors: {
    origin: ['http://localhost:5173'],
    credentials: true,
  },
});

// Share the Express session with Socket.IO so that WebSocket connections
// are authenticated using the same session cookie.
io.engine.use(sessionMiddleware);

// Apply mock auth to socket handshake requests (only effective when
// OAuth is not configured — otherwise it's a no-op).
io.engine.use(mockAuth);

// Register all Socket.IO event handlers (join, disconnect, etc.)
registerSocketHandlers(io, meetingManager);

// --- Start ---

async function start() {
  // Restore any persisted meetings from the store
  await meetingManager.restore();

  // Start periodic sync (writes dirty meetings to the store every 30 seconds)
  meetingManager.startPeriodicSync();

  // Log which modes are active
  console.log(`Persistence: ${STORE_TYPE}`);
  if (isOAuthConfigured()) {
    console.log('Authentication: GitHub OAuth');
  } else {
    console.log('Authentication: mock (set GITHUB_CLIENT_ID to enable OAuth)');
  }

  httpServer.listen(PORT, () => {
    console.log(`TCQ server listening on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
