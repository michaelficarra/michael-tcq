import { Router } from 'express';
import type { User } from '@tcq/shared';
import type { MeetingManager } from './meetings.js';
import { fetchGitHubUser } from './auth.js';
import { isOAuthConfigured } from './mockAuth.js';
import { isAdmin } from './admin.js';
import { getAllMeetingStats, removeMeetingStats } from './socket.js';
import './session.js';

/**
 * REST routes for meeting management.
 *
 * POST /api/meetings    — Create a new meeting
 * GET  /api/meetings/:id — Get a meeting's current state
 * GET  /api/me          — Get the current authenticated user
 */
export function createMeetingRoutes(meetingManager: MeetingManager): Router {
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
    res.json({ ...user, mockAuth: !isOAuthConfigured(), isAdmin: isAdmin(user) });
  });

  // --- Dev-only: switch the mock user ---
  // Allows changing the logged-in identity during development without
  // OAuth. Only available when mock auth is active.
  router.post('/dev/switch-user', (req, res) => {
    if (isOAuthConfigured()) {
      res.status(404).json({ error: 'Not available' });
      return;
    }

    const { username } = req.body as { username?: string };
    const trimmed = username?.trim();
    if (!trimmed) {
      res.status(400).json({ error: 'Username is required' });
      return;
    }

    // Create a new mock user with a deterministic ghid derived from
    // the username, so the same username always gets the same identity.
    let hash = 0;
    for (const ch of trimmed) {
      hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
    }

    const user: User = {
      ghid: Math.abs(hash),
      ghUsername: trimmed,
      name: trimmed,
      organisation: '',
    };

    req.session.user = user;
    res.json(user);
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

    const { chairs: chairUsernames } = req.body as { chairs?: string[] };

    if (!Array.isArray(chairUsernames) || chairUsernames.length === 0) {
      res.status(400).json({ error: 'At least one chair username is required' });
      return;
    }

    // Resolve each username to a User object
    const chairs: User[] = [];
    for (const raw of chairUsernames) {
      const username = raw.trim();
      if (!username) continue;

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

  // --- Admin endpoints ---

  // List all active meetings with connection statistics.
  router.get('/admin/meetings', (req, res) => {
    const user = req.session.user;
    if (!user || !isAdmin(user)) {
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
      lastConnection: string;
    }[] = [];

    // Iterate all meetings in the manager
    // (we need access to the meeting data, not just stats)
    for (const meeting of meetingManager.listAll()) {
      const s = stats.get(meeting.id);
      meetings.push({
        id: meeting.id,
        chairCount: meeting.chairs.length,
        agendaItemCount: meeting.agenda.length,
        queuedSpeakerCount: meeting.queuedSpeakers.length,
        maxConcurrent: s?.maxConcurrent ?? 0,
        lastConnection: s?.currentConnections
          ? 'now'
          : s?.lastConnection ?? '',
      });
    }

    res.json(meetings);
  });

  // Delete a meeting (admin only).
  router.delete('/admin/meetings/:id', async (req, res) => {
    const user = req.session.user;
    if (!user || !isAdmin(user)) {
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
