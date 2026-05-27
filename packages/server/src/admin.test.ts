import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import session from 'express-session';
import type { User } from '@tcq/shared';
import { MeetingManager } from './meetings.js';
import { githubUser, githubUserKey } from './auth/githubUser.js';
import { createMeetingRoutes } from './routes.js';
import { toSessionUser } from './session.js';
import { error as logError, critical as logCritical } from './logger.js';
import { resetErrorBuffer } from './errorBuffer.js';
import { InMemoryStore } from './test/inMemoryStore.js';
import { AppSettingsManager } from './appSettingsManager.js';
import { InMemoryAppSettingsStore } from './test/inMemoryAppSettingsStore.js';

/** The admin user for these tests. */
const ADMIN_USER: User = githubUser({ login: 'testadmin', name: 'Test Admin' });

/** Capture of the meeting room ids whose sockets were forcibly disconnected
 *  by the admin DELETE handler. Reset per test via the beforeEach. */
const disconnectedRooms: string[] = [];

/** Create a test app with session + routes, authenticated as a specific user. */
function createTestApp(meetingManager: MeetingManager, appSettings: AppSettingsManager, user: User = ADMIN_USER) {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test', resave: false, saveUninitialized: false }));
  app.use((req, _res, next) => {
    if (!req.session.user) req.session.user = toSessionUser(user);
    next();
  });
  // Mock Socket.IO server: `.to(...)` is used by emit paths and `.in(...)`
  // by the soft-delete handler to evict sockets — both must exist on the
  // stub even though the tests assert against the captured side-effects.
  const io = {
    to: () => ({ emit: () => {} }),
    in: (roomId: string) => ({
      disconnectSockets: () => {
        disconnectedRooms.push(roomId);
      },
    }),
  };
  app.use('/api', createMeetingRoutes(meetingManager, io as any, appSettings));
  return app;
}

