import { Router } from 'express';
import type { Server } from 'socket.io';
import type { PremiumUsersResponse, ClientToServerEvents, ServerToClientEvents } from '@tcq/shared';
import {
  CreateMeetingBodySchema,
  ImportAgendaBodySchema,
  ImportAgendaFileBodySchema,
  PremiumUserBodySchema,
  SwitchUserBodySchema,
  userKey,
} from '@tcq/shared';
import type { MeetingManager } from './meetings.js';
import { isMockAuthEnabled } from './mockAuth.js';
import { providerById } from './auth/registry.js';
import { resolveSelections } from './resolveUser.js';
import { DEFAULT_AUTOCOMPLETE_LIMIT } from './githubDirectory.js';
import { resolvePremiumUsers } from './premiumDirectory.js';
import { mockUserFromLogin } from './mockUser.js';
import { getActiveConnectionCount, emitFullState, broadcastPremiumChange } from './socket.js';
import { parseAgendaMarkdown } from './parseAgenda.js';
import { loadAgendaJson } from './parseAgendaImport.js';
import { applyImportedAgendaEntries, resolveImportedPresenters } from './importAgendaEntries.js';
import { applyUrlImport } from './slotImportedItems.js';
import { toSessionUser, toClientUser } from './session.js';
import { getRecentErrors, getErrorCount } from './errorBuffer.js';
import { getHttpCounters } from './httpCounters.js';
import { getSocketCounters } from './socketCounters.js';
import type { AppSettingsManager } from './appSettingsManager.js';

/**
 * REST routes for meeting management.
 *
 * POST /api/meetings    — Create a new meeting
 * GET  /api/meetings/:id — Get a meeting's current state
 * GET  /api/me          — Get the current authenticated user
 * POST /api/meetings/:id/import-agenda — Import agenda from a markdown URL
 * POST /api/meetings/:id/import-agenda-file — Import agenda from a JSON file
 */
