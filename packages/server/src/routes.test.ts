import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import session from 'express-session';
import type { User } from '@tcq/shared';
import { asUserKey, userKey } from '@tcq/shared';
import { MeetingManager } from './meetings.js';
import { githubUser } from './auth/githubUser.js';
import { googleUser } from './auth/googleUser.js';
import { mockUserFromLogin } from './mockUser.js';
import { createMeetingRoutes } from './routes.js';
import { toSessionUser } from './session.js';
import { setFetchForTesting, resetDirectoryForTesting } from './githubDirectory.js';
import { InMemoryStore } from './test/inMemoryStore.js';
import { AppSettingsManager } from './appSettingsManager.js';
import { InMemoryAppSettingsStore } from './test/inMemoryAppSettingsStore.js';
import * as socket from './socket.js';

/** Shared no-op AppSettingsManager for tests that don't exercise premium flow. */
function emptyAppSettings(): AppSettingsManager {
  return new AppSettingsManager(new InMemoryAppSettingsStore());
}

/**
 * Helper: make a request to the Express app without starting a real HTTP server.
 * Uses the built-in fetch against a dynamically assigned port.
 */
const TEST_USER: User = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: '' });

/**
 * Mirror of the directory's match check (case-insensitive exact / prefix
 * / substring / subsequence across login, name, organisation). Used by
 * the autocomplete-route assertion so it doesn't have to know which
 * specific match class fired.
 */
function scoresAgainstQuery(q: string, login: string, name: string, organisation: string): boolean {
  const ql = q.toLowerCase();
  const fields = [login.toLowerCase(), name.toLowerCase(), organisation.toLowerCase()];
  for (const f of fields) {
    if (f.length === 0) continue;
    if (f === ql || f.startsWith(ql) || f.includes(ql)) return true;
    let i = 0;
    for (let j = 0; j < f.length && i < ql.length; j++) if (f[j] === ql[i]) i++;
    if (i === ql.length) return true;
  }
  return false;
}

