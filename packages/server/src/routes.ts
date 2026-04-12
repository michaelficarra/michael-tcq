import { Router } from 'express';
import type { MeetingManager } from './meetings.js';

/**
 * REST routes for meeting management.
 *
 * POST /api/meetings   — Create a new meeting
 * GET  /api/meetings/:id — Get a meeting's current state
 * GET  /api/me         — Get the current authenticated user
 */
export function createMeetingRoutes(meetingManager: MeetingManager): Router {
  const router = Router();

  // Return the currently authenticated user from the session.
  router.get('/me', (req, res) => {
    const user = req.session.user;
    if (!user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    res.json(user);
  });

  // Create a new meeting. The request body should contain a `chairs` array
  // of GitHub usernames. For now (with mock auth), we resolve chair usernames
  // to simple User objects — real GitHub API validation comes in Step 9.
  router.post('/meetings', (req, res) => {
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

    // For now, create placeholder User objects from usernames.
    // The current user's full profile is used if their username is in the list.
    // TODO: Validate usernames against the GitHub API (Step 9/10).
    const chairs = chairUsernames.map((username) => {
      const trimmed = username.trim();
      if (trimmed === user.ghUsername) {
        return user;
      }
      return {
        ghid: 0,
        ghUsername: trimmed,
        name: trimmed,
        organisation: '',
      };
    });

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

  return router;
}