export function createMeetingRoutes(
  meetingManager: MeetingManager,
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  appSettings: AppSettingsManager,
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
    res.json({ ...toClientUser(user, appSettings), mockAuth: isMockAuthEnabled() });
  });

  // --- Dev-only: switch the mock user ---
  // Allows changing the logged-in identity during development without
  // OAuth. Only available when mock auth is active.
  router.post('/dev/switch-user', (req, res) => {
    if (!isMockAuthEnabled()) {
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
    // falls back to login-as-name with no organisation. The login maps to
    // a stable `github:<id>` key across restarts (seed id, else a
    // deterministic hash of the login).
    const user = mockUserFromLogin(username);

    req.session.user = toSessionUser(user);
    delete req.session.mockLoggedOut;
    // Mock-auth users have no access token to leak, but route through
    // toClientUser anyway for consistency with /api/me.
    res.json(toClientUser(req.session.user, appSettings));
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
    // Dispatch to the searcher's provider directory (enabled-agnostic so the
    // GitHub seed directory still answers in mock-auth mode). A provider with
    // no directory capability returns nothing.
    const directory = providerById(user.provider)?.directory;
    const suggestions = directory ? await directory.searchUsers(user, q, meeting, limit) : [];
    res.json({ suggestions });
  });

  // Create a new meeting. The body carries `chairs` as a list of
  // `UserSelection`s (typically just the creator's own identity). Each is
  // resolved through the provider — an account selection is re-resolved to an
  // authoritative profile, a free-text handle via the provider's handle lookup.
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

    // No meeting exists yet, so resolution falls to the acting user / provider.
    const chairs = await resolveSelections(user, undefined, parsed.data.chairs);

    if (chairs.length === 0) {
      res.status(400).json({ error: 'At least one valid chair is required' });
      return;
    }

    const meeting = meetingManager.create(chairs);
    res.status(201).json(meeting);
  });

  // Get a meeting's current state by ID. Soft-deleted meetings respond
  // 404, identical to a never-existed id — non-admin callers should never
  // be able to tell the difference.
  router.get('/meetings/:id', (req, res) => {
    const meeting = meetingManager.get(req.params.id);
    if (!meeting || meeting.deletedAt !== undefined) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }
    res.json(meeting);
  });

  // List the meetings the current user is associated with — surfaced on the
  // home page so a returning user can see, and link straight back into,
  // meetings they've previously taken part in. A meeting matches when the
  // caller's UserKey appears either in `meeting.users` (chair, presenter, or
  // anyone ever queued) or in `meeting.participantIds` (anyone who has joined
  // via socket). The participantIds branch is a near-subset of the users
  // branch in normal flows, but checking both is cheap and protects against
  // any code path that adds a participant without populating the users map.
  // `lastActivity` mirrors the shape used by the admin meetings list: the
  // literal string `'now'` when at least one socket is currently connected
  // to the meeting, otherwise the ISO timestamp recorded the last time a
  // socket was open (empty string if no one has ever connected).
  router.get('/my-meetings', (req, res) => {
    const user = req.session.user;
    if (!user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const key = userKey(user);
    const matches: { id: string; lastActivity: string; currentConnections: number; sortTime: string }[] = [];
    for (const meeting of meetingManager.listAll()) {
      // Hide soft-deleted meetings — once an admin deletes a meeting it
      // should disappear from every non-admin surface, including the
      // home-page rediscovery list.
      if (meeting.deletedAt !== undefined) continue;
      if (key in meeting.users || meeting.participantIds.includes(key)) {
        const live = getActiveConnectionCount(meeting.id);
        const lastConnectionTime = meeting.operational.lastConnectionTime ?? '';
        matches.push({
          id: meeting.id,
          lastActivity: live > 0 ? 'now' : lastConnectionTime,
          currentConnections: live,
          sortTime: lastConnectionTime,
        });
      }
    }

    // In-progress meetings float to the top; among the rest, the most
    // recently active meeting wins. A meeting that nobody has ever
    // connected to (empty `sortTime`) sorts last.
    matches.sort((a, b) => {
      if (b.currentConnections !== a.currentConnections) return b.currentConnections - a.currentConnections;
      return b.sortTime.localeCompare(a.sortTime);
    });

    res.json(matches.map(({ id, lastActivity, currentConnections }) => ({ id, lastActivity, currentConnections })));
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
    if (!meetingManager.has(meetingId) || meetingManager.isDeleted(meetingId)) {
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
    if (!meeting || meeting.deletedAt !== undefined) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }

    // Only chairs (and admins) can import an agenda
    if (!meetingManager.isChair(meetingId, user) && !user.isAdmin) {
      res.status(403).json({
        error: 'Only chairs can import an agenda',
        user: userKey(user),
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

    // Presenter resolution and item placement: see resolveImportedPresenters
    // and applyUrlImport in importAgendaEntries.ts / slotImportedItems.ts.
    const flatItems = items.map((item) => ({
      kind: 'item' as const,
      name: item.name,
      presenters: item.presenters,
      duration: item.duration,
    }));
    const resolved = await resolveImportedPresenters(user, meeting, flatItems);

    applyUrlImport(meetingManager, meetingId, items, resolved, bodyParse.data.slotIntoSessions === true);

    // Broadcast the updated state to all connected clients
    // Bulk import — a single full-state emit is cheaper than firing an
    // `agenda:added` delta per imported item.
    emitFullState(io, meetingManager, meetingId, appSettings);

    res.json({ imported: items.length });
  });

  router.post('/meetings/:id/import-agenda-file', async (req, res) => {
    const user = req.session.user;
    if (!user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const meetingId = req.params.id;
    const meeting = meetingManager.get(meetingId);
    if (!meeting || meeting.deletedAt !== undefined) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }

    if (!meetingManager.isChair(meetingId, user) && !user.isAdmin) {
      res.status(403).json({
        error: 'Only chairs can import an agenda',
        user: userKey(user),
        chairs: meeting.chairIds,
      });
      return;
    }

    const bodyParse = ImportAgendaFileBodySchema.safeParse(req.body);
    if (!bodyParse.success) {
      res.status(400).json({ error: bodyParse.error.issues[0]?.message ?? 'Invalid request' });
      return;
    }

    const parsed = loadAgendaJson(bodyParse.data.source);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    // Presenter resolution and append: resolveImportedPresenters /
    // applyImportedAgendaEntries (importAgendaEntries.ts).
    const resolved = await resolveImportedPresenters(user, meeting, parsed.data.entries);
    const counts = applyImportedAgendaEntries(meetingManager, meetingId, parsed.data.entries, resolved);

    // Bulk import — a single full-state emit is cheaper than firing an
    // `agenda:added` delta per imported entry.
    emitFullState(io, meetingManager, meetingId, appSettings);

    res.json({
      imported: counts.items,
      sessions: counts.sessions,
    });
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
      /** ISO timestamp when soft-deleted, or null when live. */
      deletedAt: string | null;
    }[] = [];

    // participantIds and lastConnectionTime live on the persisted meeting
    // state so they survive server restarts; currentConnections is live
    // socket-room state maintained in memory. Participant keys are resolved
    // to handles here so the client can render them without access to
    // the full meeting users map. Soft-deleted meetings are included so
    // the admin panel can render them (struck-through) and offer Restore.
    for (const meeting of meetingManager.listAll()) {
      const current = getActiveConnectionCount(meeting.id);
      meetings.push({
        id: meeting.id,
        createdAt: meeting.createdAt,
        // Handle for GitHub users; display name for handle-less providers
        // (Google/Microsoft/ORCID), so the admin tooltip never shows an opaque
        // `provider:accountId` key. Key only as a last resort if unresolved.
        participantUsernames: meeting.participantIds.map((key) => {
          const u = meeting.users[key];
          return u?.handle ?? u?.name ?? key;
        }),
        currentConnections: current,
        lastConnection: current > 0 ? 'now' : meeting.operational.lastConnectionTime,
        deletedAt: meeting.deletedAt ?? null,
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

  // Soft-delete a meeting (admin only). Marks the meeting as deleted —
  // it stays in the store (and on the admin list, struck-through) so it
  // can be restored, and the 90-day retention sweep eventually reaps it.
  // Any currently-connected sockets are evicted so they fall through to
  // the meeting page's not-found UI.
  router.delete('/admin/meetings/:id', async (req, res) => {
    const user = req.session.user;
    if (!user || !user.isAdmin) {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }

    const meetingId = req.params.id;
    const ok = await meetingManager.softDelete(meetingId);
    if (!ok) {
      // Either the meeting doesn't exist or it was already deleted —
      // surface as 404 in both cases.
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }

    // Boot anyone currently sitting in the room. `disconnectSockets(true)`
    // closes the underlying connection rather than just leaving the room,
    // so connected clients see their socket go away and the existing
    // disconnect / not-found UI handles the rest.
    io.in(meetingId).disconnectSockets(true);
    res.json({ ok: true });
  });

  // --- Premium-user list (admin only) ---
  // Runtime-managed replacement for the former `PREMIUM_USERNAMES` env
  // var. Add/remove operations persist eagerly through the
  // `AppSettingsManager` and trigger a scoped re-broadcast to any
  // meeting rooms the affected user is sitting in, so badges/glow flip
  // on/off live without a page refresh.

  router.get('/admin/premium-users', async (req, res) => {
    const user = req.session.user;
    if (!user || !user.isAdmin) {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }
    const response: PremiumUsersResponse = { users: await resolvePremiumUsers(appSettings.getPremiumUsernames()) };
    res.json(response);
  });

  router.post('/admin/premium-users', async (req, res) => {
    const user = req.session.user;
    if (!user || !user.isAdmin) {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }
    const parsed = PremiumUserBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
      return;
    }
    // `addPremiumUsername` returns the canonical form when a new row was
    // added, or null when the username was already present (idempotent —
    // admins double-clicking shouldn't see an error). We only broadcast
    // on an actual change so a repeated click doesn't generate spurious
    // socket traffic.
    const added = await appSettings.addPremiumUsername(parsed.data.username);
    if (added !== null) broadcastPremiumChange(io, meetingManager, appSettings, added);
    const response: PremiumUsersResponse = { users: await resolvePremiumUsers(appSettings.getPremiumUsernames()) };
    res.json({ ok: true, ...response });
  });

  router.delete('/admin/premium-users/:username', async (req, res) => {
    const user = req.session.user;
    if (!user || !user.isAdmin) {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }
    // Validate the path param through the same schema so an admin can't
    // remove garbage shapes. `decodeURIComponent` already happened in
    // Express's param parsing.
    const parsed = PremiumUserBodySchema.safeParse({ username: req.params.username });
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid username' });
      return;
    }
    // `removePremiumUsername` returns the canonical reference that was
    // removed (or null if it wasn't present); broadcast on an actual change.
    const removed = await appSettings.removePremiumUsername(parsed.data.username);
    if (removed !== null) broadcastPremiumChange(io, meetingManager, appSettings, removed);
    const response: PremiumUsersResponse = { users: await resolvePremiumUsers(appSettings.getPremiumUsernames()) };
    res.json({ ok: true, ...response });
  });

  // Restore a soft-deleted meeting (admin only). Clears `deletedAt`
  // and persists immediately so the meeting becomes joinable again on
  // the next refresh.
  router.post('/admin/meetings/:id/restore', async (req, res) => {
    const user = req.session.user;
    if (!user || !user.isAdmin) {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }

    const meetingId = req.params.id;
    const ok = await meetingManager.undelete(meetingId);
    if (!ok) {
      // 404 covers both "doesn't exist" and "wasn't deleted" — the
      // admin panel only surfaces Restore for rows it just saw with
      // a `deletedAt`, so either condition means the panel is stale.
      res.status(404).json({ error: 'Meeting not found or not deleted' });
      return;
    }
    res.json({ ok: true });
  });

  return router;
}