function createTestApp(meetingManager: MeetingManager, user: User = TEST_USER) {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test', resave: false, saveUninitialized: false }));
  app.use((req, _res, next) => {
    if (!req.session.user) req.session.user = toSessionUser(user);
    next();
  });
  app.use(
    '/api',
    createMeetingRoutes(
      meetingManager,
      {
        to: () => ({ emit: () => {} }),
        in: () => ({ disconnectSockets: () => {} }),
      } as any,
      emptyAppSettings(),
    ),
  );
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
      expect(body.handle).toBe('testuser');
      expect(body.name).toBe('Test User');
    });
  });

  describe('POST /api/meetings', () => {
    it('creates a meeting and returns it with a word-based ID', async () => {
      const res = await fetch(`${baseUrl}/api/meetings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chairs: [{ handle: 'testuser' }] }),
      });

      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.id).toMatch(/^[a-z]+(-[a-z]+)+$/);
      expect(body.chairIds).toHaveLength(1);
      // The lone chair `testuser` matches the session user, so the stored
      // key is the session user's numeric-id key.
      expect(body.chairIds[0]).toBe(userKey(TEST_USER));
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
        body: JSON.stringify({ chairs: [{ handle: ' @testuser ' }, { handle: '@ alice' }] }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      // `testuser` resolves to the session user; `alice` (not the session
      // user, mock-auth mode) resolves via the seed-aware mock helper to a
      // numeric-id key.
      expect(body.chairIds).toEqual([userKey(TEST_USER), userKey(mockUserFromLogin('alice'))]);
    });
  });

  describe('GET /api/meetings/:id', () => {
    it('returns an existing meeting', async () => {
      // Create a meeting first
      const createRes = await fetch(`${baseUrl}/api/meetings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chairs: [{ handle: 'testuser' }] }),
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

    it('returns 404 for a soft-deleted meeting', async () => {
      // Soft-deleted meetings are indistinguishable from never-existed
      // ones to non-admin callers — same 404 status, no leak of the id.
      const meeting = manager.create([TEST_USER]);
      await manager.softDelete(meeting.id);

      const res = await fetch(`${baseUrl}/api/meetings/${meeting.id}`);
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/my-meetings', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('returns 401 when unauthenticated', async () => {
      // Build a parallel app without the auto-login middleware so the
      // session has no user attached.
      const app = express();
      app.use(express.json());
      app.use(session({ secret: 'test', resave: false, saveUninitialized: false }));
      app.use(
        '/api',
        createMeetingRoutes(
          manager,
          {
            to: () => ({ emit: () => {} }),
            in: () => ({ disconnectSockets: () => {} }),
          } as any,
          emptyAppSettings(),
        ),
      );
      const { baseUrl: noAuthUrl, close: noAuthClose } = await listen(app);
      try {
        const res = await fetch(`${noAuthUrl}/api/my-meetings`);
        expect(res.status).toBe(401);
      } finally {
        noAuthClose();
      }
    });

    it('returns meetings where the caller is a chair', async () => {
      const meeting = manager.create([TEST_USER]);
      const res = await fetch(`${baseUrl}/api/my-meetings`);
      expect(res.status).toBe(200);
      const body = await res.json();
      // No one has connected yet, so lastActivity is the empty-string sentinel
      // (which the client renders as "never").
      expect(body).toEqual([{ id: meeting.id, lastActivity: '', currentConnections: 0 }]);
    });

    it('returns meetings where the caller appears only in meeting.users (e.g. as a presenter)', async () => {
      // A different user is the chair; the caller is added separately to
      // `users` to model "named on an agenda item" without ever joining.
      const other: User = githubUser({ id: 2, login: 'other', name: 'Other', organisation: '' });
      const meeting = manager.create([other]);
      meeting.users[userKey(TEST_USER)] = TEST_USER;

      const res = await fetch(`${baseUrl}/api/my-meetings`);
      const body = await res.json();
      expect(body).toEqual([{ id: meeting.id, lastActivity: '', currentConnections: 0 }]);
    });

    it('returns meetings where the caller appears only in participantIds', async () => {
      // Caller is not in `users` (so not a chair/presenter/queued user) but
      // is recorded as having joined via socket. Guarantees the
      // participantIds branch of the filter is exercised.
      const other: User = githubUser({ id: 2, login: 'other', name: 'Other', organisation: '' });
      const meeting = manager.create([other]);
      meeting.participantIds.push(userKey(TEST_USER));

      const res = await fetch(`${baseUrl}/api/my-meetings`);
      const body = await res.json();
      expect(body).toEqual([{ id: meeting.id, lastActivity: '', currentConnections: 0 }]);
    });

    it('excludes meetings where the caller is unrelated', async () => {
      const other: User = githubUser({ id: 2, login: 'other', name: 'Other', organisation: '' });
      manager.create([other]);

      const res = await fetch(`${baseUrl}/api/my-meetings`);
      const body = await res.json();
      expect(body).toEqual([]);
    });

    it('reports lastActivity as "now" with the live count when at least one socket is connected', async () => {
      const meeting = manager.create([TEST_USER]);
      vi.spyOn(socket, 'getActiveConnectionCount').mockImplementation((id) => (id === meeting.id ? 3 : 0));

      const res = await fetch(`${baseUrl}/api/my-meetings`);
      const body = await res.json();
      expect(body).toEqual([{ id: meeting.id, lastActivity: 'now', currentConnections: 3 }]);
    });

    it('reports lastActivity as the persisted last-connection ISO timestamp when idle', async () => {
      const meeting = manager.create([TEST_USER]);
      meeting.operational.lastConnectionTime = '2026-01-02T03:04:05.000Z';

      const res = await fetch(`${baseUrl}/api/my-meetings`);
      const body = await res.json();
      expect(body).toEqual([{ id: meeting.id, lastActivity: '2026-01-02T03:04:05.000Z', currentConnections: 0 }]);
    });

    it('hides soft-deleted meetings even when the caller is associated with them', async () => {
      // A meeting the caller chairs disappears from My Meetings the
      // instant it is soft-deleted by an admin.
      const live = manager.create([TEST_USER]);
      const deleted = manager.create([TEST_USER]);
      await manager.softDelete(deleted.id);

      const res = await fetch(`${baseUrl}/api/my-meetings`);
      const body = await res.json();
      expect(body.map((m: { id: string }) => m.id)).toEqual([live.id]);
    });

    it('sorts in-progress meetings ahead of idle ones, idle ones by recency', async () => {
      const stale = manager.create([TEST_USER]);
      stale.operational.lastConnectionTime = '2026-01-01T00:00:00.000Z';
      const recent = manager.create([TEST_USER]);
      recent.operational.lastConnectionTime = '2026-02-01T00:00:00.000Z';
      const active = manager.create([TEST_USER]);
      vi.spyOn(socket, 'getActiveConnectionCount').mockImplementation((id) => (id === active.id ? 2 : 0));

      const res = await fetch(`${baseUrl}/api/my-meetings`);
      const body = await res.json();
      expect(body.map((m: { id: string }) => m.id)).toEqual([active.id, recent.id, stale.id]);
    });
  });

  describe('GET /api/meetings/:id/log', () => {
    it('returns 404 for a non-existent meeting', async () => {
      const res = await fetch(`${baseUrl}/api/meetings/no-such-meeting/log`);
      expect(res.status).toBe(404);
    });

    it('returns 404 for a soft-deleted meeting', async () => {
      const meeting = manager.create([TEST_USER]);
      await manager.softDelete(meeting.id);

      const res = await fetch(`${baseUrl}/api/meetings/${meeting.id}/log`);
      expect(res.status).toBe(404);
    });

    it('returns the empty array and an empty-cursor ETag for a meeting with no log entries', async () => {
      const meeting = manager.create([githubUser({ id: 10, login: 'a', name: 'A', organisation: '' })]);
      const res = await fetch(`${baseUrl}/api/meetings/${meeting.id}/log`);
      expect(res.status).toBe(200);
      expect(res.headers.get('ETag')).toBe('""');
      expect(res.headers.get('Cache-Control')).toBe('private, must-revalidate');
      const body = await res.json();
      expect(body).toEqual([]);
    });

    it('returns all entries on a fresh fetch and exposes the latest id as the ETag', async () => {
      const meeting = manager.create([githubUser({ id: 10, login: 'a', name: 'A', organisation: '' })]);
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
      const meeting = manager.create([githubUser({ id: 10, login: 'a', name: 'A', organisation: '' })]);
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
      const meeting = manager.create([githubUser({ id: 10, login: 'a', name: 'A', organisation: '' })]);
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
      const meeting = manager.create([githubUser({ id: 10, login: 'a', name: 'A', organisation: '' })]);
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

  describe('POST /api/meetings/:id/import-agenda', () => {
    /**
     * Test environment runs without GITHUB_CLIENT_ID set, so the directory
     * resolver takes the mock-auth branch: tier 1 = the meeting's `users`
     * map, tier 2 = the static DEV_USERS seed list. We exercise both tiers
     * here without any network mocking — except for intercepting the route's
     * own outbound `fetch` of the markdown URL, which we do with a wrapper
     * around `globalThis.fetch` so the inner test-server request keeps
     * working unchanged.
     */
    const fixtureUrl = 'https://test-fixture.invalid/agenda.md';
    let fixtureBody = '';
    const realFetch = globalThis.fetch;

    beforeEach(() => {
      fixtureBody = '';
      globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : (input as URL | Request).toString();
        if (url === fixtureUrl) {
          return Promise.resolve(
            new Response(fixtureBody, {
              status: 200,
              headers: { 'Content-Type': 'text/markdown' },
            }),
          );
        }
        return realFetch(input as never, init);
      }) as typeof fetch;
    });

    afterEach(() => {
      globalThis.fetch = realFetch;
    });

    /**
     * Create a meeting where TEST_USER (`testuser`, ghid 1) is the chair so
     * the import endpoint accepts the request. Optionally seed extra users
     * into the meeting's `users` map to give tier 1 something to match.
     */
    function createMeetingWith(extraUsers: User[] = []): string {
      const meeting = manager.create([TEST_USER, ...extraUsers]);
      // `create` makes every input a chair; trim back to just testuser so
      // chair membership is tested explicitly.
      manager.updateChairs(meeting.id, [TEST_USER]);
      return meeting.id;
    }

    async function importAgenda(meetingId: string, body: string, options: { slotIntoSessions?: boolean } = {}) {
      fixtureBody = body;
      const res = await fetch(`${baseUrl}/api/meetings/${meetingId}/import-agenda`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: fixtureUrl,
          ...(options.slotIntoSessions ? { slotIntoSessions: true } : {}),
        }),
      });
      return res;
    }

    async function getMeeting(meetingId: string) {
      const res = await fetch(`${baseUrl}/api/meetings/${meetingId}`);
      expect(res.status).toBe(200);
      return res.json();
    }

    /** Pull the `User` record stored against an agenda item's first presenter. */
    function firstPresenter(meeting: any, itemIndex: number): User {
      const item = meeting.agenda[itemIndex];
      const key = item.presenterIds[0];
      return meeting.users[key];
    }

    it('returns 404 for a soft-deleted meeting', async () => {
      // Even a chair can't import into a deleted meeting — the
      // endpoint matches the "not found" behaviour of GET /meetings/:id
      // so callers can't keep operating on a tombstoned record.
      const id = createMeetingWith();
      await manager.softDelete(id);

      const res = await importAgenda(id, '| Topic |\n|---|\n| Hello |');
      expect(res.status).toBe(404);
    });

    it('resolves a unique tier-2 (DEV_USERS) name to the real user', async () => {
      // "Daniel Ehrenberg" is exactly one DEV_USERS entry (login littledan).
      const meetingId = createMeetingWith();
      const md = [
        '## Agenda Items',
        '',
        '| Topic | Presenter | Duration |',
        '| ----- | --------- | -------- |',
        '| Temporal Update | Daniel Ehrenberg | 30 |',
      ].join('\n');

      const res = await importAgenda(meetingId, md);
      expect(res.status).toBe(200);

      const meeting = await getMeeting(meetingId);
      expect(meeting.agenda).toHaveLength(1);
      const presenter = firstPresenter(meeting, 0);
      expect(presenter.avatarUrl).not.toBe('');
      expect(presenter.handle).toBe('littledan');
      expect(presenter.name).toBe('Daniel Ehrenberg');
      expect(presenter.organisation).toBe('Bloomberg');
    });

    it('resolves a unique tier-1 (meeting user) name to the real user', async () => {
      // Seed an extra meeting user that the imported name will match.
      const extra: User = githubUser({ id: 20, login: 'phlpchm', name: 'Philip Chimento', organisation: 'Igalia' });
      const meetingId = createMeetingWith([extra]);
      const md = [
        '## Agenda Items',
        '',
        '| Topic | Presenter | Duration |',
        '| ----- | --------- | -------- |',
        '| Temporal | Philip Chimento | 30 |',
      ].join('\n');

      const res = await importAgenda(meetingId, md);
      expect(res.status).toBe(200);

      const meeting = await getMeeting(meetingId);
      const presenter = firstPresenter(meeting, 0);
      expect(presenter.avatarUrl).not.toBe('');
      expect(presenter.handle).toBe('phlpchm');
      expect(presenter.name).toBe('Philip Chimento');
    });

    it('resolves a spaced name to a camel-case meeting-user login', async () => {
      // Whitespace-insensitive matching: the imported presenter text has
      // the spaces of a real display name, but the GitHub login is
      // camel-case with no separator. Both forms must collapse to the
      // same key for the resolver to bind them.
      const extra: User = githubUser({ id: 21, login: 'SaminaHusein', name: 'Samina Husein', organisation: 'Apple' });
      const meetingId = createMeetingWith([extra]);
      const md = [
        '## Agenda Items',
        '',
        '| Topic | Presenter | Duration |',
        '| ----- | --------- | -------- |',
        '| Item | Samina Husein | 30 |',
      ].join('\n');

      const res = await importAgenda(meetingId, md);
      expect(res.status).toBe(200);

      const meeting = await getMeeting(meetingId);
      const presenter = firstPresenter(meeting, 0);
      expect(presenter.avatarUrl).not.toBe('');
      expect(presenter.handle).toBe('SaminaHusein');
      expect(presenter.name).toBe('Samina Husein');
    });

    it('falls back to a placeholder when no candidate matches', async () => {
      const meetingId = createMeetingWith();
      const md = [
        '## Agenda Items',
        '',
        '| Topic | Presenter | Duration |',
        '| ----- | --------- | -------- |',
        '| Item | Q9zzzqq Unknown | 30 |',
      ].join('\n');

      const res = await importAgenda(meetingId, md);
      expect(res.status).toBe(200);

      const meeting = await getMeeting(meetingId);
      const presenter = firstPresenter(meeting, 0);
      expect(presenter.avatarUrl).toBe('');
      expect(presenter.handle).toBe('Q9zzzqq Unknown');
      expect(presenter.name).toBe('Q9zzzqq Unknown');
    });

    it('falls back to a placeholder when more than one candidate matches', async () => {
      const meetingId = createMeetingWith();
      // "Daniel" matches several DEV_USERS (Rosenwasser, Veditz, Ehrenberg) →
      // ambiguous → placeholder.
      const md = [
        '## Agenda Items',
        '',
        '| Topic | Presenter | Duration |',
        '| ----- | --------- | -------- |',
        '| Item | Daniel | 30 |',
      ].join('\n');

      const res = await importAgenda(meetingId, md);
      expect(res.status).toBe(200);

      const meeting = await getMeeting(meetingId);
      const presenter = firstPresenter(meeting, 0);
      expect(presenter.avatarUrl).toBe('');
      expect(presenter.handle).toBe('Daniel');
    });

    it("resolves presenters through the importer's own provider directory, not a hardcoded GitHub one", async () => {
      // Regression guard for the provider-dispatch change: import resolution
      // runs through `providerById(importer.provider).directory`, so a
      // non-GitHub importer never falls through to GitHub's DEV_USERS seed.
      // Google's directory is meeting-tier only, so a name matching a Google
      // meeting-user resolves, while a name that exists *only* in GitHub's
      // tier-2 seed does not — under the old GitHub-hardcoded path,
      // "Daniel Ehrenberg" would have resolved to littledan.
      const importer = googleUser({ sub: 'g-importer-1', name: 'Importer Persona', email: 'importer@example.com' });
      const member = googleUser({
        sub: 'g-member-2',
        name: 'Philip Chimento',
        email: 'phil@example.com',
        picture: 'https://cdn.example.invalid/phil.png',
      });
      const meeting = manager.create([importer, member]);

      // A second app whose session user is the Google importer (the default
      // test app authenticates as the GitHub TEST_USER).
      const googleApp = createTestApp(manager, importer);
      const { baseUrl: googleBaseUrl, close: closeGoogle } = await listen(googleApp);
      try {
        fixtureBody = [
          '## Agenda Items',
          '',
          '| Topic | Presenter | Duration |',
          '| ----- | --------- | -------- |',
          '| Local match | Philip Chimento | 30 |',
          '| GitHub-only name | Daniel Ehrenberg | 30 |',
        ].join('\n');
        const res = await fetch(`${googleBaseUrl}/api/meetings/${meeting.id}/import-agenda`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: fixtureUrl }),
        });
        expect(res.status).toBe(200);

        const stored = await (await fetch(`${googleBaseUrl}/api/meetings/${meeting.id}`)).json();
        // Tier-1 local match via Google's directory → the real Google member.
        const local = firstPresenter(stored, 0);
        expect(local.provider).toBe('google');
        expect(local.accountId).toBe('g-member-2');
        expect(local.avatarUrl).toBe('https://cdn.example.invalid/phil.png');
        // GitHub's DEV_USERS tier is *not* consulted for a Google importer.
        const ghOnly = firstPresenter(stored, 1);
        expect(ghOnly.provider).toBe('placeholder');
        expect(ghOnly.handle).not.toBe('littledan');
        expect(ghOnly.avatarUrl).toBe('');
      } finally {
        closeGoogle();
      }
    });

    it('imports an item with no presenters when only a duration is parsed', async () => {
      // Numbered-list item with a trailing time-only parenthetical → empty
      // presenter list → route imports the item with no presenters (the
      // chair can edit one in afterwards).
      const meetingId = createMeetingWith();
      const md = ['## Agenda Items', '', '1. Standalone item with no presenter (15m)'].join('\n');

      const res = await importAgenda(meetingId, md);
      expect(res.status).toBe(200);

      const meeting = await getMeeting(meetingId);
      expect(meeting.agenda).toHaveLength(1);
      expect(meeting.agenda[0].presenterIds).toEqual([]);
      expect(meeting.agenda[0].duration).toBe(15);
    });

    it('resolves comma-separated presenters per-name (mixed resolved + placeholder)', async () => {
      const meetingId = createMeetingWith();
      const md = [
        '## Agenda Items',
        '',
        '| Topic | Presenter | Duration |',
        '| ----- | --------- | -------- |',
        '| Item | Daniel Ehrenberg, Q9zzzqq Unknown | 30 |',
      ].join('\n');

      const res = await importAgenda(meetingId, md);
      expect(res.status).toBe(200);

      const meeting = await getMeeting(meetingId);
      const item = meeting.agenda[0];
      expect(item.presenterIds).toHaveLength(2);

      const first = meeting.users[item.presenterIds[0]];
      const second = meeting.users[item.presenterIds[1]];
      expect(first.avatarUrl).not.toBe('');
      expect(first.handle).toBe('littledan');
      expect(second.avatarUrl).toBe('');
      expect(second.handle).toBe('Q9zzzqq Unknown');
    });

    it('resolves every entry when all comma-separated presenters match uniquely', async () => {
      // Two distinct DEV_USERS entries: Daniel Ehrenberg → littledan,
      // Allen Wirfs-Brock → allenwb.
      const meetingId = createMeetingWith();
      const md = [
        '## Agenda Items',
        '',
        '| Topic | Presenter | Duration |',
        '| ----- | --------- | -------- |',
        '| Item | Daniel Ehrenberg, Allen Wirfs-Brock | 30 |',
      ].join('\n');

      const res = await importAgenda(meetingId, md);
      expect(res.status).toBe(200);

      const meeting = await getMeeting(meetingId);
      const item = meeting.agenda[0];
      expect(item.presenterIds).toHaveLength(2);
      const logins = item.presenterIds.map((k: string) => meeting.users[k].handle).sort();
      expect(logins).toEqual(['allenwb', 'littledan']);
    });

    it('resolves a name appearing across multiple items to the same user', async () => {
      const meetingId = createMeetingWith();
      const md = [
        '## Agenda Items',
        '',
        '| Topic | Presenter | Duration |',
        '| ----- | --------- | -------- |',
        '| First | Daniel Ehrenberg | 30 |',
        '| Second | Daniel Ehrenberg | 30 |',
      ].join('\n');

      const res = await importAgenda(meetingId, md);
      expect(res.status).toBe(200);

      const meeting = await getMeeting(meetingId);
      expect(meeting.agenda).toHaveLength(2);
      const firstKey = meeting.agenda[0].presenterIds[0];
      const secondKey = meeting.agenda[1].presenterIds[0];
      expect(firstKey).toBe(secondKey);
      expect(meeting.users[firstKey].avatarUrl).not.toBe('');
    });

    it('slots imported items into sessions with available capacity without reordering existing entries', async () => {
      const meetingId = createMeetingWith();
      manager.addSession(meetingId, 'Morning', 60);
      manager.addAgendaItem(meetingId, 'Existing', [TEST_USER], 40);
      manager.addSession(meetingId, 'Afternoon', 30);

      const md = [
        '## Agenda Items',
        '',
        '1. Fits morning (15m)',
        '1. Fits afternoon (10m)',
        '1. Too big for afternoon (35m)',
      ].join('\n');

      const res = await importAgenda(meetingId, md, { slotIntoSessions: true });
      expect(res.status).toBe(200);

      const meeting = await getMeeting(meetingId);
      expect(meeting.agenda.map((entry: { kind: string; name: string }) => `${entry.kind}:${entry.name}`)).toEqual([
        'session:Morning',
        'item:Existing',
        'item:Fits morning',
        'session:Afternoon',
        'item:Fits afternoon',
        'item:Too big for afternoon',
      ]);
    });
  });

  describe('POST /api/meetings/:id/import-agenda-file', () => {
    function createMeetingWith(extraUsers: User[] = []): string {
      const meeting = manager.create([TEST_USER, ...extraUsers]);
      manager.updateChairs(meeting.id, [TEST_USER]);
      return meeting.id;
    }

    async function importAgendaFile(meetingId: string, source: string) {
      return fetch(`${baseUrl}/api/meetings/${meetingId}/import-agenda-file`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source }),
      });
    }

    async function getMeeting(meetingId: string) {
      const res = await fetch(`${baseUrl}/api/meetings/${meetingId}`);
      expect(res.status).toBe(200);
      return res.json();
    }

    function firstPresenter(
      meeting: { agenda: { presenterIds: string[] }[]; users: Record<string, User> },
      itemIndex: number,
    ): User {
      const item = meeting.agenda[itemIndex];
      const key = item.presenterIds[0];
      return meeting.users[key];
    }

    it('imports sessions and topics in document order', async () => {
      const meetingId = createMeetingWith();
      const res = await importAgendaFile(
        meetingId,
        JSON.stringify([
          { type: 'session', name: 'Morning', capacity: 60 },
          { type: 'topic', name: 'Welcome', presenters: ['Daniel Ehrenberg'], duration: 5 },
          { type: 'topic', name: 'Updates', duration: 15 },
        ]),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ imported: 2, sessions: 1 });

      const meeting = await getMeeting(meetingId);
      expect(meeting.agenda).toHaveLength(3);
      expect(meeting.agenda[0].kind).toBe('session');
      expect(meeting.agenda[0].name).toBe('Morning');
      expect(meeting.agenda[1].name).toBe('Welcome');
      expect(meeting.agenda[2].name).toBe('Updates');
    });

    it('imports a session followed by its topics in order', async () => {
      const meetingId = createMeetingWith();
      const res = await importAgendaFile(
        meetingId,
        JSON.stringify([
          { type: 'session', name: 'Block A', capacity: 60 },
          { type: 'topic', name: 'First', duration: 10 },
          { type: 'topic', name: 'Second', duration: 20 },
        ]),
      );
      expect(res.status).toBe(200);

      const meeting = await getMeeting(meetingId);
      expect(meeting.agenda.map((entry: { kind: string; name: string }) => `${entry.kind}:${entry.name}`)).toEqual([
        'session:Block A',
        'item:First',
        'item:Second',
      ]);
      expect(meeting.agenda[0].capacity).toBe(60);
    });

    it('returns 400 for invalid agenda files', async () => {
      const meetingId = createMeetingWith();
      const res = await importAgendaFile(meetingId, JSON.stringify([{ type: 'topic', name: 'Item', extra: true }]));
      expect(res.status).toBe(400);
    });

    it('returns 400 when a session omits its capacity', async () => {
      const meetingId = createMeetingWith();
      const res = await importAgendaFile(meetingId, JSON.stringify([{ type: 'session', name: 'No capacity' }]));
      expect(res.status).toBe(400);
    });

    it('returns 400 for invalid JSON', async () => {
      const meetingId = createMeetingWith();
      const res = await importAgendaFile(meetingId, `export default [{ type: 'topic', name: 'Hello' }];`);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/^Invalid JSON:/);
    });

    it('returns 413 when the file exceeds the size limit', async () => {
      const meetingId = createMeetingWith();
      const res = await importAgendaFile(meetingId, 'x'.repeat(1024 * 1024 + 1));
      expect(res.status).toBe(413);
    });

    it('returns 404 for a soft-deleted meeting', async () => {
      const id = createMeetingWith();
      await manager.softDelete(id);

      const res = await importAgendaFile(id, JSON.stringify([{ type: 'topic', name: 'Hello' }]));
      expect(res.status).toBe(404);
    });

    it('appends imported entries to an existing agenda', async () => {
      const meetingId = createMeetingWith();
      manager.addAgendaItem(meetingId, 'Existing item', [TEST_USER]);

      const res = await importAgendaFile(
        meetingId,
        JSON.stringify([{ type: 'topic', name: 'Imported', duration: 10 }]),
      );
      expect(res.status).toBe(200);

      const meeting = await getMeeting(meetingId);
      expect(meeting.agenda).toHaveLength(2);
      expect(meeting.agenda[0].name).toBe('Existing item');
      expect(meeting.agenda[1].name).toBe('Imported');
      expect(meeting.agenda[1].duration).toBe(10);
    });

    it('resolves a unique tier-2 (DEV_USERS) presenter name to the real user', async () => {
      const meetingId = createMeetingWith();
      const res = await importAgendaFile(
        meetingId,
        JSON.stringify([{ type: 'topic', name: 'Temporal Update', presenters: ['Daniel Ehrenberg'], duration: 30 }]),
      );
      expect(res.status).toBe(200);

      const meeting = await getMeeting(meetingId);
      expect(meeting.agenda).toHaveLength(1);
      const presenter = firstPresenter(meeting, 0);
      expect(presenter.avatarUrl).not.toBe('');
      expect(presenter.handle).toBe('littledan');
      expect(presenter.name).toBe('Daniel Ehrenberg');
    });

    it('re-imports a document in the shape the client export produces', async () => {
      const meetingId = createMeetingWith();
      // Mirrors serializeAgenda's output (packages/client/src/lib/agendaExport.ts):
      // a flat array with `capacity` on sessions and `presenters`/`duration` on topics.
      const exported = [
        { type: 'session', name: 'Morning', capacity: 90 },
        { type: 'topic', name: 'Welcome', presenters: ['Daniel Ehrenberg'], duration: 5 },
        { type: 'session', name: 'Afternoon', capacity: 120 },
        { type: 'topic', name: 'Wrap up' },
      ];
      const res = await importAgendaFile(meetingId, JSON.stringify(exported));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ imported: 2, sessions: 2 });

      const meeting = await getMeeting(meetingId);
      expect(meeting.agenda.map((entry: { kind: string; name: string }) => `${entry.kind}:${entry.name}`)).toEqual([
        'session:Morning',
        'item:Welcome',
        'session:Afternoon',
        'item:Wrap up',
      ]);
      expect(meeting.agenda[0].capacity).toBe(90);
      expect(meeting.agenda[2].capacity).toBe(120);
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
      expect(Array.isArray(body.suggestions)).toBe(true);
      // Each suggestion's user must score against the query in handle, name,
      // or organisation by exact / prefix / substring / subsequence.
      for (const s of body.suggestions) {
        expect(scoresAgainstQuery('mike', s.user.handle ?? '', s.user.name, s.user.organisation ?? '')).toBe(true);
      }
    });

    it('clamps limit to a sane window', async () => {
      // limit=999 must not cause a >25-result response.
      const res = await fetch(`${baseUrl}/api/users/autocomplete?q=&limit=999`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.suggestions.length).toBeLessThanOrEqual(25);
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

/**
 * Import-agenda tests in OAuth mode (GITHUB_CLIENT_ID set). The directory
 * resolver takes the real-mode branch — tier 2 = the searcher's GitHub
 * org members — and `warmDirectoryForUser` populates that cache from the
 * GraphQL API. The cache is in-process memory and gets wiped on instance
 * restart, so the import endpoint awaits a warm before resolving so that
 * a chair who just landed on a fresh instance still gets tier-2 hits.
 */
describe('Meeting REST routes — import in OAuth mode', () => {
  const OAUTH_USER: User = githubUser({
    id: 30,
    login: 'michaelficarra',
    name: 'Michael Ficarra',
    organisation: '@f5networks',
  });

  const fixtureUrl = 'https://test-fixture.invalid/oauth-agenda.md';
  let manager: MeetingManager;
  let baseUrl: string;
  let close: () => void;
  let restoreFetch: () => void = () => {};
  let fixtureBody = '';
  // Track GitHub-directory traffic so a test can assert the warm
  // happened in the right order.
  let directoryCalls: string[] = [];
  const originalClientId = process.env.GITHUB_CLIENT_ID;
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    process.env.GITHUB_CLIENT_ID = 'test-client-id';
    resetDirectoryForTesting();
    fixtureBody = '';
    directoryCalls = [];

    // Stub the directory module's fetch hook for the two-step warm:
    //   1. /user/orgs (REST) — returns one org for the chair.
    //   2. /orgs/tc39/public_members (REST) — returns one TC39 member,
    //      just login + id + avatar_url (the REST shape).
    //   3. /graphql (GraphQL enrichment) — fills in display name + company
    //      for that login so import can resolve "Daniel Ehrenberg" →
    //      littledan via the display-name field.
    restoreFetch = setFetchForTesting(async (url, init) => {
      directoryCalls.push(url);
      if (url.endsWith('/user/orgs?per_page=100')) {
        return new Response(JSON.stringify([{ login: 'tc39' }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/orgs/tc39/public_members')) {
        return new Response(
          JSON.stringify([
            {
              id: 189835,
              login: 'littledan',
              avatar_url: 'https://avatars.githubusercontent.com/u/189835',
            },
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url === 'https://api.github.com/graphql') {
        // Echo back enrichment for whichever logins the production
        // query asked for. Only littledan is in our fixture, so anything
        // else gets a null (which the production code skips).
        const body = init?.body ? (JSON.parse(init.body as string) as { query?: string }) : {};
        const asked = new Set<string>();
        for (const m of (body.query ?? '').matchAll(/user\(login:\s*"([^"]+)"\)/g)) asked.add(m[1]);
        const data: Record<string, unknown> = {};
        let idx = 0;
        for (const login of asked) {
          data[`u${idx++}`] =
            login === 'littledan'
              ? { databaseId: 189835, login: 'littledan', name: 'Daniel Ehrenberg', company: 'Bloomberg' }
              : null;
        }
        return new Response(JSON.stringify({ data }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`unexpected directory fetch: ${url}`);
    });

    // Wrap the global `fetch` so the import route's outbound markdown
    // fetch resolves to our fixture body without touching the network,
    // while the inner test-server request keeps working.
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as URL | Request).toString();
      if (url === fixtureUrl) {
        return Promise.resolve(
          new Response(fixtureBody, { status: 200, headers: { 'Content-Type': 'text/markdown' } }),
        );
      }
      return realFetch(input as never, init);
    }) as typeof fetch;

    manager = new MeetingManager(new InMemoryStore());
    const app = express();
    app.use(express.json());
    app.use(session({ secret: 'test', resave: false, saveUninitialized: false }));
    // OAuth-mode session middleware: stash a SessionUser with an access
    // token so the route handler treats this user as authenticated via
    // GitHub (not mock auth).
    app.use((req, _res, next) => {
      if (!req.session.user) {
        const su = toSessionUser(OAUTH_USER);
        su.accessToken = 'token-michaelficarra';
        req.session.user = su;
      }
      next();
    });
    app.use('/api', createMeetingRoutes(manager, { to: () => ({ emit: () => {} }) } as never, emptyAppSettings()));
    ({ baseUrl, close } = await listen(app));
    return () => close();
  });

  afterEach(() => {
    restoreFetch();
    globalThis.fetch = realFetch;
    if (originalClientId === undefined) delete process.env.GITHUB_CLIENT_ID;
    else process.env.GITHUB_CLIENT_ID = originalClientId;
  });

  it('warms the org-members cache during import so tier-2 names resolve on a fresh instance', async () => {
    // Simulate a freshly restarted instance: directory caches are empty
    // (resetDirectoryForTesting() above), and the chair imports an
    // agenda before any autocomplete call would have warmed the cache.
    // Without the in-route warm, "Daniel Ehrenberg" can't match anyone
    // (tier 1 has only the chair, tier 2 is empty) and ends up as a
    // `placeholder:<name>` placeholder — the regression we're guarding against.
    const meeting = manager.create([OAUTH_USER]);
    fixtureBody = [
      '## Agenda Items',
      '',
      '| Topic | Presenter | Duration |',
      '| ----- | --------- | -------- |',
      '| Temporal Update | Daniel Ehrenberg | 30 |',
    ].join('\n');

    const res = await fetch(`${baseUrl}/api/meetings/${meeting.id}/import-agenda`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: fixtureUrl }),
    });
    expect(res.status).toBe(200);

    // The route must have called both directory APIs before resolving —
    // /user/orgs to enumerate, public_members to list, and GraphQL to
    // enrich with display name + company so the name-based match wins.
    expect(directoryCalls.some((u) => u.includes('/user/orgs'))).toBe(true);
    expect(directoryCalls.some((u) => u.includes('/orgs/tc39/public_members'))).toBe(true);
    expect(directoryCalls.some((u) => u === 'https://api.github.com/graphql')).toBe(true);

    const meetingRes = await fetch(`${baseUrl}/api/meetings/${meeting.id}`);
    const updated = await meetingRes.json();
    const presenterKey = updated.agenda[0].presenterIds[0];
    const presenter = updated.users[presenterKey];
    expect(presenter.avatarUrl).not.toBe('');
    expect(presenter.handle).toBe('littledan');
    expect(presenter.name).toBe('Daniel Ehrenberg');
  });
});
