import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import session from 'express-session';
import type { User } from '@tcq/shared';
import { asUserKey } from '@tcq/shared';
import { MeetingManager } from './meetings.js';
import { createMeetingRoutes } from './routes.js';
import { toSessionUser } from './session.js';
import { InMemoryStore } from './test/inMemoryStore.js';

/**
 * Helper: make a request to the Express app without starting a real HTTP server.
 * Uses the built-in fetch against a dynamically assigned port.
 */
const TEST_USER: User = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: '' };

function createTestApp(meetingManager: MeetingManager, user: User = TEST_USER) {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test', resave: false, saveUninitialized: false }));
  app.use((req, _res, next) => {
    if (!req.session.user) req.session.user = toSessionUser(user);
    next();
  });
  app.use('/api', createMeetingRoutes(meetingManager, { to: () => ({ emit: () => {} }) } as any));
  return app;
}

/** Start the app on a random port and return the base URL + close function. */
async function listen(app: express.Express): Promise<{ baseUrl: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        baseUrl: `http://localhost:${port}`,
        close: () => server.close(),
      });
    });
  });
}

describe('Meeting REST routes', () => {
  let manager: MeetingManager;
  let baseUrl: string;
  let close: () => void;

  beforeEach(async () => {
    manager = new MeetingManager(new InMemoryStore());
    const app = createTestApp(manager);
    ({ baseUrl, close } = await listen(app));

    // Return a cleanup that closes the server
    return () => close();
  });

  describe('GET /api/me', () => {
    it('returns the mock user', async () => {
      const res = await fetch(`${baseUrl}/api/me`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.ghUsername).toBe('testuser');
      expect(body.name).toBe('Test User');
    });
  });

  describe('POST /api/meetings', () => {
    it('creates a meeting and returns it with a word-based ID', async () => {
      const res = await fetch(`${baseUrl}/api/meetings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chairs: ['testuser'] }),
      });

      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.id).toMatch(/^[a-z]+(-[a-z]+)+$/);
      expect(body.chairIds).toHaveLength(1);
      expect(body.chairIds[0]).toBe('testuser');
      expect(body.agenda).toEqual([]);
      expect(body.queue.orderedIds).toEqual([]);
    });

    it('returns 400 when chairs is missing', async () => {
      const res = await fetch(`${baseUrl}/api/meetings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 when chairs is empty', async () => {
      const res = await fetch(`${baseUrl}/api/meetings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chairs: [] }),
      });

      expect(res.status).toBe(400);
    });

    // Users may copy GitHub-style `@handle` strings into the chair input;
    // the schema strips a leading `@` and surrounding whitespace so the
    // resolved chair matches the bare username.
    it('accepts a leading @ and surrounding whitespace on chair usernames', async () => {
      const res = await fetch(`${baseUrl}/api/meetings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chairs: [' @testuser ', '@ alice'] }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.chairIds).toEqual(['testuser', 'alice']);
    });
  });

  describe('GET /api/meetings/:id', () => {
    it('returns an existing meeting', async () => {
      // Create a meeting first
      const createRes = await fetch(`${baseUrl}/api/meetings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chairs: ['testuser'] }),
      });
      const created = await createRes.json();

      // Fetch it
      const res = await fetch(`${baseUrl}/api/meetings/${created.id}`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.id).toBe(created.id);
    });

    it('returns 404 for a non-existent meeting', async () => {
      const res = await fetch(`${baseUrl}/api/meetings/no-such-meeting`);
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/meetings/:id/log', () => {
    it('returns 404 for a non-existent meeting', async () => {
      const res = await fetch(`${baseUrl}/api/meetings/no-such-meeting/log`);
      expect(res.status).toBe(404);
    });

    it('returns the empty array and an empty-cursor ETag for a meeting with no log entries', async () => {
      const meeting = manager.create([{ ghid: 1, ghUsername: 'a', name: 'A', organisation: '' }]);
      const res = await fetch(`${baseUrl}/api/meetings/${meeting.id}/log`);
      expect(res.status).toBe(200);
      expect(res.headers.get('ETag')).toBe('""');
      expect(res.headers.get('Cache-Control')).toBe('private, must-revalidate');
      const body = await res.json();
      expect(body).toEqual([]);
    });

    it('returns all entries on a fresh fetch and exposes the latest id as the ETag', async () => {
      const meeting = manager.create([{ ghid: 1, ghUsername: 'a', name: 'A', organisation: '' }]);
      const e1 = await manager.appendLog(meeting.id, {
        type: 'meeting-started',
        timestamp: '2026-01-01T00:00:00.000Z',
        chairId: asUserKey('a'),
      });
      const e2 = await manager.appendLog(meeting.id, {
        type: 'agenda-item-started',
        timestamp: '2026-01-01T00:01:00.000Z',
        chairId: asUserKey('a'),
        itemName: 'First',
        itemPresenterIds: [asUserKey('a')],
      });

      const res = await fetch(`${baseUrl}/api/meetings/${meeting.id}/log`);
      expect(res.status).toBe(200);
      expect(res.headers.get('ETag')).toBe(`"${e2!.id}"`);
      const body = await res.json();
      expect(body).toHaveLength(2);
      expect(body[0].id).toBe(e1!.id);
      expect(body[1].id).toBe(e2!.id);
    });

    it('returns 304 when If-None-Match matches the current ETag', async () => {
      const meeting = manager.create([{ ghid: 1, ghUsername: 'a', name: 'A', organisation: '' }]);
      const entry = await manager.appendLog(meeting.id, {
        type: 'meeting-started',
        timestamp: '2026-01-01T00:00:00.000Z',
        chairId: asUserKey('a'),
      });

      const res = await fetch(`${baseUrl}/api/meetings/${meeting.id}/log`, {
        headers: { 'If-None-Match': `"${entry!.id}"` },
      });
      expect(res.status).toBe(304);
    });

    it('returns only entries after the cursor when ?since is provided', async () => {
      const meeting = manager.create([{ ghid: 1, ghUsername: 'a', name: 'A', organisation: '' }]);
      const e1 = await manager.appendLog(meeting.id, {
        type: 'meeting-started',
        timestamp: '2026-01-01T00:00:00.000Z',
        chairId: asUserKey('a'),
      });
      const e2 = await manager.appendLog(meeting.id, {
        type: 'agenda-item-started',
        timestamp: '2026-01-01T00:01:00.000Z',
        chairId: asUserKey('a'),
        itemName: 'First',
        itemPresenterIds: [asUserKey('a')],
      });

      const res = await fetch(`${baseUrl}/api/meetings/${meeting.id}/log?since=${e1!.id}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveLength(1);
      expect(body[0].id).toBe(e2!.id);
    });

    it('falls back to returning the full log when the ?since cursor is unknown', async () => {
      const meeting = manager.create([{ ghid: 1, ghUsername: 'a', name: 'A', organisation: '' }]);
      await manager.appendLog(meeting.id, {
        type: 'meeting-started',
        timestamp: '2026-01-01T00:00:00.000Z',
        chairId: asUserKey('a'),
      });

      const res = await fetch(`${baseUrl}/api/meetings/${meeting.id}/log?since=unknown-cursor`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveLength(1);
    });
  });

  describe('GET /api/users/autocomplete', () => {
    // The route delegates to githubDirectory.searchUsers; these tests
    // exercise the route plumbing (param parsing, meeting lookup, response
    // shape) rather than the directory's tier logic, which is covered by
    // githubDirectory.test.ts.

    it('returns mock-auth seed-list matches when OAuth is not configured', async () => {
      // No GITHUB_CLIENT_ID set in this test environment — the directory
      // takes the seed-list branch and skips the network entirely.
      const res = await fetch(`${baseUrl}/api/users/autocomplete?q=mike&limit=5`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.users)).toBe(true);
      // Each result must actually contain the query in login or name.
      for (const u of body.users) {
        expect(u.login.toLowerCase().includes('mike') || u.name.toLowerCase().includes('mike')).toBe(true);
      }
    });

    it('clamps limit to a sane window', async () => {
      // limit=999 must not cause a >25-result response.
      const res = await fetch(`${baseUrl}/api/users/autocomplete?q=&limit=999`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.users.length).toBeLessThanOrEqual(25);
    });

    it('still returns results when meetingId points to a missing meeting', async () => {
      // The route should treat a bogus meetingId as "no meeting context"
      // (tier 1 just becomes empty) rather than 404 — autocomplete is a
      // read-only suggestion endpoint, not a meeting-scoped action.
      const res = await fetch(`${baseUrl}/api/users/autocomplete?q=&meetingId=nope`);
      expect(res.status).toBe(200);
    });
  });
});
