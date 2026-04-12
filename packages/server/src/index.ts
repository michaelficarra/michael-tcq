import express from 'express';
import session from 'express-session';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { Server as SocketIOServer } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '@tcq/shared';
import { MeetingManager } from './meetings.js';
import { FileMeetingStore } from './fileStore.js';
import { createMeetingRoutes } from './routes.js';
import { mockAuth } from './mockAuth.js';
import { registerSocketHandlers } from './socket.js';

const app = express();
const httpServer = createServer(app);

const PORT = process.env.PORT ?? 3000;
const SESSION_SECRET = process.env.SESSION_SECRET ?? 'dev-secret-replace-me';

// --- Session middleware (shared between Express and Socket.IO) ---

const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false, // will be true behind Cloud Run's HTTPS termination
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
  },
});

// --- Express middleware ---

app.use(express.json());
app.use(sessionMiddleware);

// Temporary mock auth — injects a fake user into the session so that
// features can be developed and tested without configuring GitHub OAuth.
// This will be removed when real OAuth is implemented in Step 9.
app.use(mockAuth);

// --- Persistence ---

const DATA_DIR = join(process.cwd(), '.data', 'meetings');
const store = new FileMeetingStore(DATA_DIR);
const meetingManager = new MeetingManager(store);

// --- REST routes ---

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api', createMeetingRoutes(meetingManager));

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

// Apply mock auth to socket handshake requests so the session has a user.
// This mirrors what the Express middleware does for HTTP requests.
io.engine.use(mockAuth);

// Register all Socket.IO event handlers (join, disconnect, etc.)
registerSocketHandlers(io, meetingManager);

// --- Start ---

async function start() {
  // Ensure the file store directory exists, then restore any persisted meetings
  await store.init();
  await meetingManager.restore();

  // Start periodic sync (writes dirty meetings to disk every 30 seconds)
  meetingManager.startPeriodicSync();

  httpServer.listen(PORT, () => {
    console.log(`TCQ server listening on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
