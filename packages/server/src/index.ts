import express from 'express';
import session from 'express-session';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { MeetingManager } from './meetings.js';
import { FileMeetingStore } from './fileStore.js';
import { createMeetingRoutes } from './routes.js';
import { mockAuth } from './mockAuth.js';

const app = express();
const httpServer = createServer(app);

const PORT = process.env.PORT ?? 3000;
const SESSION_SECRET = process.env.SESSION_SECRET ?? 'dev-secret-replace-me';

// --- Middleware ---

app.use(express.json());

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: false, // will be true behind Cloud Run's HTTPS termination
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    },
  }),
);

// Temporary mock auth — injects a fake user into the session so that
// features can be developed and tested without configuring GitHub OAuth.
// This will be removed when real OAuth is implemented in Step 9.
app.use(mockAuth);

// --- Persistence ---

const DATA_DIR = join(process.cwd(), '.data', 'meetings');
const store = new FileMeetingStore(DATA_DIR);
const meetingManager = new MeetingManager(store);

// --- Routes ---

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api', createMeetingRoutes(meetingManager));

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
