import { Router } from 'express';
import type { Server } from 'socket.io';
import type { User, ClientToServerEvents, ServerToClientEvents } from '@tcq/shared';
import { CreateMeetingBodySchema, ImportAgendaBodySchema, SwitchUserBodySchema } from '@tcq/shared';
import type { MeetingManager } from './meetings.js';
import { fetchGitHubUser } from './auth.js';
import { isOAuthConfigured } from './mockAuth.js';
import { searchUsers, DEFAULT_AUTOCOMPLETE_LIMIT } from './githubDirectory.js';
import { mockUserFromLogin } from './mockUser.js';
import { getActiveConnectionCount, emitFullState } from './socket.js';
import { parseAgendaMarkdown } from './parseAgenda.js';
import { toSessionUser, toClientUser } from './session.js';
import { getRecentErrors, getErrorCount } from './errorBuffer.js';
import { getHttpCounters } from './httpCounters.js';
import { getSocketCounters } from './socketCounters.js';

/**
 * REST routes for meeting management.
 *
 * POST /api/meetings    — Create a new meeting
 * GET  /api/meetings/:id — Get a meeting's current state
 * GET  /api/me          — Get the current authenticated user
 * POST /api/meetings/:id/import-agenda — Import agenda from a markdown URL
 */
export function createMeetingRoutes(
  meetingManager: MeetingManager,
  io: Server<ClientToServerEvents, ServerToClientEvents>,
): Router {
  const router = Router();

  // Return the currently authenticated user from the session.
  // Includes a `mockAuth` flag so the client knows whether to show
  // the dev user-switcher UI.
  router.get('/me', (req, res) => {
    const user = req.session.user;
    if (!user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    // toClientUser strips the OAuth access token (server-only) before serialising.
    res.json({ ...toClientUser(user), mockAuth: !isOAuthConfigured() });
  });

  // --- Dev-only: switch the mock user ---
  // Allows changing the logged-in identity during development without
  // OAuth. Only available when mock auth is active.
  router.post('/dev/switch-user', (req, res) => {
    if (isOAuthConfigured()) {
      res.status(404).json({ error: 'Not available' });
      return;
    }

    const parsed = SwitchUserBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
      return;
    }
    const { username } = parsed.data;

    // Resolve via the mock-user helper so logins that match a TC39 seed
    // entry pick up the real display name and company; everyone else
    // falls back to login-as-name with no organisation. ghid stays
    // deterministic per login across restarts.
    const user = mockUserFromLogin(username);

    req.session.user = toSessionUser(user);
    delete req.session.mockLoggedOut;
    // Mock-auth users have no access token to leak, but route through
    // toClientUser anyway for consistency with /api/me.
    res.json(toClientUser(req.session.user));
  });

  // --- GitHub username autocomplete ---
  // Used by every input that accepts a GitHub username. Returns up to
  // `limit` users in three deduped tiers:
  //   1. users in the same meeting as the searcher (when `meetingId` is given),
  //   2. members of any organisation the searcher belongs to,
  //   3. global GitHub user search via the searcher's OAuth token.
  // See packages/server/src/githubDirectory.ts for the algorithm.
  router.get('/users/autocomplete', async (req, res) => {
    const user = req.session.user;
    if (!user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const meetingIdRaw = typeof req.query.meetingId === 'string' ? req.query.meetingId : undefined;
    const limitRaw = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : NaN;
    // Clamp to a sane window — protects the upstream GitHub call from a
    // pathological per_page=10000 and the response from blowing up.
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 25) : DEFAULT_AUTOCOMPLETE_LIMIT;

    const meeting = meetingIdRaw ? meetingManager.get(meetingIdRaw) : undefined;
    const users = await searchUsers(user, q, meeting, limit);
    res.json({ users });
  });

  // Create a new meeting. The request body should contain a `chairs` array
  // of GitHub usernames. Each username is validated against the GitHub API
  // when OAuth is configured; otherwise placeholder User objects are used.
  router.post('/meetings', async (req, res) => {
    const user = req.session.user;
    if (!user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const parsed = CreateMeetingBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
      return;
    }
    const chairUsernames = parsed.data.chairs;

    // Resolve each username to a User object
    const chairs: User[] = [];
    for (const username of chairUsernames) {
      // If this is the current user, use their full session profile
      if (username.toLowerCase() === user.ghUsername.toLowerCase()) {
        chairs.push(user);
        continue;
      }

      if (isOAuthConfigured()) {
        // Validate against the GitHub API when OAuth is configured
        const ghUser = await fetchGitHubUser(username);
        if (!ghUser) {
          res.status(400).json({ error: `GitHub user "${username}" not found` });
          return;
        }
        chairs.push(ghUser);
      } else {
        // Without OAuth, create a mock user via the seed-aware helper:
        // logins that match a TC39 seed entry pick up the real display
        // name and company, others fall back to login-as-name. The ghid
        // is deterministic per login so the same chair maps to the same
        // user across restarts and across meetings.
        chairs.push(mockUserFromLogin(username));
      }
    }

    if (chairs.length === 0) {
      res.status(400).json({ error: 'At least one valid chair username is required' });
      return;
    }

    const meeting = meetingManager.create(chairs);
    res.status(201).json(meeting);
  });

  // Get a meeting's current state by ID.
  router.get('/meetings/:id', (req, res) => {
    const meeting = meetingManager.get(req.params.id);
    if (!meeting) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }
    res.json(meeting);
  });

  // --- Get a meeting's log ---
  // The log is served separately from the realtime state to keep state
  // broadcasts small. Clients fetch on Logs-tab open and re-fetch when
  // they receive a `log:dirty` socket event. ETag/If-None-Match lets a
  // client whose cursor matches the server's latest skip the response
  // body entirely (returns 304). The optional `?since=<entryId>` query
  // returns only entries strictly after that cursor — the typical case
  // for refetches triggered by `log:dirty`.
  router.get('/meetings/:id/log', (req, res) => {
    const meetingId = req.params.id;
    if (!meetingManager.has(meetingId)) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }

    // The full log determines the current cursor (the id of the latest
    // entry, or empty string if the log is empty). This is independent
    // of whatever slice we return in the body.
    const fullLog = meetingManager.getLog(meetingId);
    const latestId = fullLog.length > 0 ? fullLog[fullLog.length - 1].id : '';
    const etag = `"${latestId}"`;

    res.set('ETag', etag);
    // The response is the same for every authenticated participant, but
    // access is auth-gated by the session middleware — `private` keeps
    // it out of shared caches (CDNs, corporate proxies) so the data
    // never reaches a party who hasn't been through auth. `must-revalidate`
    // forces the browser to round-trip the ETag on every use, so a
    // cached body can't outlive the next `log:dirty` push.
    res.set('Cache-Control', 'private, must-revalidate');

    // If the client already has the latest cursor, short-circuit. This
    // is the racy-second-fetch case: a `log:dirty` arrives, the client
    // fetches, and a duplicate `log:dirty` lands before the response
    // is processed. The second fetch finds nothing new and 304s.
    if (req.header('If-None-Match') === etag) {
      res.status(304).end();
      return;
    }

    const since = typeof req.query.since === 'string' ? req.query.since : undefined;
    const entries = meetingManager.getLogSince(meetingId, since);
    res.json(entries);
  });

  // --- Import agenda from a markdown URL ---

  router.post('/meetings/:id/import-agenda', async (req, res) => {
    const user = req.session.user;
    if (!user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const meetingId = req.params.id;
    const meeting = meetingManager.get(meetingId);
    if (!meeting) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }

    // Only chairs (and admins) can import an agenda
    if (!meetingManager.isChair(meetingId, user) && !user.isAdmin) {
      res.status(403).json({
        error: 'Only chairs can import an agenda',
        user: user.ghUsername,
        chairs: meeting.chairIds,
      });
      return;
    }

    const bodyParse = ImportAgendaBodySchema.safeParse(req.body);
    if (!bodyParse.success) {
      res.status(400).json({ error: bodyParse.error.issues[0]?.message ?? 'Invalid request' });
      return;
    }
    let url = bodyParse.data.url;

    // Transform GitHub blob URLs to raw.githubusercontent.com URLs
    // e.g. https://github.com/tc39/agendas/blob/main/2026/03.md
    //   → https://raw.githubusercontent.com/tc39/agendas/refs/heads/main/2026/03.md
    const blobMatch = url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/blob\/([^/]+)\/(.+)$/);
    if (blobMatch) {
      url = `https://raw.githubusercontent.com/${blobMatch[1]}/refs/heads/${blobMatch[2]}/${blobMatch[3]}`;
    }

    // Validate URL
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      res.status(400).json({ error: 'Invalid URL' });
      return;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      res.status(400).json({ error: 'URL must use HTTP or HTTPS' });
      return;
    }

    // Fetch the markdown (with timeout and size limit)
    const MAX_BODY_SIZE = 1024 * 1024; // 1 MB
    let markdown: string;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) {
        res.status(502).json({ error: `Failed to fetch URL: ${response.status} ${response.statusText}` });
        return;
      }

      // Check Content-Length header if available
      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > MAX_BODY_SIZE) {
        res.status(413).json({ error: 'Document is too large (limit: 1 MB)' });
        return;
      }

      // Read body incrementally with a size cap
      const reader = response.body?.getReader();
      if (!reader) {
        res.status(502).json({ error: 'Failed to read response body' });
        return;
      }
      const chunks: Uint8Array[] = [];
      let totalSize = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        totalSize += value.byteLength;
        if (totalSize > MAX_BODY_SIZE) {
          reader.cancel();
          res.status(413).json({ error: 'Document is too large (limit: 1 MB)' });
          return;
        }
        chunks.push(value);
      }
      markdown = new TextDecoder().decode(Buffer.concat(chunks));
    } catch (err) {
      const message = (err as Error).name === 'TimeoutError' ? 'Request timed out' : (err as Error).message;
      res.status(502).json({ error: `Failed to fetch URL: ${message}` });
      return;
    }

    // Parse agenda items from the markdown
    const items = parseAgendaMarkdown(markdown);
    if (items.length === 0) {
      res.status(422).json({ error: 'No agenda items found in the document' });
      return;
    }

    // Add each item to the meeting, bypassing GitHub username validation.
    // If no presenters were parsed, fall back to the importing user so the
    // item still has at least one presenter.
    for (const item of items) {
      const presenters: User[] =
        item.presenters.length > 0
          ? item.presenters.map((name) => ({
              ghid: 0,
              ghUsername: name,
              name,
              organisation: '',
            }))
          : [user];
      meetingManager.addAgendaItem(meetingId, item.name, presenters, item.duration);
    }

    // Broadcast the updated state to all connected clients
    // Bulk import — a single full-state emit is cheaper than firing an
    // `agenda:added` delta per imported item.
    emitFullState(io, meetingManager, meetingId);

    res.json({ imported: items.length });
  });

  // --- Admin endpoints ---

  // List all active meetings with connection statistics.
  router.get('/admin/meetings', (req, res) => {
    const user = req.session.user;
    if (!user || !user.isAdmin) {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }

    const meetings: {
      id: string;
      createdAt: string;
      participantUsernames: string[];
      currentConnections: number;
      lastConnection: string;
    }[] = [];

    // participantIds and lastConnectionTime live on the persisted meeting
    // state so they survive server restarts; currentConnections is live
    // socket-room state maintained in memory. Participant keys are resolved
    // to ghUsernames here so the client can render them without access to
    // the full meeting users map.
    for (const meeting of meetingManager.listAll()) {
      const current = getActiveConnectionCount(meeting.id);
      meetings.push({
        id: meeting.id,
        createdAt: meeting.createdAt,
        participantUsernames: meeting.participantIds.map((key) => meeting.users[key]?.ghUsername ?? key),
        currentConnections: current,
        lastConnection: current > 0 ? 'now' : meeting.operational.lastConnectionTime,
      });
    }

    res.json(meetings);
  });

  // Operational diagnostics for admins — surfaced on the home page so
  // operators can spot problems without shelling into Cloud Logging.
  // The shape is intentionally a single snapshot to keep the client
  // polling logic simple; refresh cadence lives on the client.
  router.get('/admin/diagnostics', (req, res) => {
    const user = req.session.user;
    if (!user || !user.isAdmin) {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }

    const allMeetings = meetingManager.listAll();
    // Sum unique participants across meetings (per-meeting unique, not
    // global unique — a user in two meetings counts twice). This matches
    // how `participantIds` is used elsewhere and keeps the aggregation cheap.
    let totalParticipants = 0;
    let totalMeetingConnections = 0;
    for (const m of allMeetings) {
      totalParticipants += m.participantIds.length;
      totalMeetingConnections += getActiveConnectionCount(m.id);
    }

    const uptimeSeconds = Math.floor(process.uptime());
    const mem = process.memoryUsage();
    // CPU time only ticks while the kernel actually schedules this process,
    // so on Cloud Run (where CPU is throttled outside of request handling)
    // it lags wall-clock uptime. The gap is a useful signal of how active
    // the instance has been.
    const cpu = process.cpuUsage();
    const cpuSeconds = (cpu.user + cpu.system) / 1_000_000;

    res.json({
      process: {
        uptimeSeconds,
        cpuSeconds,
        nodeVersion: process.version,
        gitSha: process.env.GIT_SHA ?? null,
        memory: {
          rss: mem.rss,
          heapUsed: mem.heapUsed,
          heapTotal: mem.heapTotal,
          external: mem.external,
        },
      },
      meetings: {
        totalActive: allMeetings.length,
        totalParticipants,
        totalConnections: totalMeetingConnections,
      },
      sockets: {
        // `engine.clientsCount` includes connections that haven't joined a
        // meeting room yet, so it's strictly ≥ totalConnections above.
        // Defensively read it: the test harness passes a stub `io` without
        // an `engine`, and we don't want diagnostics to break those tests.
        totalClients: io.engine?.clientsCount ?? 0,
        // Cumulative count of `state:resync` requests since process
        // start. Should stay near zero — a rising number suggests the
        // delta-broadcast path is dropping or mis-applying events and
        // clients are repeatedly self-healing.
        ...getSocketCounters(),
      },
      // Cumulative HTTP traffic since process start. Health-probe hits
      // are excluded — the counter increments inside httpLogger, which
      // skips `/api/health`.
      http: getHttpCounters(),
      // Persistence health from the periodic 30-s sync sweep. A
      // `lastSyncFailedAt` newer than `lastSyncSucceededAt` (or a
      // growing `dirtyCount`) means the store is failing silently.
      persistence: meetingManager.getPersistenceHealth(),
      errors: {
        totalSinceStart: getErrorCount(),
        recent: getRecentErrors(),
      },
    });
  });

  // Delete a meeting (admin only).
  router.delete('/admin/meetings/:id', async (req, res) => {
    const user = req.session.user;
    if (!user || !user.isAdmin) {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }

    const meetingId = req.params.id;
    if (!meetingManager.has(meetingId)) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }

    await meetingManager.remove(meetingId);
    res.json({ ok: true });
  });

  return router;
}
