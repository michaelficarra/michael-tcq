import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import session from 'express-session';
import type { User } from '@tcq/shared';
import { asUserKey } from '@tcq/shared';
import { MeetingManager } from './meetings.js';
import { createMeetingRoutes } from './routes.js';
import { toSessionUser } from './session.js';
import { setFetchForTesting, resetDirectoryForTesting } from './githubDirectory.js';
import { InMemoryStore } from './test/inMemoryStore.js';
import * as socket from './socket.js';

/**
 * Helper: make a request to the Express app without starting a real HTTP server.
 * Uses the built-in fetch against a dynamically assigned port.
 */
const TEST_USER: User = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: '' };

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
      app.use('/api', createMeetingRoutes(manager, { to: () => ({ emit: () => {} }) } as any));
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
      const other: User = { ghid: 99, ghUsername: 'other', name: 'Other', organisation: '' };
      const meeting = manager.create([other]);
      meeting.users[asUserKey(TEST_USER.ghUsername)] = TEST_USER;

      const res = await fetch(`${baseUrl}/api/my-meetings`);
      const body = await res.json();
      expect(body).toEqual([{ id: meeting.id, lastActivity: '', currentConnections: 0 }]);
    });

    it('returns meetings where the caller appears only in participantIds', async () => {
      // Caller is not in `users` (so not a chair/presenter/queued user) but
      // is recorded as having joined via socket. Guarantees the
      // participantIds branch of the filter is exercised.
      const other: User = { ghid: 99, ghUsername: 'other', name: 'Other', organisation: '' };
      const meeting = manager.create([other]);
      meeting.participantIds.push(asUserKey(TEST_USER.ghUsername));

      const res = await fetch(`${baseUrl}/api/my-meetings`);
      const body = await res.json();
      expect(body).toEqual([{ id: meeting.id, lastActivity: '', currentConnections: 0 }]);
    });

    it('excludes meetings where the caller is unrelated', async () => {
      const other: User = { ghid: 99, ghUsername: 'other', name: 'Other', organisation: '' };
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

    async function importAgenda(meetingId: string, body: string) {
      fixtureBody = body;
      const res = await fetch(`${baseUrl}/api/meetings/${meetingId}/import-agenda`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: fixtureUrl }),
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
      expect(presenter.ghid).toBe(189835);
      expect(presenter.ghUsername).toBe('littledan');
      expect(presenter.name).toBe('Daniel Ehrenberg');
      expect(presenter.organisation).toBe('Bloomberg');
    });

    it('resolves a unique tier-1 (meeting user) name to the real user', async () => {
      // Seed an extra meeting user that the imported name will match.
      const extra: User = {
        ghid: 42,
        ghUsername: 'phlpchm',
        name: 'Philip Chimento',
        organisation: 'Igalia',
      };
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
      expect(presenter.ghid).toBe(42);
      expect(presenter.ghUsername).toBe('phlpchm');
      expect(presenter.name).toBe('Philip Chimento');
    });

    it('resolves a spaced name to a camel-case meeting-user login', async () => {
      // Whitespace-insensitive matching: the imported presenter text has
      // the spaces of a real display name, but the GitHub login is
      // camel-case with no separator. Both forms must collapse to the
      // same key for the resolver to bind them.
      const extra: User = {
        ghid: 99,
        ghUsername: 'SaminaHusein',
        name: 'Samina Husein',
        organisation: 'Apple',
      };
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
      expect(presenter.ghid).toBe(99);
      expect(presenter.ghUsername).toBe('SaminaHusein');
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
      expect(presenter.ghid).toBe(0);
      expect(presenter.ghUsername).toBe('Q9zzzqq Unknown');
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
      expect(presenter.ghid).toBe(0);
      expect(presenter.ghUsername).toBe('Daniel');
    });

    it('imports an item with no presenters when none are parsed', async () => {
      // Numbered-list item with no parenthetical → empty presenter list →
      // route imports the item with no presenters (the chair can edit one
      // in afterwards).
      const meetingId = createMeetingWith();
      const md = ['## Agenda Items', '', '1. Standalone item with no presenter'].join('\n');

      const res = await importAgenda(meetingId, md);
      expect(res.status).toBe(200);

      const meeting = await getMeeting(meetingId);
      expect(meeting.agenda).toHaveLength(1);
      expect(meeting.agenda[0].presenterIds).toEqual([]);
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
      expect(first.ghid).toBe(189835);
      expect(first.ghUsername).toBe('littledan');
      expect(second.ghid).toBe(0);
      expect(second.ghUsername).toBe('Q9zzzqq Unknown');
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
      const logins = item.presenterIds.map((k: string) => meeting.users[k].ghUsername).sort();
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
      expect(meeting.users[firstKey].ghid).toBe(189835);
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
      // Each result must score against the query in login, name, or
      // organisation by exact / prefix / substring / subsequence.
      for (const u of body.users) {
        expect(scoresAgainstQuery('mike', u.login, u.name, u.organisation ?? '')).toBe(true);
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

/**
 * Import-agenda tests in OAuth mode (GITHUB_CLIENT_ID set). The directory
 * resolver takes the real-mode branch — tier 2 = the searcher's GitHub
 * org members — and `warmDirectoryForUser` populates that cache from the
 * GraphQL API. The cache is in-process memory and gets wiped on instance
 * restart, so the import endpoint awaits a warm before resolving so that
 * a chair who just landed on a fresh instance still gets tier-2 hits.
 */
describe('Meeting REST routes — import in OAuth mode', () => {
  const OAUTH_USER: User = {
    ghid: 218840,
    ghUsername: 'michaelficarra',
    name: 'Michael Ficarra',
    organisation: '@f5networks',
  };

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

    // Stub the directory module's fetch hook: respond to /user/orgs
    // (REST) with one org, and to the GraphQL endpoint with one TC39
    // member ("Daniel Ehrenberg" → littledan).
    restoreFetch = setFetchForTesting(async (url, init) => {
      directoryCalls.push(url);
      if (url.endsWith('/user/orgs?per_page=100')) {
        return new Response(JSON.stringify([{ login: 'tc39' }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url === 'https://api.github.com/graphql') {
        const body = JSON.parse(init?.body as string) as { variables?: { org?: string } };
        if (body.variables?.org === 'tc39') {
          return new Response(
            JSON.stringify({
              data: {
                organization: {
                  membersWithRole: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        databaseId: 189835,
                        login: 'littledan',
                        name: 'Daniel Ehrenberg',
                        company: 'Bloomberg',
                        avatarUrl: 'https://avatars.githubusercontent.com/u/189835',
                      },
                    ],
                  },
                },
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
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
    app.use('/api', createMeetingRoutes(manager, { to: () => ({ emit: () => {} }) } as never));
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
    // ghid-0 placeholder — the regression we're guarding against.
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

    // The route must have called the GitHub directory APIs before
    // resolving — otherwise tier 2 would be empty.
    expect(directoryCalls.some((u) => u.includes('/user/orgs'))).toBe(true);
    expect(directoryCalls.some((u) => u === 'https://api.github.com/graphql')).toBe(true);

    const meetingRes = await fetch(`${baseUrl}/api/meetings/${meeting.id}`);
    const updated = await meetingRes.json();
    const presenterKey = updated.agenda[0].presenterIds[0];
    const presenter = updated.users[presenterKey];
    expect(presenter.ghid).toBe(189835);
    expect(presenter.ghUsername).toBe('littledan');
    expect(presenter.name).toBe('Daniel Ehrenberg');
  });
});