async function listen(app: express.Express) {
  return new Promise<{ baseUrl: string; close: () => void }>((resolve) => {
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

describe('Admin endpoints', () => {
  let manager: MeetingManager;
  let appSettings: AppSettingsManager;
  let baseUrl: string;
  let close: () => void;

  beforeEach(async () => {
    // Set the test user as an admin for these tests
    vi.stubEnv('ADMIN_USERNAMES', 'testadmin');

    manager = new MeetingManager(new InMemoryStore());
    appSettings = new AppSettingsManager(new InMemoryAppSettingsStore());
    disconnectedRooms.length = 0;
    const app = createTestApp(manager, appSettings);
    ({ baseUrl, close } = await listen(app));

    return () => {
      close();
      vi.unstubAllEnvs();
    };
  });

  describe('GET /api/admin/meetings', () => {
    it('returns a list of active meetings for admins', async () => {
      // Create some meetings
      manager.create([githubUser({ login: 'testuser', name: 'Test', organisation: '' })]);
      manager.create([githubUser({ login: 'other', name: 'Other', organisation: '' })]);

      const res = await fetch(`${baseUrl}/api/admin/meetings`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toHaveLength(2);
      expect(body[0]).toHaveProperty('id');
      expect(body[0]).toHaveProperty('createdAt');
      expect(body[0]).toHaveProperty('participantUsernames');
      expect(Array.isArray(body[0].participantUsernames)).toBe(true);
      expect(body[0]).toHaveProperty('lastConnection');
    });

    it('records createdAt at meeting creation time', async () => {
      const before = new Date().toISOString();
      manager.create([githubUser({ login: 'testuser', name: 'Test', organisation: '' })]);
      const after = new Date().toISOString();

      const res = await fetch(`${baseUrl}/api/admin/meetings`);
      const body = await res.json();

      expect(body[0].createdAt).toBeTruthy();
      // createdAt should fall within the bracket around the create() call.
      expect(body[0].createdAt >= before).toBe(true);
      expect(body[0].createdAt <= after).toBe(true);
    });

    it('returns empty array when no meetings exist', async () => {
      const res = await fetch(`${baseUrl}/api/admin/meetings`);
      const body = await res.json();
      expect(body).toEqual([]);
    });

    it('rejects non-admin users', async () => {
      // Change admin to someone else
      vi.stubEnv('ADMIN_USERNAMES', 'someone-else');

      const res = await fetch(`${baseUrl}/api/admin/meetings`);
      expect(res.status).toBe(403);
    });

    it('includes soft-deleted meetings with a `deletedAt` timestamp', async () => {
      // Live meeting reports deletedAt: null; deleted meeting reports
      // the ISO timestamp of the soft-delete so the admin UI can render
      // it with strikethrough + a Restore button.
      const live = manager.create([githubUser({ login: 'testuser', name: 'Test', organisation: '' })]);
      const deleted = manager.create([githubUser({ login: 'other', name: 'Other', organisation: '' })]);
      await manager.softDelete(deleted.id);

      const res = await fetch(`${baseUrl}/api/admin/meetings`);
      const body = await res.json();
      const liveRow = body.find((m: { id: string }) => m.id === live.id);
      const deletedRow = body.find((m: { id: string }) => m.id === deleted.id);
      expect(liveRow.deletedAt).toBeNull();
      expect(deletedRow.deletedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe('DELETE /api/admin/meetings/:id', () => {
    it('soft-deletes a meeting (stays in memory with deletedAt set)', async () => {
      const meeting = manager.create([githubUser({ login: 'testuser', name: 'Test', organisation: '' })]);

      const res = await fetch(`${baseUrl}/api/admin/meetings/${meeting.id}`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(200);
      expect((await res.json()).ok).toBe(true);

      // Soft delete: meeting remains in memory but is flagged.
      expect(manager.has(meeting.id)).toBe(true);
      expect(manager.isDeleted(meeting.id)).toBe(true);
      expect(manager.get(meeting.id)!.deletedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('evicts active sockets when a meeting is deleted', async () => {
      // The handler calls io.in(meetingId).disconnectSockets(true) to
      // boot anyone sitting in the room so they fall through to the
      // not-found UI. We capture the targeted room id via the io mock.
      const meeting = manager.create([githubUser({ login: 'testuser', name: 'Test', organisation: '' })]);

      await fetch(`${baseUrl}/api/admin/meetings/${meeting.id}`, { method: 'DELETE' });

      expect(disconnectedRooms).toEqual([meeting.id]);
    });

    it('returns 404 for non-existent meeting', async () => {
      const res = await fetch(`${baseUrl}/api/admin/meetings/no-such-meeting`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(404);
    });

    it('returns 404 when the meeting is already soft-deleted', async () => {
      // The admin UI only offers Restore for already-deleted rows, so
      // hitting DELETE twice in a row only happens when the panel is
      // stale — 404 nudges the caller to refresh.
      const meeting = manager.create([githubUser({ login: 'testuser', name: 'Test', organisation: '' })]);
      await manager.softDelete(meeting.id);

      const res = await fetch(`${baseUrl}/api/admin/meetings/${meeting.id}`, { method: 'DELETE' });
      expect(res.status).toBe(404);
    });

    it('rejects non-admin users', async () => {
      vi.stubEnv('ADMIN_USERNAMES', 'someone-else');
      const meeting = manager.create([githubUser({ login: 'testuser', name: 'Test', organisation: '' })]);

      const res = await fetch(`${baseUrl}/api/admin/meetings/${meeting.id}`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(403);

      // Meeting should still exist and not be flagged deleted
      expect(manager.has(meeting.id)).toBe(true);
      expect(manager.isDeleted(meeting.id)).toBe(false);
    });
  });

  describe('POST /api/admin/meetings/:id/restore', () => {
    it('clears deletedAt and makes the meeting joinable again', async () => {
      const meeting = manager.create([githubUser({ login: 'testuser', name: 'Test', organisation: '' })]);
      await manager.softDelete(meeting.id);
      expect(manager.isDeleted(meeting.id)).toBe(true);

      const res = await fetch(`${baseUrl}/api/admin/meetings/${meeting.id}/restore`, {
        method: 'POST',
      });
      expect(res.status).toBe(200);
      expect((await res.json()).ok).toBe(true);
      expect(manager.isDeleted(meeting.id)).toBe(false);
      expect(manager.get(meeting.id)!.deletedAt).toBeUndefined();
    });

    it('returns 404 for a meeting that is not soft-deleted', async () => {
      // Restoring a live meeting is a no-op signal that the admin
      // panel is stale; 404 nudges it to refresh, same as restoring a
      // meeting that doesn't exist.
      const meeting = manager.create([githubUser({ login: 'testuser', name: 'Test', organisation: '' })]);

      const res = await fetch(`${baseUrl}/api/admin/meetings/${meeting.id}/restore`, {
        method: 'POST',
      });
      expect(res.status).toBe(404);
    });

    it('returns 404 for a non-existent meeting', async () => {
      const res = await fetch(`${baseUrl}/api/admin/meetings/no-such-meeting/restore`, {
        method: 'POST',
      });
      expect(res.status).toBe(404);
    });

    it('rejects non-admin users', async () => {
      vi.stubEnv('ADMIN_USERNAMES', 'someone-else');
      const meeting = manager.create([githubUser({ login: 'testuser', name: 'Test', organisation: '' })]);
      await manager.softDelete(meeting.id);

      const res = await fetch(`${baseUrl}/api/admin/meetings/${meeting.id}/restore`, {
        method: 'POST',
      });
      expect(res.status).toBe(403);
      expect(manager.isDeleted(meeting.id)).toBe(true);
    });
  });

  describe('Admin chair editing privileges', () => {
    it('admin can edit chairs for a meeting they do not chair', async () => {
      // Create a meeting where testuser is NOT a chair
      const meeting = manager.create([githubUser({ login: 'chairperson', name: 'Chair', organisation: '' })]);

      // Create via REST: switch user to testuser (admin), then update chairs
      // We test via the socket tests (socket.test.ts), but verify the manager accepts it
      const result = manager.updateChairs(meeting.id, [
        githubUser({ login: 'newchair', name: 'New Chair', organisation: '' }),
      ]);
      expect(result).toBe(true);
      expect(manager.get(meeting.id)!.chairIds[0]).toBe(githubUserKey('newchair'));
    });

    it('admin can set an empty chair list', async () => {
      const meeting = manager.create([githubUser({ login: 'testuser', name: 'Test', organisation: '' })]);

      const result = manager.updateChairs(meeting.id, []);
      expect(result).toBe(true);
      expect(manager.get(meeting.id)!.chairIds).toHaveLength(0);
    });
  });

  describe('GET /api/admin/diagnostics', () => {
    // The diagnostics endpoint mirrors recent error logs through the
    // shared errorBuffer module — reset between tests so cross-test
    // pollution can't make assertions about counts flake.
    beforeEach(() => {
      resetErrorBuffer();
      // Suppress real stdout writes so test output stays clean while
      // exercising the logger → errorBuffer pipeline.
      vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    it('rejects non-admin users with 403', async () => {
      vi.stubEnv('ADMIN_USERNAMES', 'someone-else');
      const res = await fetch(`${baseUrl}/api/admin/diagnostics`);
      expect(res.status).toBe(403);
    });

    it('returns the expected shape for admin users', async () => {
      const res = await fetch(`${baseUrl}/api/admin/diagnostics`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toMatchObject({
        process: {
          uptimeSeconds: expect.any(Number),
          cpuSeconds: expect.any(Number),
          nodeVersion: expect.any(String),
          memory: {
            rss: expect.any(Number),
            heapUsed: expect.any(Number),
            heapTotal: expect.any(Number),
            external: expect.any(Number),
          },
        },
        meetings: {
          totalActive: 0,
          totalParticipants: 0,
          totalConnections: 0,
        },
        sockets: {
          totalClients: expect.any(Number),
          stateResyncs: expect.any(Number),
        },
        http: {
          total: expect.any(Number),
          clientErrors: expect.any(Number),
          serverErrors: expect.any(Number),
        },
        persistence: {
          lastSyncSucceededAt: null,
          lastSyncFailedAt: null,
          lastSyncError: null,
          dirtyCount: expect.any(Number),
        },
        errors: {
          totalSinceStart: expect.any(Number),
          recent: expect.any(Array),
        },
      });
      // gitSha is null when unset, string when set — never undefined.
      expect(body.process.gitSha === null || typeof body.process.gitSha === 'string').toBe(true);
    });

    it('aggregates active meetings', async () => {
      manager.create([githubUser({ login: 'a', name: 'A', organisation: '' })]);
      manager.create([
        githubUser({ login: 'b', name: 'B', organisation: '' }),
        githubUser({ login: 'c', name: 'C', organisation: '' }),
      ]);

      const body = await (await fetch(`${baseUrl}/api/admin/diagnostics`)).json();
      expect(body.meetings.totalActive).toBe(2);
      // participantIds is populated by socket joins, not by meeting
      // creation, so without a real socket the count stays at 0.
      expect(body.meetings.totalParticipants).toBe(0);
      expect(body.meetings.totalConnections).toBe(0);
    });

    it('surfaces logged ERROR/CRITICAL entries through the diagnostics endpoint', async () => {
      logError('http_request_error', { error: { message: 'simulated failure' } });
      logCritical('process_panic');

      const body = await (await fetch(`${baseUrl}/api/admin/diagnostics`)).json();
      expect(body.errors.totalSinceStart).toBe(2);
      expect(body.errors.recent).toHaveLength(2);
      // Newest-first ordering.
      expect(body.errors.recent[0].message).toBe('process_panic');
      expect(body.errors.recent[0].severity).toBe('CRITICAL');
      expect(body.errors.recent[1].message).toBe('http_request_error');
      expect(body.errors.recent[1].detail).toBe('simulated failure');
    });
  });

  describe('GET /api/me (admin flag)', () => {
    it('includes isAdmin: true for admin users', async () => {
      const res = await fetch(`${baseUrl}/api/me`);
      const body = await res.json();
      expect(body.isAdmin).toBe(true);
    });

    it('omits isAdmin entirely for non-admin users', async () => {
      // Mirrors the isPremium pattern: the field is only present when
      // true, never explicitly `false`, so the common case carries no
      // overhead on the wire. Client treats absence as falsy.
      vi.stubEnv('ADMIN_USERNAMES', 'someone-else');
      const res = await fetch(`${baseUrl}/api/me`);
      const body = await res.json();
      expect('isAdmin' in body).toBe(false);
    });
  });

  describe('GET /api/me (premium flag)', () => {
    it('includes isPremium: true when the user is in the admin-managed premium list', async () => {
      // The user menu (UserBadge) renders the premium mark only when
      // /api/me reports isPremium:true on the authed user, so this is
      // the wire-level invariant that lets the badge appear next to the
      // logged-in user's own name.
      await appSettings.addPremiumUsername('testadmin');
      const res = await fetch(`${baseUrl}/api/me`);
      const body = await res.json();
      expect(body.isPremium).toBe(true);
    });

    it('omits isPremium entirely for non-premium users', async () => {
      // Same omit-when-false convention as isAdmin.
      await appSettings.addPremiumUsername('someone-else');
      const res = await fetch(`${baseUrl}/api/me`);
      const body = await res.json();
      expect('isPremium' in body).toBe(false);
    });
  });

  describe('Premium-user admin endpoints', () => {
    describe('GET /api/admin/premium-users', () => {
      it('returns an empty list when nothing has been added', async () => {
        const res = await fetch(`${baseUrl}/api/admin/premium-users`);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual({ usernames: [] });
      });

      it('returns the persisted list, sorted lexicographically', async () => {
        // Seed in non-alphabetical order to verify the manager sorts on
        // output. The client relies on a stable order so its local
        // optimistic state stays in sync with the canonical list.
        await appSettings.addPremiumUsername('charlie');
        await appSettings.addPremiumUsername('alice');
        await appSettings.addPremiumUsername('bob');
        const res = await fetch(`${baseUrl}/api/admin/premium-users`);
        const body = await res.json();
        expect(body).toEqual({ usernames: ['github:alice', 'github:bob', 'github:charlie'] });
      });

      it('returns 403 for non-admin users', async () => {
        // Mint a new test app with a non-admin caller; share the same
        // managers so settings persisted above still apply.
        const nonAdmin: User = githubUser({ login: 'plain-jane', name: 'Jane', organisation: '' });
        const otherApp = createTestApp(manager, appSettings, nonAdmin);
        const { baseUrl: otherUrl, close: closeOther } = await listen(otherApp);
        try {
          const res = await fetch(`${otherUrl}/api/admin/premium-users`);
          expect(res.status).toBe(403);
        } finally {
          closeOther();
        }
      });
    });

    describe('POST /api/admin/premium-users', () => {
      it('adds a username, persists, and returns the updated list', async () => {
        const res = await fetch(`${baseUrl}/api/admin/premium-users`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'NewPremium' }),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.ok).toBe(true);
        // Stored canonically — lowercased and expanded to a `github:` key.
        expect(body.usernames).toEqual(['github:newpremium']);
        // Manager reflects the same state — confirms it went through
        // the manager, not just bounced off the HTTP layer.
        expect(appSettings.getPremiumUsernames()).toEqual(['github:newpremium']);
      });

      it('is idempotent — re-adding an existing username succeeds without duplication', async () => {
        await appSettings.addPremiumUsername('alice');
        const res = await fetch(`${baseUrl}/api/admin/premium-users`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'alice' }),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.usernames).toEqual(['github:alice']);
      });

      it('normalises @-prefix and surrounding whitespace before validating', async () => {
        const res = await fetch(`${baseUrl}/api/admin/premium-users`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: '  @ Alice ' }),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.usernames).toEqual(['github:alice']);
      });

      it('returns 400 for an empty username', async () => {
        const res = await fetch(`${baseUrl}/api/admin/premium-users`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: '   ' }),
        });
        expect(res.status).toBe(400);
      });

      it('returns 400 for a username with invalid characters', async () => {
        const res = await fetch(`${baseUrl}/api/admin/premium-users`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'invalid_underscore' }),
        });
        expect(res.status).toBe(400);
      });

      it('returns 400 for a username longer than the GitHub limit', async () => {
        const res = await fetch(`${baseUrl}/api/admin/premium-users`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'a'.repeat(40) }),
        });
        expect(res.status).toBe(400);
      });

      it('returns 403 for non-admin users', async () => {
        const nonAdmin: User = githubUser({ login: 'plain-jane', name: 'Jane', organisation: '' });
        const otherApp = createTestApp(manager, appSettings, nonAdmin);
        const { baseUrl: otherUrl, close: closeOther } = await listen(otherApp);
        try {
          const res = await fetch(`${otherUrl}/api/admin/premium-users`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'jane-doe' }),
          });
          expect(res.status).toBe(403);
        } finally {
          closeOther();
        }
      });
    });

    describe('DELETE /api/admin/premium-users/:username', () => {
      it('removes a username and returns the updated list', async () => {
        await appSettings.addPremiumUsername('alice');
        await appSettings.addPremiumUsername('bob');
        const res = await fetch(`${baseUrl}/api/admin/premium-users/alice`, { method: 'DELETE' });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.ok).toBe(true);
        expect(body.usernames).toEqual(['github:bob']);
        expect(appSettings.getPremiumUsernames()).toEqual(['github:bob']);
      });

      it('is idempotent — deleting a username not in the list returns 200', async () => {
        const res = await fetch(`${baseUrl}/api/admin/premium-users/never-was-here`, { method: 'DELETE' });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.usernames).toEqual([]);
      });

      it('returns 400 when the path param fails validation', async () => {
        // A path-encoded invalid username (`%21` is `!`) — the route
        // validates after decoding via the same schema as POST.
        const res = await fetch(`${baseUrl}/api/admin/premium-users/bad%21name`, { method: 'DELETE' });
        expect(res.status).toBe(400);
      });

      it('returns 403 for non-admin users', async () => {
        await appSettings.addPremiumUsername('alice');
        const nonAdmin: User = githubUser({ login: 'plain-jane', name: 'Jane', organisation: '' });
        const otherApp = createTestApp(manager, appSettings, nonAdmin);
        const { baseUrl: otherUrl, close: closeOther } = await listen(otherApp);
        try {
          const res = await fetch(`${otherUrl}/api/admin/premium-users/alice`, { method: 'DELETE' });
          expect(res.status).toBe(403);
          // Sanity: server-side list unchanged.
          expect(appSettings.getPremiumUsernames()).toEqual(['github:alice']);
        } finally {
          closeOther();
        }
      });
    });
  });
});
