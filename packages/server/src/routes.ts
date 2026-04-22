import { Router } from 'express';
import type { Server } from 'socket.io';
import type { User, ClientToServerEvents, ServerToClientEvents } from '@tcq/shared';
import { CreateMeetingBodySchema, ImportAgendaBodySchema, SwitchUserBodySchema } from '@tcq/shared';
import type { MeetingManager } from './meetings.js';
import { fetchGitHubUser } from './auth.js';
import { isOAuthConfigured } from './mockAuth.js';
import { getAllMeetingStats, removeMeetingStats, broadcastMeetingState } from './socket.js';
import { parseAgendaMarkdown } from './parseAgenda.js';
import { toSessionUser } from './session.js';

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
    res.json({ ...user, mockAuth: !isOAuthConfigured() });
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

    // Create a new mock user with a deterministic ghid derived from
    // the username, so the same username always gets the same identity.
    let hash = 0;
    for (const ch of username) {
      hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
    }

    const user: User = {
      ghid: Math.abs(hash),
      ghUsername: username,
      name: username,
      organisation: '',
    };

    req.session.user = toSessionUser(user);
    delete req.session.mockLoggedOut;
    res.json(req.session.user);
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
        // Without OAuth, create a placeholder (mock auth mode)
        chairs.push({
          ghid: 0,
          ghUsername: username,
          name: username,
          organisation: '',
        });
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
      meetingManager.addAgendaItem(meetingId, item.name, presenters, item.timebox);
    }

    // Broadcast the updated state to all connected clients
    broadcastMeetingState(io, meetingManager, meetingId);

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

    const stats = getAllMeetingStats();
    const meetings: {
      id: string;
      chairCount: number;
      agendaItemCount: number;
      queuedSpeakerCount: number;
      maxConcurrent: number;
      currentConnections: number;
      lastConnection: string;
    }[] = [];

    // Iterate all meetings in the manager
    // (we need access to the meeting data, not just stats)
    for (const meeting of meetingManager.listAll()) {
      const s = stats.get(meeting.id);
      const current = s?.currentConnections ?? 0;
      meetings.push({
        id: meeting.id,
        chairCount: meeting.chairIds.length,
        agendaItemCount: meeting.agenda.length,
        queuedSpeakerCount: meeting.queue.orderedIds.length,
        maxConcurrent: s?.maxConcurrent ?? 0,
        currentConnections: current,
        lastConnection: current > 0 ? 'now' : (s?.lastConnection ?? ''),
      });
    }

    res.json(meetings);
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
    removeMeetingStats(meetingId);
    res.json({ ok: true });
  });

  return router;
}
