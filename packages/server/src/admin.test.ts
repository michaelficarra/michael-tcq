import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import session from 'express-session';
import type { MeetingState, User } from '@tcq/shared';
import { userKey } from '@tcq/shared';
import type { MeetingStore } from './store.js';
import { MeetingManager } from './meetings.js';
import { createMeetingRoutes } from './routes.js';
import { toSessionUser } from './session.js';

/** A no-op in-memory store for tests. */
class InMemoryStore implements MeetingStore {
  private data = new Map<string, MeetingState>();
  async save(meeting: MeetingState) {
    this.data.set(meeting.id, structuredClone(meeting));
  }
  async load(meetingId: string) {
    return this.data.get(meetingId) ?? null;
  }
  async loadAll() {
    return [...this.data.values()];
  }
  async remove(meetingId: string) {
    this.data.delete(meetingId);
  }
}

/** The admin user for these tests. */
const ADMIN_USER: User = { ghid: 1, ghUsername: 'testadmin', name: 'Test Admin', organisation: '' };

/** Create a test app with session + routes, authenticated as a specific user. */
function createTestApp(meetingManager: MeetingManager, user: User = ADMIN_USER) {
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
  let baseUrl: string;
  let close: () => void;

  beforeEach(async () => {
    // Set the test user as an admin for these tests
    vi.stubEnv('ADMIN_USERNAMES', 'testadmin');

    manager = new MeetingManager(new InMemoryStore());
    const app = createTestApp(manager);
    ({ baseUrl, close } = await listen(app));

    return () => {
      close();
      vi.unstubAllEnvs();
    };
  });

  describe('GET /api/admin/meetings', () => {
    it('returns a list of active meetings for admins', async () => {
      // Create some meetings
      manager.create([{ ghid: 1, ghUsername: 'testuser', name: 'Test', organisation: '' }]);
      manager.create([{ ghid: 2, ghUsername: 'other', name: 'Other', organisation: '' }]);

      const res = await fetch(`${baseUrl}/api/admin/meetings`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toHaveLength(2);
      expect(body[0]).toHaveProperty('id');
      expect(body[0]).toHaveProperty('createdAt');
      expect(body[0]).toHaveProperty('participants');
      expect(body[0]).toHaveProperty('lastConnection');
    });

    it('records createdAt at meeting creation time', async () => {
      const before = new Date().toISOString();
      manager.create([{ ghid: 1, ghUsername: 'testuser', name: 'Test', organisation: '' }]);
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
  });

  describe('DELETE /api/admin/meetings/:id', () => {
    it('deletes a meeting', async () => {
      const meeting = manager.create([{ ghid: 1, ghUsername: 'testuser', name: 'Test', organisation: '' }]);

      const res = await fetch(`${baseUrl}/api/admin/meetings/${meeting.id}`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.ok).toBe(true);

      // Meeting should no longer exist
      expect(manager.has(meeting.id)).toBe(false);
    });

    it('returns 404 for non-existent meeting', async () => {
      const res = await fetch(`${baseUrl}/api/admin/meetings/no-such-meeting`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(404);
    });

    it('rejects non-admin users', async () => {
      vi.stubEnv('ADMIN_USERNAMES', 'someone-else');
      const meeting = manager.create([{ ghid: 1, ghUsername: 'testuser', name: 'Test', organisation: '' }]);

      const res = await fetch(`${baseUrl}/api/admin/meetings/${meeting.id}`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(403);

      // Meeting should still exist
      expect(manager.has(meeting.id)).toBe(true);
    });
  });

  describe('Admin chair editing privileges', () => {
    it('admin can edit chairs for a meeting they do not chair', async () => {
      // Create a meeting where testuser is NOT a chair
      const meeting = manager.create([
        {
          ghid: 99,
          ghUsername: 'chairperson',
          name: 'Chair',
          organisation: '',
        },
      ]);

      // Create via REST: switch user to testuser (admin), then update chairs
      // We test via the socket tests (socket.test.ts), but verify the manager accepts it
      const result = manager.updateChairs(meeting.id, [
        { ghid: 50, ghUsername: 'newchair', name: 'New Chair', organisation: '' },
      ]);
      expect(result).toBe(true);
      expect(manager.get(meeting.id)!.chairIds[0]).toBe(userKey({ ghUsername: 'newchair' }));
    });

    it('admin can set an empty chair list', async () => {
      const meeting = manager.create([
        {
          ghid: 1,
          ghUsername: 'testuser',
          name: 'Test',
          organisation: '',
        },
      ]);

      const result = manager.updateChairs(meeting.id, []);
      expect(result).toBe(true);
      expect(manager.get(meeting.id)!.chairIds).toHaveLength(0);
    });
  });

  describe('GET /api/me (admin flag)', () => {
    it('includes isAdmin: true for admin users', async () => {
      const res = await fetch(`${baseUrl}/api/me`);
      const body = await res.json();
      expect(body.isAdmin).toBe(true);
    });

    it('includes isAdmin: false for non-admin users', async () => {
      vi.stubEnv('ADMIN_USERNAMES', 'someone-else');
      const res = await fetch(`${baseUrl}/api/me`);
      const body = await res.json();
      expect(body.isAdmin).toBe(false);
    });
  });
});
