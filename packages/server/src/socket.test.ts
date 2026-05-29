import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import session from 'express-session';
import { createServer, type Server as HttpServer } from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import msgpackParser from 'socket.io-msgpack-parser';
import type {
  AgendaEntry,
  AgendaItem,
  ClientToServerEvents,
  MeetingState,
  ServerToClientEvents,
  User,
} from '@tcq/shared';
import { isAgendaItem, userKey } from '@tcq/shared';
import { MeetingManager } from './meetings.js';
import { githubUser } from './auth/githubUser.js';
import { googleUser } from './auth/googleUser.js';
import { registerSocketHandlers } from './socket.js';
import { toSessionUser } from './session.js';
import { InMemoryStore } from './test/inMemoryStore.js';
import { createClientSurrogate } from './test/clientSurrogate.js';
import { emitInParallel } from './test/concurrency.js';
import { AppSettingsManager } from './appSettingsManager.js';
import { InMemoryAppSettingsStore } from './test/inMemoryAppSettingsStore.js';

// --- Helpers ---

/** Narrow an entry we expect to be an agenda item — fails if it's not. */
function asItem(entry: AgendaEntry | undefined): AgendaItem {
  if (!entry || !isAgendaItem(entry)) throw new Error('expected an AgendaItem');
  return entry;
}

/** Typed client socket matching our event interfaces (reversed: client receives ServerToClient). */
type TypedClientSocket = ClientSocket<ServerToClientEvents, ClientToServerEvents>;

interface TestContext {
  httpServer: HttpServer;
  io: SocketIOServer<ClientToServerEvents, ServerToClientEvents>;
  meetingManager: MeetingManager;
  appSettings: AppSettingsManager;
  baseUrl: string;
}

/** The default test user — used by most socket tests as the session identity. */
const TEST_USER: User = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });

/** Middleware that sets a specific user on the session. */
function sessionAs(user: User): express.RequestHandler {
  return (req, _res, next) => {
    if (!req.session.user) {
      req.session.user = toSessionUser(user);
    }
    next();
  };
}

/** Spin up a test server with Express session + a specific session user. */
function createTestServer(user: User = TEST_USER): TestContext {
  const app = express();
  const httpServer = createServer(app);

  const sessionMiddleware = session({
    secret: 'test-secret',
    resave: false,
    saveUninitialized: false,
  });

  const authMiddleware = sessionAs(user);

  app.use(sessionMiddleware);
  app.use(authMiddleware);

  const meetingManager = new MeetingManager(new InMemoryStore());
  const appSettings = new AppSettingsManager(new InMemoryAppSettingsStore());

  // Match the production parser choice (see packages/server/src/index.ts)
  // so the existing handler tests double as integration coverage for the
  // wire format — anything that's stringly JSON-clean but breaks under
  // msgpack (e.g. an explicit `undefined` value sneaking into a payload)
  // shows up here instead of in production.
  const io = new SocketIOServer<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    cors: { origin: '*', credentials: true },
    parser: msgpackParser,
  });

  // Share session with Socket.IO (same as production setup)
  io.engine.use(sessionMiddleware);
  io.engine.use(authMiddleware);

  registerSocketHandlers(io, meetingManager, appSettings);

  return { httpServer, io, meetingManager, appSettings, baseUrl: '' };
}

/** Start the test server on a random port. */
function listen(ctx: TestContext): Promise<string> {
  return new Promise((resolve) => {
    ctx.httpServer.listen(0, () => {
      const addr = ctx.httpServer.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      ctx.baseUrl = `http://localhost:${port}`;
      resolve(ctx.baseUrl);
    });
  });
}

/** Create a client socket connected to the test server. */
function connectClient(baseUrl: string): TypedClientSocket {
  return ioClient(baseUrl, {
    // Disable reconnection in tests so disconnects are clean
    reconnection: false,
    transports: ['websocket'],
    // Must match the server-side parser configured above.
    parser: msgpackParser,
  });
}

/** Wait for a socket event and return the payload. */
function waitForEvent<T>(socket: TypedClientSocket, event: string): Promise<T> {
  return new Promise((resolve) => {
    socket.once(event as any, (data: T) => resolve(data));
  });
}

/**
 * Wait for the server to emit a state-change event back to this client
 * (a mutation delta, a state resync, an error) and then resolve with the
 * current canonical meeting state from the in-memory manager. Replaces
 * the older `waitForEvent<MeetingState>(client, 'state')` pattern, which
 * assumed every mutation re-broadcast the full state.
 *
 * `log:dirty`, `activeConnections`, and `server:revision` are ignored —
 * they are notifications, not state-change broadcasts, and a stray late
 * arrival (e.g. the `server:revision` event that immediately precedes
 * the initial `state` on join) could otherwise resolve a fresh
 * `waitForChange` before the new mutation has even reached the server.
 */
const IGNORED_EVENTS_FOR_WAIT = new Set(['log:dirty', 'activeConnections', 'server:revision']);
function waitForChange(socket: TypedClientSocket, mgr: MeetingManager, meetingId: string): Promise<MeetingState> {
  return new Promise<MeetingState>((resolve, reject) => {
    socket.onAny(function handler(event: string) {
      if (IGNORED_EVENTS_FOR_WAIT.has(event)) return;
      socket.offAny(handler);
      const m = mgr.get(meetingId);
      if (m) resolve(m);
      else reject(new Error(`Meeting ${meetingId} no longer exists`));
    });
  });
}

// --- Tests ---

describe('Socket.IO integration', () => {
  let ctx: TestContext;
  let clients: TypedClientSocket[];

  beforeEach(async () => {
    ctx = createTestServer();
    await listen(ctx);
    clients = [];
  });

  afterEach(async () => {
    // Disconnect all clients
    for (const client of clients) {
      client.disconnect();
    }
    // Close the server
    ctx.io.close();
    await new Promise<void>((resolve) => ctx.httpServer.close(() => resolve()));
  });

  /** Helper to create and track a client socket. */
  function makeClient(): TypedClientSocket {
    const client = connectClient(ctx.baseUrl);
    clients.push(client);
    return client;
  }

  it('receives full meeting state after joining', async () => {
    // Create a meeting via the manager
    const meeting = ctx.meetingManager.create([
      githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' }),
    ]);

    // Connect a client and join the meeting
    const client = makeClient();
    const statePromise = waitForChange(client, ctx.meetingManager, meeting.id);

    await new Promise<void>((resolve) => {
      client.on('connect', () => {
        client.emit('join', meeting.id);
        resolve();
      });
    });

    const state = await statePromise;
    expect(state.id).toBe(meeting.id);
    expect(state.chairIds).toHaveLength(1);
    expect(state.users[state.chairIds[0]].handle).toBe('testuser');
    expect(state.agenda).toEqual([]);
    expect(state.queue.orderedIds).toEqual([]);
  });

  it('two clients in the same meeting both receive state', async () => {
    const meeting = ctx.meetingManager.create([
      githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' }),
    ]);

    const client1 = makeClient();
    const client2 = makeClient();

    // Wait for both to connect
    await Promise.all([
      new Promise<void>((r) => client1.on('connect', r)),
      new Promise<void>((r) => client2.on('connect', r)),
    ]);

    // Both join the same meeting
    const state1Promise = waitForEvent<MeetingState>(client1, 'state');
    const state2Promise = waitForEvent<MeetingState>(client2, 'state');

    client1.emit('join', meeting.id);
    client2.emit('join', meeting.id);

    const [state1, state2] = await Promise.all([state1Promise, state2Promise]);

    expect(state1.id).toBe(meeting.id);
    expect(state2.id).toBe(meeting.id);
  });

  it('records the joining user in meeting.users even when they are not otherwise referenced', async () => {
    // The meeting is created with a different chair (not TEST_USER), so
    // the joining socket's user starts out absent from meeting.users.
    // After the socket joins, the join handler must surface them in
    // `users` so the username-autocomplete tier-1 (people in this
    // meeting) includes passive observers.
    const chairUser: User = githubUser({ id: 998, login: 'chair', name: 'Chair', organisation: '' });
    const meeting = ctx.meetingManager.create([chairUser]);
    expect(Object.keys(meeting.users)).toEqual([userKey(chairUser)]);

    const client = makeClient();
    const statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
    await new Promise<void>((r) => client.on('connect', r));
    client.emit('join', meeting.id);
    await statePromise;

    const updated = ctx.meetingManager.get(meeting.id)!;
    expect(updated.users[userKey(TEST_USER)]).toMatchObject({
      provider: TEST_USER.provider,
      accountId: TEST_USER.accountId,
      handle: TEST_USER.handle,
      name: TEST_USER.name,
      organisation: TEST_USER.organisation,
    });
  });

  it('does not receive state when joining a non-existent meeting', async () => {
    const client = makeClient();

    await new Promise<void>((r) => client.on('connect', r));

    // Join a meeting that doesn't exist
    client.emit('join', 'no-such-meeting');

    // Wait a short time — no `state` event should arrive (the server
    // emits `error` for an unknown meeting, but that's a different event
    // and isn't what this test is asserting against).
    const received = await Promise.race([
      waitForEvent<MeetingState>(client, 'state').then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 200)),
    ]);

    expect(received).toBe(false);
  });

  it('rejects join on a soft-deleted meeting (no state, emits error)', async () => {
    // Soft-deleted meetings look exactly like non-existent meetings to
    // the join handler — error event is fired, no state is sent.
    const meeting = ctx.meetingManager.create([TEST_USER]);
    await ctx.meetingManager.softDelete(meeting.id);

    const client = makeClient();
    await new Promise<void>((r) => client.on('connect', r));

    const errorPromise = waitForEvent<string>(client, 'error');
    client.emit('join', meeting.id);

    expect(await errorPromise).toBe('Meeting not found');

    const stateArrived = await Promise.race([
      waitForEvent<MeetingState>(client, 'state').then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 200)),
    ]);
    expect(stateArrived).toBe(false);
  });

  // -- Agenda events --

  /** Helper: connect a client, join a meeting, and wait for initial state. */
  async function joinMeeting(meetingId: string): Promise<TypedClientSocket> {
    const client = makeClient();
    const statePromise = waitForChange(client, ctx.meetingManager, meetingId);
    await new Promise<void>((r) => client.on('connect', r));
    client.emit('join', meetingId);
    await statePromise;
    return client;
  }

  describe('activeConnections broadcast', () => {
    it('reports 1 to the first client that joins', async () => {
      const meeting = ctx.meetingManager.create([TEST_USER]);
      const client = makeClient();
      // Register the listener before `join` so we don't miss the event.
      const countPromise = waitForEvent<number>(client, 'activeConnections');
      await new Promise<void>((r) => client.on('connect', r));
      client.emit('join', meeting.id);
      expect(await countPromise).toBe(1);
    });

    it('reports 2 to both clients when a second client joins', async () => {
      const meeting = ctx.meetingManager.create([TEST_USER]);
      // First client joins and drains its initial activeConnections=1 event
      // inside the joinMeeting helper flow (it will have fired by the time
      // the 'state' event resolves the helper).
      const client1 = await joinMeeting(meeting.id);

      // Listeners for the NEXT activeConnections event on each client.
      const client1Update = waitForEvent<number>(client1, 'activeConnections');
      const client2 = makeClient();
      const client2Initial = waitForEvent<number>(client2, 'activeConnections');

      await new Promise<void>((r) => client2.on('connect', r));
      client2.emit('join', meeting.id);

      expect(await client1Update).toBe(2);
      expect(await client2Initial).toBe(2);
    });

    it('reports the decremented count to remaining clients on disconnect', async () => {
      const meeting = ctx.meetingManager.create([TEST_USER]);
      const client1 = await joinMeeting(meeting.id);
      const client2 = await joinMeeting(meeting.id);

      // Register a listener on client1 for the NEXT activeConnections event
      // (the one triggered by client2 disconnecting).
      const client1Update = waitForEvent<number>(client1, 'activeConnections');
      client2.disconnect();
      expect(await client1Update).toBe(1);
    });
  });

  describe('agenda:add', () => {
    it('adds an agenda item and broadcasts updated state', async () => {
      // Mock user (ghid: 1, ghUsername: testuser) is a chair
      const meeting = ctx.meetingManager.create([
        githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' }),
      ]);

      const client = await joinMeeting(meeting.id);

      // Listen for the state update after adding
      const statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('agenda:add', { name: 'First item', presenters: [{ handle: 'testuser' }], duration: 15 });
      const state = await statePromise;

      expect(state.agenda).toHaveLength(1);
      const first = asItem(state.agenda[0]);
      expect(first.name).toBe('First item');
      expect(state.users[first.presenterIds[0]].handle).toBe('testuser');
      expect(first.duration).toBe(15);
    });

    it('broadcasts to all clients in the meeting', async () => {
      const meeting = ctx.meetingManager.create([
        githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' }),
      ]);

      const client1 = await joinMeeting(meeting.id);
      const client2 = await joinMeeting(meeting.id);

      // Client 2 waits for the broadcast (now a delta, not a full state)
      const state2Promise = waitForChange(client2, ctx.meetingManager, meeting.id);
      client1.emit('agenda:add', { name: 'Broadcast test', presenters: [{ handle: 'testuser' }] });
      const state2 = await state2Promise;

      expect(state2.agenda).toHaveLength(1);
      expect(state2.agenda[0].name).toBe('Broadcast test');
    });

    // Users may type or paste presenter handles in GitHub-style `@name`
    // form; the schema strips a leading `@` and surrounding whitespace
    // before the handler resolves the presenter to a user.
    it('strips a leading @ and surrounding whitespace from presenter usernames', async () => {
      const meeting = ctx.meetingManager.create([
        githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' }),
      ]);

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('agenda:add', {
        name: 'Presenter cleanup',
        presenters: [{ handle: ' @testuser ' }, { handle: '@ alice' }],
      });
      const state = await statePromise;

      const first = asItem(state.agenda[0]);
      expect(first.presenterIds).toHaveLength(2);
      expect(state.users[first.presenterIds[0]].handle).toBe('testuser');
      expect(state.users[first.presenterIds[1]].handle).toBe('alice');
    });

    it('enriches an unknown presenter via the mock-user seed in mock-auth mode', async () => {
      // Adding a presenter who isn't already in the meeting and isn't
      // the acting chair must go through the seed-aware mock helper, so
      // a login matching a TC39 seed entry shows up with that member's
      // real display name and company on the agenda item — not the bare
      // login. (When the seed isn't yet enriched, the helper falls back
      // to login-as-name with empty organisation; the test passes either
      // way.)
      const { DEV_USERS } = await import('@tcq/shared');
      const enriched = DEV_USERS.find((u) => u.name !== u.login && (u.organisation ?? '') !== '');
      const newPresenter = enriched ?? DEV_USERS[0];

      const meeting = ctx.meetingManager.create([
        githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' }),
      ]);
      const client = await joinMeeting(meeting.id);

      const statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('agenda:add', {
        name: 'Joint',
        presenters: [{ handle: 'testuser' }, { handle: newPresenter.login }],
      });
      const state = await statePromise;

      const item = asItem(state.agenda[0]);
      const presenterKey = item.presenterIds.find((id) => state.users[id].handle === newPresenter.login)!;
      expect(presenterKey).toBeDefined();
      expect(state.users[presenterKey]?.name).toBe(enriched?.name ?? newPresenter.login);
      expect(state.users[presenterKey]?.organisation).toBe(enriched?.organisation ?? '');
    });

    it('accepts an empty presenters list', async () => {
      const meeting = ctx.meetingManager.create([
        githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' }),
      ]);

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('agenda:add', { name: 'No presenter', presenters: [] });
      const state = await statePromise;

      expect(state.agenda).toHaveLength(1);
      const first = asItem(state.agenda[0]);
      expect(first.name).toBe('No presenter');
      expect(first.presenterIds).toEqual([]);
    });

    it('rejects add from non-chair', async () => {
      // Create meeting where chair is someone else (ghid: 99)
      const meeting = ctx.meetingManager.create([
        githubUser({ id: 999, login: 'chairperson', name: 'Chair', organisation: '' }),
      ]);

      const client = await joinMeeting(meeting.id);

      // Listen for error
      const errorPromise = waitForEvent<string>(client, 'error');
      client.emit('agenda:add', { name: 'Should fail', presenters: [{ handle: 'testuser' }] });
      const error = await errorPromise;

      expect(error).toMatch(/only chairs/i);
      // Agenda should still be empty
      expect(ctx.meetingManager.get(meeting.id)!.agenda).toHaveLength(0);
    });

    it('auto-activates the new item when the meeting is in the past-final state', async () => {
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'Original', [owner]);
      // Start, then advance past the last item — meeting is now past-final.
      ctx.meetingManager.nextAgendaItem(meeting.id);
      ctx.meetingManager.nextAgendaItem(meeting.id);
      expect(ctx.meetingManager.get(meeting.id)!.current.agendaItemId).toBeUndefined();
      expect(ctx.meetingManager.get(meeting.id)!.current.startedAt).toBeDefined();

      const client = await joinMeeting(meeting.id);

      // The agenda:added delta should bundle the fresh `current` and
      // `queue` snapshots so clients atomically transition out of
      // past-final.
      const deltaPromise = waitForEvent<{
        version: number;
        entry: { id: string; name: string };
        current?: { agendaItemId?: string };
        queue?: { closed: boolean };
        lastAdvancementBy?: string;
      }>(client, 'agenda:added');
      client.emit('agenda:add', { name: 'Follow-up', presenters: [{ handle: 'testuser' }] });
      const delta = await deltaPromise;

      expect(delta.entry.name).toBe('Follow-up');
      expect(delta.current).toBeDefined();
      expect(delta.current!.agendaItemId).toBe(delta.entry.id);
      expect(delta.queue).toBeDefined();
      expect(delta.queue!.closed).toBe(false);
      expect(delta.lastAdvancementBy).toBeDefined();

      // Server state confirms the auto-activation.
      const post = ctx.meetingManager.get(meeting.id)!;
      expect(post.current.agendaItemId).toBe(delta.entry.id);

      // A new agenda-item-started log entry is appended for the
      // auto-activated item. No meeting-started — the manager
      // method we used to drive the past-final transition doesn't
      // emit log entries (that's the socket handler's job), so the
      // log only contains the entry the auto-activation just added.
      const log = ctx.meetingManager.getLog(meeting.id);
      const lastStarted = log.filter((e) => e.type === 'agenda-item-started').at(-1) as
        | Extract<(typeof log)[number], { type: 'agenda-item-started' }>
        | undefined;
      expect(lastStarted?.itemName).toBe('Follow-up');
    });

    it('does not auto-activate when adding a session header', async () => {
      // Session adds go through a separate handler — covered for
      // completeness: even in past-final, a session should not become
      // the "current" item (sessions are never current).
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'Item', [owner]);
      ctx.meetingManager.nextAgendaItem(meeting.id);
      ctx.meetingManager.nextAgendaItem(meeting.id);

      ctx.meetingManager.addSession(meeting.id, 'Session', 30);
      const post = ctx.meetingManager.get(meeting.id)!;
      expect(post.current.agendaItemId).toBeUndefined();
      expect(post.current.startedAt).toBeDefined();
    });
  });

  describe('agenda:delete', () => {
    it('deletes an agenda item and broadcasts updated state', async () => {
      const meeting = ctx.meetingManager.create([
        githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' }),
      ]);
      const item = ctx.meetingManager.addAgendaItem(meeting.id, 'To delete', [
        githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' }),
      ])!;

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('agenda:delete', { id: item.id });
      const state = await statePromise;

      expect(state.agenda).toHaveLength(0);
    });

    it('refuses to delete the current agenda item and emits an error', async () => {
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);
      const first = ctx.meetingManager.addAgendaItem(meeting.id, 'First', [owner])!;
      ctx.meetingManager.addAgendaItem(meeting.id, 'Second', [owner]);
      // Advance onto `first` so it becomes the current agenda item.
      ctx.meetingManager.nextAgendaItem(meeting.id);
      expect(ctx.meetingManager.get(meeting.id)!.current.agendaItemId).toBe(first.id);

      const client = await joinMeeting(meeting.id);

      const errorPromise = new Promise<string>((resolve) => {
        client.once('error', (msg: string) => resolve(msg));
      });
      client.emit('agenda:delete', { id: first.id });
      const msg = await errorPromise;

      expect(msg).toBe('Cannot delete the current agenda item');
      // The agenda is unchanged and `current.agendaItemId` still points at `first`.
      const after = ctx.meetingManager.get(meeting.id)!;
      expect(after.agenda).toHaveLength(2);
      expect(after.current.agendaItemId).toBe(first.id);
    });
  });

  describe('agenda:reorder', () => {
    it('reorders agenda items and broadcasts updated state', async () => {
      const meeting = ctx.meetingManager.create([
        githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' }),
      ]);
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      ctx.meetingManager.addAgendaItem(meeting.id, 'A', [owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'B', [owner]);
      const itemC = ctx.meetingManager.addAgendaItem(meeting.id, 'C', [owner])!;

      const client = await joinMeeting(meeting.id);

      // Move C to the beginning (afterId: null)
      const statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('agenda:reorder', { id: itemC.id, afterId: null });
      const state = await statePromise;

      expect(state.agenda.map((i) => i.name)).toEqual(['C', 'A', 'B']);
    });

    it('reorders a session entry through the same protocol', async () => {
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);
      const itemA = ctx.meetingManager.addAgendaItem(meeting.id, 'A', [owner])!;
      const session = ctx.meetingManager.addSession(meeting.id, 'Block', 30)!;
      const itemB = ctx.meetingManager.addAgendaItem(meeting.id, 'B', [owner])!;

      const client = await joinMeeting(meeting.id);
      const statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('agenda:reorder', { id: session.id, afterId: null });
      const state = await statePromise;

      expect(state.agenda.map((e) => e.id)).toEqual([session.id, itemA.id, itemB.id]);
    });
  });

  describe('agenda:edit', () => {
    it('edits an agenda item and broadcasts updated state', async () => {
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);
      const item = ctx.meetingManager.addAgendaItem(meeting.id, 'Old name', [owner])!;

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('agenda:edit', { id: item.id, name: 'New name' });
      const state = await statePromise;

      expect(state.agenda[0].name).toBe('New name');
    });

    it('rejects edit from non-chair', async () => {
      // Meeting where chair is someone else (ghid: 99)
      const meeting = ctx.meetingManager.create([
        githubUser({ id: 999, login: 'chairperson', name: 'Chair', organisation: '' }),
      ]);
      const item = ctx.meetingManager.addAgendaItem(meeting.id, 'Item', [
        githubUser({ id: 999, login: 'chairperson', name: 'Chair', organisation: '' }),
      ])!;

      const client = await joinMeeting(meeting.id);

      const errorPromise = waitForEvent<string>(client, 'error');
      client.emit('agenda:edit', { id: item.id, name: 'Hacked' });
      const error = await errorPromise;

      expect(error).toMatch(/only chairs/i);
      // Item should be unchanged
      expect(ctx.meetingManager.get(meeting.id)!.agenda[0].name).toBe('Item');
    });
  });

  // -- Session events --

  describe('session:add', () => {
    it('adds a session header and broadcasts updated state', async () => {
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);

      const client = await joinMeeting(meeting.id);
      const statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('session:add', { name: 'Morning block', capacity: 90 });
      const state = await statePromise;

      expect(state.agenda).toHaveLength(1);
      const entry = state.agenda[0];
      expect(entry).toMatchObject({ kind: 'session', name: 'Morning block', capacity: 90 });
    });

    it('rejects non-positive capacity', async () => {
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);

      const client = await joinMeeting(meeting.id);
      const errorPromise = waitForEvent<string>(client, 'error');
      client.emit('session:add', { name: 'Block', capacity: 0 });
      await errorPromise;
      expect(ctx.meetingManager.get(meeting.id)!.agenda).toHaveLength(0);
    });

    it('rejects empty name', async () => {
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);

      const client = await joinMeeting(meeting.id);
      const errorPromise = waitForEvent<string>(client, 'error');
      client.emit('session:add', { name: '   ', capacity: 30 });
      await errorPromise;
      expect(ctx.meetingManager.get(meeting.id)!.agenda).toHaveLength(0);
    });

    it('rejects add from non-chair', async () => {
      const meeting = ctx.meetingManager.create([
        githubUser({ id: 999, login: 'chairperson', name: 'Chair', organisation: '' }),
      ]);

      const client = await joinMeeting(meeting.id);
      const errorPromise = waitForEvent<string>(client, 'error');
      client.emit('session:add', { name: 'Block', capacity: 30 });
      const error = await errorPromise;

      expect(error).toMatch(/only chairs/i);
      expect(ctx.meetingManager.get(meeting.id)!.agenda).toHaveLength(0);
    });
  });

  describe('session:edit', () => {
    it('updates name and capacity', async () => {
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);
      const session = ctx.meetingManager.addSession(meeting.id, 'Old', 30)!;

      const client = await joinMeeting(meeting.id);
      const statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('session:edit', { id: session.id, name: 'New', capacity: 45 });
      const state = await statePromise;

      expect(state.agenda[0]).toMatchObject({ kind: 'session', name: 'New', capacity: 45 });
    });

    it('rejects edit from non-chair', async () => {
      const meeting = ctx.meetingManager.create([
        githubUser({ id: 999, login: 'chairperson', name: 'Chair', organisation: '' }),
      ]);
      const session = ctx.meetingManager.addSession(meeting.id, 'Block', 30)!;

      const client = await joinMeeting(meeting.id);
      const errorPromise = waitForEvent<string>(client, 'error');
      client.emit('session:edit', { id: session.id, name: 'Hacked' });
      const error = await errorPromise;

      expect(error).toMatch(/only chairs/i);
      expect(ctx.meetingManager.get(meeting.id)!.agenda[0]).toMatchObject({ name: 'Block' });
    });
  });

  describe('session:delete', () => {
    it('removes the session but keeps contained items', async () => {
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);
      const session = ctx.meetingManager.addSession(meeting.id, 'Block', 30)!;
      ctx.meetingManager.addAgendaItem(meeting.id, 'Contained', [owner]);

      const client = await joinMeeting(meeting.id);
      const statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('session:delete', { id: session.id });
      const state = await statePromise;

      expect(state.agenda).toHaveLength(1);
      expect(state.agenda[0]).toMatchObject({ name: 'Contained' });
    });

    it('rejects delete from non-chair', async () => {
      const meeting = ctx.meetingManager.create([
        githubUser({ id: 999, login: 'chairperson', name: 'Chair', organisation: '' }),
      ]);
      const session = ctx.meetingManager.addSession(meeting.id, 'Block', 30)!;

      const client = await joinMeeting(meeting.id);
      const errorPromise = waitForEvent<string>(client, 'error');
      client.emit('session:delete', { id: session.id });
      const error = await errorPromise;

      expect(error).toMatch(/only chairs/i);
      expect(ctx.meetingManager.get(meeting.id)!.agenda).toHaveLength(1);
    });
  });

  // -- Queue events --

  describe('queue:add', () => {
    it('adds an entry and broadcasts updated state', async () => {
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('queue:add', { type: 'topic', topic: 'My topic' });
      const state = await statePromise;

      expect(state.queue.orderedIds).toHaveLength(1);
      const entry = state.queue.entries[state.queue.orderedIds[0]];
      expect(entry.type).toBe('topic');
      expect(entry.topic).toBe('My topic');
      expect(state.users[entry.userId].handle).toBe('testuser');
    });

    it('inserts entries in priority order', async () => {
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);

      const client = await joinMeeting(meeting.id);

      // Add a topic first, then a point-of-order
      let statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('queue:add', { type: 'topic', topic: 'Low priority' });
      await statePromise;

      statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('queue:add', { type: 'point-of-order', topic: 'Urgent' });
      const state = await statePromise;

      expect(state.queue.entries[state.queue.orderedIds[0]].type).toBe('point-of-order');
      expect(state.queue.entries[state.queue.orderedIds[1]].type).toBe('topic');
    });
  });

  describe('queue:add reply precondition', () => {
    /**
     * Drive the meeting to a state where `current.topic` is set: advance
     * into an agenda item, queue a topic-type entry, then advance to it.
     * Returns the client and the current state (with `current.topic` populated).
     */
    async function setupWithCurrentTopic() {
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'Item', [owner]);

      const client = await joinMeeting(meeting.id);

      // Start meeting — intro speaker is current, no current.topic yet
      let statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('meeting:nextAgendaItem', { currentAgendaItemId: meeting.current.agendaItemId ?? null }, () => {});
      await statePromise;

      // Add a topic-type entry and advance to it — this sets current.topic
      statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('queue:add', { type: 'topic', topic: 'Real topic' });
      let state = await statePromise;

      statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('queue:next', { currentSpeakerEntryId: state.current.speaker?.id ?? null }, () => {});
      state = await statePromise;

      return { client, meetingId: meeting.id, state };
    }

    it('rejects a reply whose precondition no longer matches the current topic', async () => {
      const { client, meetingId } = await setupWithCurrentTopic();

      // Pretend the client captured a stale speakerId (topic moved on before
      // the reply was processed) — server should emit error, ack should be
      // ok:false, and nothing should be added to the queue.
      const errorPromise = waitForEvent<string>(client, 'error');
      const ackPromise = new Promise<{ ok: boolean; error?: string }>((resolve) => {
        client.emit(
          'queue:add',
          { type: 'reply', topic: 'Stale reply', currentTopicSpeakerId: 'some-other-id' },
          resolve,
        );
      });

      const error = await errorPromise;
      const ack = await ackPromise;

      expect(error).toMatch(/topic has changed/i);
      expect(ack.ok).toBe(false);
      expect(ack.error).toMatch(/topic has changed/i);
      expect(ctx.meetingManager.get(meetingId)!.queue.orderedIds).toHaveLength(0);
    });

    it('rejects a reply that omits the precondition entirely', async () => {
      const { client, meetingId } = await setupWithCurrentTopic();

      const errorPromise = waitForEvent<string>(client, 'error');
      const ackPromise = new Promise<{ ok: boolean; error?: string }>((resolve) => {
        client.emit('queue:add', { type: 'reply', topic: 'Stale client reply' }, resolve);
      });

      const error = await errorPromise;
      const ack = await ackPromise;

      expect(error).toMatch(/topic has changed/i);
      expect(ack.ok).toBe(false);
      expect(ctx.meetingManager.get(meetingId)!.queue.orderedIds).toHaveLength(0);
    });

    it('accepts a reply whose precondition matches the current topic', async () => {
      const { client, meetingId, state } = await setupWithCurrentTopic();

      const speakerId = state.current.topic!.speakerId;
      const statePromise = waitForChange(client, ctx.meetingManager, meetingId);
      const ackPromise = new Promise<{ ok: boolean; error?: string }>((resolve) => {
        client.emit('queue:add', { type: 'reply', topic: 'Fresh reply', currentTopicSpeakerId: speakerId }, resolve);
      });
      const newState = await statePromise;
      const ack = await ackPromise;

      expect(ack.ok).toBe(true);
      expect(newState.queue.orderedIds).toHaveLength(1);
      const entry = newState.queue.entries[newState.queue.orderedIds[0]];
      expect(entry.type).toBe('reply');
      expect(entry.topic).toBe('Fresh reply');
      expect(ctx.meetingManager.get(meetingId)!.queue.orderedIds).toHaveLength(1);
    });

    it('rejects a reply when there is no current topic at all', async () => {
      // Don't drive to a current.topic state — just join a fresh meeting so
      // current.topic is null. A client that sends `currentTopicSpeakerId: null`
      // in this state must not be allowed to add a reply (matches with null
      // would pass the equality check on its own).
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);
      const client = await joinMeeting(meeting.id);

      const errorPromise = waitForEvent<string>(client, 'error');
      const ackPromise = new Promise<{ ok: boolean; error?: string }>((resolve) => {
        client.emit('queue:add', { type: 'reply', topic: 'No topic reply', currentTopicSpeakerId: null }, resolve);
      });

      const error = await errorPromise;
      const ack = await ackPromise;

      expect(error).toMatch(/no topic is currently active/i);
      expect(ack.ok).toBe(false);
      expect(ack.error).toMatch(/no topic is currently active/i);
      expect(ctx.meetingManager.get(meeting.id)!.queue.orderedIds).toHaveLength(0);
    });

    it('bypasses the precondition when the chair adds a reply via asUsername', async () => {
      const { client, meetingId } = await setupWithCurrentTopic();

      // No currentTopicSpeakerId; the asUsername path is a chair-driven
      // admin operation (e.g. Restore Queue) and skips the race guard.
      const statePromise = waitForChange(client, ctx.meetingManager, meetingId);
      client.emit('queue:add', { type: 'reply', topic: 'Restored reply', asUsername: 'someone' });
      const newState = await statePromise;

      expect(newState.queue.orderedIds).toHaveLength(1);
      const entry = newState.queue.entries[newState.queue.orderedIds[0]];
      expect(entry.type).toBe('reply');
      expect(entry.topic).toBe('Restored reply');
      expect(ctx.meetingManager.get(meetingId)!.queue.orderedIds).toHaveLength(1);
    });
  });

  describe('queue:add with asUsername', () => {
    it('allows a chair to add an entry as another user', async () => {
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('queue:add', { type: 'topic', topic: 'Their topic', asUsername: 'alice' });
      const state = await statePromise;

      expect(state.queue.orderedIds).toHaveLength(1);
      const entry = state.queue.entries[state.queue.orderedIds[0]];
      expect(state.users[entry.userId].handle).toBe('alice');
      expect(entry.topic).toBe('Their topic');
    });

    it('resolves known users from the meeting when using asUsername', async () => {
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);
      // Add an agenda item owned by a known user with a full profile
      ctx.meetingManager.addAgendaItem(meeting.id, 'Item', [
        githubUser({ id: 3, login: 'knownuser', name: 'Known User', organisation: 'ACME' }),
      ]);

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('queue:add', { type: 'topic', topic: 'Test', asUsername: 'knownuser' });
      const state = await statePromise;

      // Should use the full profile, not a placeholder
      const entry = state.queue.entries[state.queue.orderedIds[0]];
      expect(state.users[entry.userId].name).toBe('Known User');
      expect(state.users[entry.userId].organisation).toBe('ACME');
    });

    it('resolves a provider-qualified key (handle-less user) via asUsername', async () => {
      // Regression: Copy serialises a handle-less author (Google/Microsoft/
      // ORCID) as their `provider:accountId` key, since they have no handle.
      // Restore must resolve that key back to the real account, not degrade to
      // a machine-key placeholder via the handle path.
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);
      // A Google user (no handle) present in the meeting as an agenda presenter.
      const googleAuthor = googleUser({ sub: '110169484476', name: 'Ada Lovelace', email: 'ada@example.com' });
      ctx.meetingManager.addAgendaItem(meeting.id, 'Item', [googleAuthor]);

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('queue:add', { type: 'topic', topic: 'Restored', asUsername: 'google:110169484476' });
      const state = await statePromise;

      const entry = state.queue.entries[state.queue.orderedIds[0]];
      // Resolved to the real Google identity (keyed by sub), not a placeholder.
      expect(entry.userId).toBe('google:110169484476');
      expect(state.users[entry.userId].provider).toBe('google');
      expect(state.users[entry.userId].name).toBe('Ada Lovelace');
    });

    it('creates a placeholder user for unknown asUsername', async () => {
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('queue:add', { type: 'topic', topic: 'Test', asUsername: 'unknownperson' });
      const state = await statePromise;

      const entry = state.queue.entries[state.queue.orderedIds[0]];
      expect(state.users[entry.userId].handle).toBe('unknownperson');
      expect(state.users[entry.userId].name).toBe('unknownperson');
    });

    it('rejects asUsername from non-chair', async () => {
      // Meeting where chair is someone else
      const meeting = ctx.meetingManager.create([
        githubUser({ id: 999, login: 'chairperson', name: 'Chair', organisation: '' }),
      ]);
      // Open the queue so the test reaches the asUsername check
      ctx.meetingManager.setQueueClosed(meeting.id, false);

      const client = await joinMeeting(meeting.id);

      const errorPromise = waitForEvent<string>(client, 'error');
      client.emit('queue:add', { type: 'topic', topic: 'Hacked', asUsername: 'victim' });
      const error = await errorPromise;

      expect(error).toMatch(/only chairs/i);
      // No entry should have been added
      expect(ctx.meetingManager.get(meeting.id)!.queue.orderedIds).toHaveLength(0);
    });
  });

  describe('queue:add pending', () => {
    it('stamps pending=true and the default-for-type topic when topic is omitted', async () => {
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);
      const client = await joinMeeting(meeting.id);

      const statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('queue:add', { type: 'topic', pending: true });
      const state = await statePromise;

      expect(state.queue.orderedIds).toHaveLength(1);
      const entry = state.queue.entries[state.queue.orderedIds[0]];
      expect(entry.pending).toBe(true);
      expect(entry.topic).toBe('New topic');
    });

    it('uses the default-for-type topic appropriate to each type', async () => {
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);
      const client = await joinMeeting(meeting.id);

      const statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('queue:add', { type: 'question', pending: true });
      const state = await statePromise;

      const entry = state.queue.entries[state.queue.orderedIds[0]];
      expect(entry.type).toBe('question');
      expect(entry.topic).toBe('Clarifying question');
      expect(entry.pending).toBe(true);
    });

    it('ignores `pending` on the chair asUsername (bulk-restore) path', async () => {
      // Bulk restore is an admin operation that re-adds already-finished
      // entries — it must never produce a pending row that would render as
      // bouncing dots for every participant.
      const chair = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([chair]);
      const client = await joinMeeting(meeting.id);

      const statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('queue:add', { type: 'topic', topic: 'Restored', pending: true, asUsername: 'someone' });
      const state = await statePromise;

      const entry = state.queue.entries[state.queue.orderedIds[0]];
      expect(entry.topic).toBe('Restored');
      expect(entry.pending).toBeUndefined();
    });

    it('rejects a non-pending add that omits the topic', async () => {
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);
      const client = await joinMeeting(meeting.id);

      const errorPromise = waitForEvent<string>(client, 'error');
      client.emit('queue:add', { type: 'topic' });
      const error = await errorPromise;

      expect(error).toMatch(/topic is required/i);
      expect(ctx.meetingManager.get(meeting.id)!.queue.orderedIds).toHaveLength(0);
    });
  });

  describe('queue:edit clears pending', () => {
    it('clears the pending flag when the author edits a pending entry', async () => {
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);
      const client = await joinMeeting(meeting.id);

      // Add a pending entry, then edit it with the author's topic.
      let statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('queue:add', { type: 'topic', pending: true });
      let state = await statePromise;
      const entryId = state.queue.orderedIds[0];
      expect(state.queue.entries[entryId].pending).toBe(true);

      statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('queue:edit', { id: entryId, topic: 'My actual topic' });
      state = await statePromise;

      const entry = state.queue.entries[entryId];
      expect(entry.topic).toBe('My actual topic');
      expect(entry.pending).toBeUndefined();
    });
  });

  describe('queue:remove on pending entries', () => {
    it('removes the pending entry on owner-initiated cancel', async () => {
      // The cancel/Escape path: the author's client emits queue:remove
      // against its own pending entry.
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);
      const client = await joinMeeting(meeting.id);

      let statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('queue:add', { type: 'topic', pending: true });
      let state = await statePromise;
      const entryId = state.queue.orderedIds[0];

      statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('queue:remove', { id: entryId });
      state = await statePromise;

      expect(state.queue.orderedIds).toHaveLength(0);
    });

    it('on author disconnect, pending entries are deleted', async () => {
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);

      // Author opens a socket and adds a pending entry, then disconnects
      // without finalising. A separate viewer socket observes the
      // resulting `queue:removed` delta and the empty queue.
      const viewer = await joinMeeting(meeting.id);
      const author = await joinMeeting(meeting.id);

      let entryId: string;
      {
        const statePromise = waitForChange(viewer, ctx.meetingManager, meeting.id);
        author.emit('queue:add', { type: 'topic', pending: true });
        const state = await statePromise;
        entryId = state.queue.orderedIds[0];
        expect(state.queue.entries[entryId].pending).toBe(true);
      }

      // Author drops; viewer should see the queue go empty.
      const removedPromise = waitForChange(viewer, ctx.meetingManager, meeting.id);
      author.disconnect();
      const finalState = await removedPromise;
      expect(finalState.queue.orderedIds).toHaveLength(0);
      expect(finalState.queue.entries[entryId]).toBeUndefined();
    });

    it('on author disconnect, an already-finalised entry survives', async () => {
      // The author adds a pending entry, edits it (clearing pending), then
      // disconnects. The entry must stay in the queue — disconnect-delete
      // only fires for entries that are still pending at the moment of
      // disconnect.
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);

      const viewer = await joinMeeting(meeting.id);
      const author = await joinMeeting(meeting.id);

      let entryId: string;
      {
        const statePromise = waitForChange(viewer, ctx.meetingManager, meeting.id);
        author.emit('queue:add', { type: 'topic', pending: true });
        const state = await statePromise;
        entryId = state.queue.orderedIds[0];
      }
      {
        const statePromise = waitForChange(viewer, ctx.meetingManager, meeting.id);
        author.emit('queue:edit', { id: entryId, topic: 'Finalised topic' });
        await statePromise;
      }

      author.disconnect();
      // Wait briefly to let any disconnect work settle, then assert the
      // entry is still present and finalised.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const finalState = ctx.meetingManager.get(meeting.id)!;
      expect(finalState.queue.orderedIds).toContain(entryId);
      expect(finalState.queue.entries[entryId].topic).toBe('Finalised topic');
      expect(finalState.queue.entries[entryId].pending).toBeUndefined();
    });
  });

  describe('queue:remove', () => {
    it('removes own entry from the queue', async () => {
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);

      const client = await joinMeeting(meeting.id);

      // Add an entry
      let statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('queue:add', { type: 'topic', topic: 'Remove me' });
      const stateAfterAdd = await statePromise;
      const entryId = stateAfterAdd.queue.orderedIds[0];

      // Remove it
      statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('queue:remove', { id: entryId });
      const state = await statePromise;

      expect(state.queue.orderedIds).toHaveLength(0);
    });

    it("rejects removal of another user's entry by non-chair", async () => {
      // Meeting where chair is someone else
      const meeting = ctx.meetingManager.create([
        githubUser({ id: 999, login: 'chairperson', name: 'Chair', organisation: '' }),
      ]);
      // Add an entry by a different user
      const entry = ctx.meetingManager.addQueueEntry(
        meeting.id,
        'topic',
        'Not yours',
        githubUser({ id: 999, login: 'chairperson', name: 'Chair', organisation: '' }),
      )!;

      const client = await joinMeeting(meeting.id);

      const errorPromise = waitForEvent<string>(client, 'error');
      client.emit('queue:remove', { id: entry.id });
      const error = await errorPromise;

      expect(error).toMatch(/your own/i);
    });
  });

  describe('queue:reorder', () => {
    it('reorders queue entries and broadcasts updated state', async () => {
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'A', owner);
      ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'B', owner);
      const c = ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'C', owner)!;

      const client = await joinMeeting(meeting.id);

      // Move C to the beginning
      const statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('queue:reorder', { id: c.id, afterId: null });
      const state = await statePromise;

      expect(state.queue.orderedIds.map((id) => state.queue.entries[id].topic)).toEqual(['C', 'A', 'B']);
    });

    it('changes entry type when crossing a type boundary', async () => {
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.addQueueEntry(meeting.id, 'question', 'Q', owner);
      const t = ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'T', owner)!;

      const client = await joinMeeting(meeting.id);

      // Move topic before question — should change to question type
      const statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('queue:reorder', { id: t.id, afterId: null });
      const state = await statePromise;

      expect(state.queue.orderedIds[0]).toBe(t.id);
      expect(state.queue.entries[state.queue.orderedIds[0]].type).toBe('question');
    });

    it('rejects non-owner non-chair from reordering', async () => {
      const meeting = ctx.meetingManager.create([
        githubUser({ id: 999, login: 'chairperson', name: 'Chair', organisation: '' }),
      ]);
      // Entry owned by the chair, not the mock test user
      const entry = ctx.meetingManager.addQueueEntry(
        meeting.id,
        'topic',
        'A',
        githubUser({ id: 999, login: 'chairperson', name: 'Chair', organisation: '' }),
      )!;

      const client = await joinMeeting(meeting.id);

      const errorPromise = waitForEvent<string>(client, 'error');
      client.emit('queue:reorder', { id: entry.id, afterId: null });
      const error = await errorPromise;

      expect(error).toMatch(/your own/i);
    });

    it('allows owner to move their entry down but not up', async () => {
      // Meeting where testuser is NOT a chair
      const meeting = ctx.meetingManager.create([
        githubUser({ id: 999, login: 'chairperson', name: 'Chair', organisation: '' }),
      ]);
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const a = ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'A', owner)!;
      const b = ctx.meetingManager.addQueueEntry(
        meeting.id,
        'topic',
        'B',
        githubUser({ id: 999, login: 'chairperson', name: 'Chair', organisation: '' }),
      )!;

      const client = await joinMeeting(meeting.id);

      // Moving own entry (A) after B (down) should succeed
      const statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('queue:reorder', { id: a.id, afterId: b.id });
      const state = await statePromise;
      expect(state.queue.orderedIds[0]).toBe(b.id);
      expect(state.queue.orderedIds[1]).toBe(a.id);
    });

    it('rejects owner moving up over a non-owner directly above', async () => {
      // Meeting where testuser is NOT a chair
      const chair = githubUser({ id: 999, login: 'chairperson', name: 'Chair', organisation: '' });
      const meeting = ctx.meetingManager.create([chair]);
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      // [A:chair, B:testuser] — B's only neighbour above is the chair's
      // entry, so testuser cannot move B up at all.
      ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'A', chair);
      const b = ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'B', owner)!;

      const client = await joinMeeting(meeting.id);

      const errorPromise = waitForEvent<string>(client, 'error');
      client.emit('queue:reorder', { id: b.id, afterId: null });
      const error = await errorPromise;

      expect(error).toMatch(/above your own/i);
    });

    it('allows chair to move an entry up across another owner', async () => {
      // testuser is the chair (default session, sole creator) and may move
      // any entry across any other entry. Set up [A:other, B:other, C:other]
      // and move C to the position right after A.
      const meeting = ctx.meetingManager.create([TEST_USER]);
      const other = githubUser({ id: 4, login: 'someone-else', name: 'Other', organisation: '' });
      const a = ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'A', other)!;
      ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'B', other);
      const c = ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'C', other)!;

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('queue:reorder', { id: c.id, afterId: a.id });
      const state = await statePromise;

      expect(state.queue.orderedIds.map((id) => state.queue.entries[id].topic)).toEqual(['A', 'C', 'B']);
    });

    it('allows owner to move their entry up within their own block', async () => {
      // [A:chair, B:testuser, C:testuser] — testuser may move C above B
      // (their own contiguous block) but no further.
      const chair = githubUser({ id: 999, login: 'chairperson', name: 'Chair', organisation: '' });
      const meeting = ctx.meetingManager.create([chair]);
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const a = ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'A', chair)!;
      const b = ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'B', owner)!;
      const c = ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'C', owner)!;

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('queue:reorder', { id: c.id, afterId: a.id });
      const state = await statePromise;

      expect(state.queue.orderedIds).toEqual([a.id, c.id, b.id]);
    });

    it('allows owner to move their entry to the top when all above are theirs', async () => {
      // [A:testuser, B:testuser, C:testuser] in a meeting chaired by
      // someone else — testuser may freely reorder among their block, all
      // the way to the top.
      const chair = githubUser({ id: 999, login: 'chairperson', name: 'Chair', organisation: '' });
      const meeting = ctx.meetingManager.create([chair]);
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const a = ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'A', owner)!;
      const b = ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'B', owner)!;
      const c = ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'C', owner)!;

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('queue:reorder', { id: c.id, afterId: null });
      const state = await statePromise;

      expect(state.queue.orderedIds).toEqual([c.id, a.id, b.id]);
    });

    it('rejects owner upward move that crosses a non-owner entry', async () => {
      // [A:testuser, B:chair, C:testuser] — testuser tries to move C past
      // B (the chair's entry) to the top. The slice being jumped over
      // contains B, so the move is rejected.
      const chair = githubUser({ id: 999, login: 'chairperson', name: 'Chair', organisation: '' });
      const meeting = ctx.meetingManager.create([chair]);
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'A', owner);
      ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'B', chair);
      const c = ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'C', owner)!;

      const client = await joinMeeting(meeting.id);

      const errorPromise = waitForEvent<string>(client, 'error');
      client.emit('queue:reorder', { id: c.id, afterId: null });
      const error = await errorPromise;

      expect(error).toMatch(/above your own/i);
    });

    it('rejects owner upward move that lands above a non-owner', async () => {
      // [A:testuser, B:chair, C:testuser, D:testuser] — testuser tries to
      // move D to the position after A (target index 1). The slice being
      // jumped over is [B, C], which contains B (non-owner), so the move
      // is rejected even though D is moving past one of its own entries.
      const chair = githubUser({ id: 999, login: 'chairperson', name: 'Chair', organisation: '' });
      const meeting = ctx.meetingManager.create([chair]);
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const a = ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'A', owner)!;
      ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'B', chair);
      ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'C', owner);
      const d = ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'D', owner)!;

      const client = await joinMeeting(meeting.id);

      const errorPromise = waitForEvent<string>(client, 'error');
      client.emit('queue:reorder', { id: d.id, afterId: a.id });
      const error = await errorPromise;

      expect(error).toMatch(/above your own/i);
    });

    it('rejects reorder for unknown entry id', async () => {
      const meeting = ctx.meetingManager.create([TEST_USER]);
      ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'A', TEST_USER);

      const client = await joinMeeting(meeting.id);

      const errorPromise = waitForEvent<string>(client, 'error');
      client.emit('queue:reorder', {
        id: '00000000-0000-0000-0000-000000000000',
        afterId: null,
      });
      const error = await errorPromise;

      expect(error).toMatch(/entry not found/i);
    });

    it('rejects reorder with unknown afterId', async () => {
      // Use an owner-non-chair to also cover the path where the owner
      // validation falls through to reorderQueueEntry's failure path with
      // an unknown afterId (not no-op, not upward).
      const chair = githubUser({ id: 999, login: 'chairperson', name: 'Chair', organisation: '' });
      const meeting = ctx.meetingManager.create([chair]);
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const a = ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'A', owner)!;

      const client = await joinMeeting(meeting.id);

      const errorPromise = waitForEvent<string>(client, 'error');
      client.emit('queue:reorder', {
        id: a.id,
        afterId: '00000000-0000-0000-0000-000000000000',
      });
      const error = await errorPromise;

      expect(error).toMatch(/invalid queue reorder/i);
    });
  });

  describe('queue:edit', () => {
    it('edits a queue entry topic and broadcasts updated state', async () => {
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);
      const entry = ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'Old topic', owner)!;

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('queue:edit', { id: entry.id, topic: 'New topic' });
      const state = await statePromise;

      expect(state.queue.entries[state.queue.orderedIds[0]].topic).toBe('New topic');
    });

    it('rejects edit from non-owner non-chair', async () => {
      // Meeting where chair is someone else (ghid: 99)
      const meeting = ctx.meetingManager.create([
        githubUser({ id: 999, login: 'chairperson', name: 'Chair', organisation: '' }),
      ]);
      // Queue entry created by the chair, not the mock test user
      const entry = ctx.meetingManager.addQueueEntry(
        meeting.id,
        'topic',
        'Not yours',
        githubUser({ id: 999, login: 'chairperson', name: 'Chair', organisation: '' }),
      )!;

      const client = await joinMeeting(meeting.id);

      const errorPromise = waitForEvent<string>(client, 'error');
      client.emit('queue:edit', { id: entry.id, topic: 'Hacked' });
      const error = await errorPromise;

      expect(error).toMatch(/your own/i);
      // Entry should be unchanged
      const state = ctx.meetingManager.get(meeting.id)!;
      expect(state.queue.entries[state.queue.orderedIds[0]].topic).toBe('Not yours');
    });

    it('rejects type change from non-chair owner', async () => {
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const chair = githubUser({ id: 999, login: 'chairperson', name: 'Chair', organisation: '' });
      const meeting = ctx.meetingManager.create([chair]);
      const entry = ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'My topic', owner)!;

      const client = await joinMeeting(meeting.id);

      const errorPromise = waitForEvent<string>(client, 'error');
      client.emit('queue:edit', { id: entry.id, type: 'question' });
      const error = await errorPromise;

      expect(error).toMatch(/only chairs/i);
      // Type should be unchanged
      expect(ctx.meetingManager.get(meeting.id)!.queue.entries[entry.id].type).toBe('topic');
    });

    it('allows chair to change entry type', async () => {
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);
      const entry = ctx.meetingManager.addQueueEntry(
        meeting.id,
        'topic',
        'Test',
        githubUser({ id: 2, login: 'other', name: 'Other', organisation: '' }),
      )!;

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('queue:edit', { id: entry.id, type: 'question' });
      const state = await statePromise;

      expect(state.queue.entries[state.queue.orderedIds[0]].type).toBe('question');
    });

    it('allows chair to edit any entry', async () => {
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);
      // Entry created by someone else
      const entry = ctx.meetingManager.addQueueEntry(
        meeting.id,
        'topic',
        'Other topic',
        githubUser({ id: 2, login: 'other', name: 'Other', organisation: '' }),
      )!;

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('queue:edit', { id: entry.id, topic: 'Chair edited' });
      const state = await statePromise;

      expect(state.queue.entries[state.queue.orderedIds[0]].topic).toBe('Chair edited');
    });
  });

  describe('queue:next', () => {
    it('advances to the next speaker and broadcasts', async () => {
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'First', owner);
      ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'Second', owner);

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('queue:next', { currentSpeakerEntryId: meeting.current.speaker?.id ?? null }, () => {});
      const state = await statePromise;

      expect(state.current.speaker?.topic).toBe('First');
      expect(state.queue.orderedIds).toHaveLength(1);
      expect(state.queue.entries[state.queue.orderedIds[0]].topic).toBe('Second');
    });

    it('sets currentTopic when advancing a topic-type entry', async () => {
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'New discussion', owner);

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('queue:next', { currentSpeakerEntryId: meeting.current.speaker?.id ?? null }, () => {});
      const state = await statePromise;

      expect(state.current.topic?.topic).toBe('New discussion');
    });

    it('clears the speaker when queue is empty', async () => {
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);
      // Set a current speaker and topic but leave queue empty
      const ownerKey = userKey(owner);
      meeting.current.speaker = {
        id: 'old-speaker',
        type: 'topic',
        topic: 'Done',
        userId: ownerKey,
        source: 'queue',
        startTime: new Date().toISOString(),
      };
      meeting.current.topic = {
        speakerId: 'old-speaker',
        userId: ownerKey,
        topic: 'Done',
        startTime: new Date().toISOString(),
      };

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      // Use the current speaker id as the precondition
      client.emit('queue:next', { currentSpeakerEntryId: meeting.current.speaker?.id ?? null }, () => {});
      const state = await statePromise;

      expect(state.current.speaker).toBeUndefined();
    });

    it('rejects conflicting advance when currentSpeakerEntryId does not match', async () => {
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'Only entry', owner);

      const client = await joinMeeting(meeting.id);

      // Send queue:next with a wrong currentSpeakerEntryId (simulates someone having already advanced)
      const ackPromise = new Promise<any>((resolve) => {
        client.emit('queue:next', { currentSpeakerEntryId: 'stale-id' }, resolve);
      });
      const response = await ackPromise;

      expect(response.ok).toBe(false);
      expect(response.error).toMatch(/already advanced/i);

      // Queue should not have advanced
      expect(ctx.meetingManager.get(meeting.id)!.queue.orderedIds).toHaveLength(1);
    });

    it('returns ok: true via ack on success', async () => {
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'Entry', owner);

      const client = await joinMeeting(meeting.id);

      const ackPromise = new Promise<any>((resolve) => {
        client.emit('queue:next', { currentSpeakerEntryId: meeting.current.speaker?.id ?? null }, resolve);
      });
      const response = await ackPromise;

      expect(response.ok).toBe(true);
    });

    it('rejects from non-chair via ack', async () => {
      const meeting = ctx.meetingManager.create([
        githubUser({ id: 999, login: 'chairperson', name: 'Chair', organisation: '' }),
      ]);

      const client = await joinMeeting(meeting.id);

      const ackPromise = new Promise<any>((resolve) => {
        client.emit('queue:next', { currentSpeakerEntryId: null }, resolve);
      });
      const response = await ackPromise;

      expect(response.ok).toBe(false);
      expect(response.error).toMatch(/only chairs/i);
    });

    it('rejects the current speaker (non-chair) from advancing', async () => {
      const chair = githubUser({ id: 999, login: 'chairperson', name: 'Chair', organisation: '' });
      const speaker = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([chair]);
      ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'My topic', speaker);
      ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'Next topic', chair);
      // Advance to make the speaker the current speaker
      ctx.meetingManager.nextSpeaker(meeting.id);

      const client = await joinMeeting(meeting.id);

      const ackPromise = new Promise<any>((resolve) => {
        client.emit('queue:next', { currentSpeakerEntryId: meeting.current.speaker?.id ?? null }, resolve);
      });
      const response = await ackPromise;

      expect(response.ok).toBe(false);
      expect(response.error).toMatch(/only chairs/i);
    });

    it('accepts advancement after unrelated mutations (queue edit)', async () => {
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'First', owner);
      ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'Second', owner);

      const client = await joinMeeting(meeting.id);

      // Capture the precondition before any mutations
      const precondition = meeting.current.speaker?.id ?? null;

      // Make an unrelated mutation — edit a queue entry's topic
      const entryId = meeting.queue.orderedIds[0];
      ctx.meetingManager.editQueueEntry(meeting.id, entryId, { topic: 'Edited topic' });

      // Advance with the original precondition — should succeed because
      // the speaker didn't change, only the queue entry text did
      const ackPromise = new Promise<any>((resolve) => {
        client.emit('queue:next', { currentSpeakerEntryId: precondition }, resolve);
      });
      const response = await ackPromise;

      expect(response.ok).toBe(true);
      // The edited entry should now be the current speaker
      const updated = ctx.meetingManager.get(meeting.id)!;
      expect(updated.current.speaker?.topic).toBe('Edited topic');
    });

    it('rejects when another chair already advanced the speaker', async () => {
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'First', owner);
      ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'Second', owner);
      ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'Third', owner);

      const client = await joinMeeting(meeting.id);

      // Both chairs see no current speaker
      const staleEntryId = meeting.current.speaker?.id ?? null;

      // Chair A advances (server-side, simulating the first concurrent click)
      ctx.meetingManager.nextSpeaker(meeting.id);

      // Chair B tries to advance with the stale precondition
      const ackPromise = new Promise<any>((resolve) => {
        client.emit('queue:next', { currentSpeakerEntryId: staleEntryId }, resolve);
      });
      const response = await ackPromise;

      expect(response.ok).toBe(false);
      expect(response.error).toMatch(/already advanced/i);
      // Should still be on the first speaker (Chair A's advance), not skipped to second
      const updated = ctx.meetingManager.get(meeting.id)!;
      expect(updated.current.speaker?.topic).toBe('First');
    });
  });

  // -- Chair management events --

  describe('meeting:updateChairs', () => {
    it('updates the chair list and broadcasts', async () => {
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('meeting:updateChairs', { chairs: [{ handle: 'testuser' }, { handle: 'newchair' }] });
      const state = await statePromise;

      expect(state.chairIds).toHaveLength(2);
      const chairUsernames = state.chairIds.map((id) => state.users[id].handle);
      expect(chairUsernames).toContain('testuser');
      expect(chairUsernames).toContain('newchair');
    });

    it('rejects from non-chair', async () => {
      const meeting = ctx.meetingManager.create([
        githubUser({ id: 999, login: 'chairperson', name: 'Chair', organisation: '' }),
      ]);

      const client = await joinMeeting(meeting.id);

      const errorPromise = waitForEvent<string>(client, 'error');
      client.emit('meeting:updateChairs', { chairs: [{ handle: 'testuser' }] });
      const error = await errorPromise;

      expect(error).toMatch(/only chairs/i);
    });

    it('rejects empty chair list', async () => {
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);

      const client = await joinMeeting(meeting.id);

      const errorPromise = waitForEvent<string>(client, 'error');
      client.emit('meeting:updateChairs', { chairs: [] });
      const error = await errorPromise;

      expect(error).toMatch(/at least one/i);
    });

    it('rejects when the acting chair removes themselves', async () => {
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);

      const client = await joinMeeting(meeting.id);

      const errorPromise = waitForEvent<string>(client, 'error');
      client.emit('meeting:updateChairs', { chairs: [{ handle: 'someone-else' }] });
      const error = await errorPromise;

      expect(error).toMatch(/cannot remove yourself/i);
    });

    it('resolves known users from the meeting', async () => {
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);
      // Add a known user via the agenda
      ctx.meetingManager.addAgendaItem(meeting.id, 'Item', [
        githubUser({ id: 3, login: 'knownuser', name: 'Known User', organisation: 'ACME' }),
      ]);

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('meeting:updateChairs', { chairs: [{ handle: 'testuser' }, { handle: 'knownuser' }] });
      const state = await statePromise;

      const knownKey = state.chairIds.find((id) => state.users[id].handle === 'knownuser')!;
      expect(state.users[knownKey]?.name).toBe('Known User');
      expect(state.users[knownKey]?.organisation).toBe('ACME');
    });

    it('enriches an unknown chair via the mock-user seed in mock-auth mode', async () => {
      // Mock-mode chair-add must use the seed-aware helper so a login
      // matching a TC39 seed entry shows up with that member's real
      // display name and company in the chair badge — not the bare login.
      // We use the first seed entry that has a non-fallback name and a
      // non-empty organisation so the test exercises both fields. If
      // the seed hasn't been enriched yet (refresh script run without a
      // token), the assertion still passes because the helper falls
      // back to login-as-name with empty organisation in that case.
      const { DEV_USERS } = await import('@tcq/shared');
      const enriched = DEV_USERS.find((u) => u.name !== u.login && (u.organisation ?? '') !== '');
      const newChair = enriched ?? DEV_USERS[0];

      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);
      const client = await joinMeeting(meeting.id);

      const statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('meeting:updateChairs', { chairs: [{ handle: 'testuser' }, { handle: newChair.login }] });
      const state = await statePromise;

      const newChairKey = state.chairIds.find((id) => state.users[id].handle === newChair.login)!;
      expect(newChairKey).toBeDefined();
      expect(state.users[newChairKey]?.name).toBe(enriched?.name ?? newChair.login);
      expect(state.users[newChairKey]?.organisation).toBe(enriched?.organisation ?? '');
    });
  });

  describe('meeting:updateChairs (admin)', () => {
    it('allows an admin to edit chairs for a meeting they do not chair', async () => {
      // Set testuser as admin
      vi.stubEnv('ADMIN_USERNAMES', 'testuser');

      // Meeting where testuser is NOT a chair
      const meeting = ctx.meetingManager.create([
        githubUser({ id: 999, login: 'chairperson', name: 'Chair', organisation: '' }),
      ]);

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('meeting:updateChairs', { chairs: [{ handle: 'newchair' }] });
      const state = await statePromise;

      expect(state.chairIds).toHaveLength(1);
      expect(state.users[state.chairIds[0]].handle).toBe('newchair');

      vi.unstubAllEnvs();
    });

    it('allows an admin to remove themselves from the chair list', async () => {
      vi.stubEnv('ADMIN_USERNAMES', 'testuser');

      const meeting = ctx.meetingManager.create([
        githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: '' }),
      ]);

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('meeting:updateChairs', { chairs: [{ handle: 'someone-else' }] });
      const state = await statePromise;

      expect(state.chairIds).toHaveLength(1);
      expect(state.users[state.chairIds[0]].handle).toBe('someone-else');

      vi.unstubAllEnvs();
    });

    it('allows an admin to set an empty chair list', async () => {
      vi.stubEnv('ADMIN_USERNAMES', 'testuser');

      const meeting = ctx.meetingManager.create([
        githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: '' }),
      ]);

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('meeting:updateChairs', { chairs: [] });
      const state = await statePromise;

      expect(state.chairIds).toHaveLength(0);

      vi.unstubAllEnvs();
    });
  });

  // -- Poll events --

  /** Helper: sample poll options for tests. */
  const samplePollOptions = [
    { emoji: '❤️', label: 'Love' },
    { emoji: '👍', label: 'Like' },
  ];

  describe('poll:start', () => {
    it('starts a poll with custom options and broadcasts', async () => {
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('poll:start', { options: samplePollOptions });
      const state = await statePromise;

      expect(state.poll).toBeDefined();
      expect(state.poll!.options).toHaveLength(2);
      expect(state.poll!.options[0].emoji).toBe('❤️');
      expect(state.poll!.options[0].label).toBe('Love');
      expect(state.poll!.reactions).toHaveLength(0);
    });

    it('rejects with fewer than 2 options', async () => {
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);

      const client = await joinMeeting(meeting.id);

      const errorPromise = waitForEvent<string>(client, 'error');
      client.emit('poll:start', { options: [{ emoji: '👍', label: 'Only one' }] });
      const error = await errorPromise;

      expect(error).toMatch(/at least 2/i);
    });

    it('rejects from non-chair', async () => {
      const meeting = ctx.meetingManager.create([
        githubUser({ id: 999, login: 'chairperson', name: 'Chair', organisation: '' }),
      ]);

      const client = await joinMeeting(meeting.id);

      const errorPromise = waitForEvent<string>(client, 'error');
      client.emit('poll:start', { options: samplePollOptions });
      const error = await errorPromise;

      expect(error).toMatch(/only chairs/i);
    });
  });

  describe('poll:stop', () => {
    it('stops a poll by clearing meeting.poll', async () => {
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.startPoll(meeting.id, samplePollOptions, userKey(owner), undefined, true);

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('poll:stop');
      const state = await statePromise;

      expect(state.poll).toBeUndefined();
    });
  });

  describe('poll:react', () => {
    it('adds a reaction and broadcasts', async () => {
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.startPoll(meeting.id, samplePollOptions, userKey(owner), undefined, true);
      const optionId = meeting.poll!.options[0].id;

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('poll:react', { optionId });
      const state = await statePromise;

      expect(state.poll!.reactions).toHaveLength(1);
      expect(state.poll!.reactions[0].optionId).toBe(optionId);
      expect(state.users[state.poll!.reactions[0].userId].handle).toBe('testuser');
    });

    it('toggles off an existing reaction', async () => {
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.startPoll(meeting.id, samplePollOptions, userKey(owner), undefined, true);
      const optionId = meeting.poll!.options[0].id;

      const client = await joinMeeting(meeting.id);

      // Add
      let statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('poll:react', { optionId });
      await statePromise;

      // Toggle off
      statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('poll:react', { optionId });
      const state = await statePromise;

      expect(state.poll!.reactions).toHaveLength(0);
    });

    it('rejects when poll is not active', async () => {
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);

      const client = await joinMeeting(meeting.id);

      const errorPromise = waitForEvent<string>(client, 'error');
      client.emit('poll:react', { optionId: 'any' });
      const error = await errorPromise;

      expect(error).toMatch(/not active/i);
    });
  });

  // -- Meeting flow events --

  describe('meeting:nextAgendaItem', () => {
    it('starts the meeting and broadcasts updated state', async () => {
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'First topic', [owner]);

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('meeting:nextAgendaItem', { currentAgendaItemId: meeting.current.agendaItemId ?? null }, () => {});
      const state = await statePromise;

      expect(state.agenda.find((i) => i.id === state.current.agendaItemId)?.name).toBe('First topic');
      const speaker = state.current.speaker!;
      expect(state.users[speaker.userId].handle).toBe('testuser');
      expect(speaker.topic).toBe('Introducing: First topic');
      expect(speaker.source).toBe('agenda');
    });

    it('advances to the next agenda item', async () => {
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'First', [owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'Second', [owner]);

      const client = await joinMeeting(meeting.id);

      // Start meeting
      let statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('meeting:nextAgendaItem', { currentAgendaItemId: meeting.current.agendaItemId ?? null }, () => {});
      const state1 = await statePromise;

      // Advance to second — use the currentAgendaItemId from the state we just received
      statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('meeting:nextAgendaItem', { currentAgendaItemId: state1.current.agendaItemId ?? null }, () => {});
      const state2 = await statePromise;

      expect(state2.agenda.find((i) => i.id === state2.current.agendaItemId)?.name).toBe('Second');
    });

    it('rejects from non-chair via ack', async () => {
      const meeting = ctx.meetingManager.create([
        githubUser({ id: 999, login: 'chairperson', name: 'Chair', organisation: '' }),
      ]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'Item', [
        githubUser({ id: 999, login: 'chairperson', name: 'Chair', organisation: '' }),
      ]);

      const client = await joinMeeting(meeting.id);

      const ackPromise = new Promise<any>((resolve) => {
        client.emit('meeting:nextAgendaItem', { currentAgendaItemId: null }, resolve);
      });
      const response = await ackPromise;

      expect(response.ok).toBe(false);
      expect(response.error).toMatch(/only chairs/i);
    });

    it('concludes the meeting when advancing past the final item (records conclusion, clears current)', async () => {
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'Only item', [owner]);

      const client = await joinMeeting(meeting.id);

      // Start (first item)
      let ackPromise = new Promise<any>((resolve) => {
        client.emit('meeting:nextAgendaItem', { currentAgendaItemId: meeting.current.agendaItemId ?? null }, resolve);
      });
      const startResponse = await ackPromise;
      expect(startResponse.ok).toBe(true);

      // Wait for the state broadcast so we have the new agenda item
      await new Promise((r) => setTimeout(r, 50));
      const currentMeeting = ctx.meetingManager.get(meeting.id)!;
      const currentItemId = currentMeeting.current.agendaItemId;

      // Advance past the end with a conclusion — should succeed and
      // transition the meeting into the past-final state.
      ackPromise = new Promise<any>((resolve) => {
        client.emit(
          'meeting:nextAgendaItem',
          { currentAgendaItemId: currentMeeting.current.agendaItemId ?? null, conclusion: 'wrapped up the discussion' },
          resolve,
        );
      });
      const response = await ackPromise;

      expect(response.ok).toBe(true);
      // Server state: past-final.
      const finalMeeting = ctx.meetingManager.get(meeting.id)!;
      expect(finalMeeting.current.agendaItemId).toBeUndefined();
      expect(finalMeeting.current.startedAt).toBeDefined();
      // Outgoing item received its conclusion and a realised duration.
      const outgoing = finalMeeting.agenda.find((e) => e.id === currentItemId);
      expect(outgoing && 'conclusion' in outgoing && outgoing.conclusion).toBe('wrapped up the discussion');
      // The agenda-item-finished log entry carries the conclusion.
      const log = ctx.meetingManager.getLog(meeting.id);
      const finishedEntry = log.find((entry) => entry.type === 'agenda-item-finished');
      expect(finishedEntry && 'conclusion' in finishedEntry && finishedEntry.conclusion).toBe(
        'wrapped up the discussion',
      );
    });

    it('returns error via ack when no items have ever been added (none branch)', async () => {
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);

      const client = await joinMeeting(meeting.id);

      const ackPromise = new Promise<any>((resolve) => {
        client.emit('meeting:nextAgendaItem', { currentAgendaItemId: null }, resolve);
      });
      const response = await ackPromise;

      expect(response.ok).toBe(false);
      expect(response.error).toMatch(/no more agenda items/i);
    });

    it('rejects conflicting advance when currentAgendaItemId does not match', async () => {
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'First', [owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'Second', [owner]);

      const client = await joinMeeting(meeting.id);

      // Start meeting (advances to first item, so currentAgendaItemId changes)
      let statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('meeting:nextAgendaItem', { currentAgendaItemId: null }, () => {});
      await statePromise;

      // Try to advance again with null (the pre-start value) — should be rejected
      // because another advancement already happened
      statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('meeting:nextAgendaItem', { currentAgendaItemId: null }, () => {});
      const state = await statePromise;

      // Should still be on the first item (rejected, but got current state back)
      expect(state.agenda.find((i) => i.id === state.current.agendaItemId)?.name).toBe('First');
    });

    it('accepts advancement after unrelated mutations (queue add)', async () => {
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'First', [owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'Second', [owner]);

      const client = await joinMeeting(meeting.id);

      // Start meeting
      let statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('meeting:nextAgendaItem', { currentAgendaItemId: null }, () => {});
      const state1 = await statePromise;

      // Make an unrelated mutation — add a queue entry (bumps version but
      // doesn't change the current agenda item)
      ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'Discussion', owner);

      // Advance with the precondition from state1 — should succeed because
      // the current agenda item hasn't changed
      statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('meeting:nextAgendaItem', { currentAgendaItemId: state1.current.agendaItemId ?? null }, () => {});
      const state2 = await statePromise;

      expect(state2.agenda.find((i) => i.id === state2.current.agendaItemId)?.name).toBe('Second');
    });

    it('rejects when another chair already advanced the agenda item', async () => {
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'First', [owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'Second', [owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'Third', [owner]);

      const client = await joinMeeting(meeting.id);

      // Both chairs see no current agenda item (meeting not started)
      const staleItemId = meeting.current.agendaItemId ?? null;

      // Chair A starts the meeting (server-side, simulating the first concurrent click)
      ctx.meetingManager.nextAgendaItem(meeting.id);

      // Chair B tries to start with the stale precondition (null)
      const ackPromise = new Promise<any>((resolve) => {
        client.emit('meeting:nextAgendaItem', { currentAgendaItemId: staleItemId }, resolve);
      });
      const response = await ackPromise;

      expect(response.ok).toBe(false);
      expect(response.error).toMatch(/another chair/i);
      // Should still be on First (Chair A's advance), not skipped to Second
      const updated = ctx.meetingManager.get(meeting.id)!;
      expect(updated.agenda.find((i) => i.id === updated.current.agendaItemId)?.name).toBe('First');
    });

    it("replaces the completed item's duration with the elapsed time rounded up to the nearest minute", async () => {
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);
      // Seed an obviously-wrong duration so we can verify it was overwritten,
      // not merely left alone.
      ctx.meetingManager.addAgendaItem(meeting.id, 'First', [owner], 999);
      ctx.meetingManager.addAgendaItem(meeting.id, 'Second', [owner]);

      const client = await joinMeeting(meeting.id);

      // Start meeting (advance to First).
      let statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('meeting:nextAgendaItem', { currentAgendaItemId: meeting.current.agendaItemId ?? null }, () => {});
      const state1 = await statePromise;
      const firstId = state1.current.agendaItemId!;

      // Let a handful of ms elapse so the rounding-up behaviour is exercised
      // with a positive duration rather than a same-millisecond collision.
      await new Promise((r) => setTimeout(r, 20));

      // Advance to Second — this completes First.
      statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('meeting:nextAgendaItem', { currentAgendaItemId: firstId }, () => {});
      const state2 = await statePromise;

      const first = asItem(state2.agenda.find((i) => i.id === firstId));
      // Pin to the log's duration to prove the exact Math.ceil(ms / 60000) relationship.
      const log = ctx.meetingManager.getLog(meeting.id);
      const finished = log.find(
        (e): e is Extract<typeof e, { type: 'agenda-item-finished' }> =>
          e.type === 'agenda-item-finished' && e.itemName === 'First',
      )!;
      expect(finished.duration).toBeGreaterThan(0);
      expect(first.duration).toBe(Math.ceil(finished.duration / 60000));
      // And specifically: the old 999 value was clobbered.
      expect(first.duration).toBeLessThan(999);
    });

    it("sets a duration on completion even if the item didn't have one", async () => {
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);
      // No duration on First.
      ctx.meetingManager.addAgendaItem(meeting.id, 'First', [owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'Second', [owner]);

      const client = await joinMeeting(meeting.id);

      let statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('meeting:nextAgendaItem', { currentAgendaItemId: meeting.current.agendaItemId ?? null }, () => {});
      const state1 = await statePromise;
      const firstId = state1.current.agendaItemId!;
      expect(asItem(state1.agenda.find((i) => i.id === firstId)).duration).toBeUndefined();

      // Same reason as above — ensure a positive elapsed duration.
      await new Promise((r) => setTimeout(r, 20));

      statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('meeting:nextAgendaItem', { currentAgendaItemId: firstId }, () => {});
      const state2 = await statePromise;

      const first = asItem(state2.agenda.find((i) => i.id === firstId));
      expect(first.duration).toBeGreaterThanOrEqual(1);
      expect(Number.isInteger(first.duration)).toBe(true);
    });
  });

  it('client can switch meetings by joining a different one', async () => {
    const meeting1 = ctx.meetingManager.create([
      githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' }),
    ]);
    const meeting2 = ctx.meetingManager.create([
      githubUser({ id: 2, login: 'other', name: 'Other User', organisation: 'Other Org' }),
    ]);

    const client = makeClient();
    await new Promise<void>((r) => client.on('connect', r));

    // Join meeting 1
    let statePromise = waitForChange(client, ctx.meetingManager, meeting1.id);
    client.emit('join', meeting1.id);
    let state = await statePromise;
    expect(state.id).toBe(meeting1.id);

    // Switch to meeting 2
    statePromise = waitForChange(client, ctx.meetingManager, meeting2.id);
    client.emit('join', meeting2.id);
    state = await statePromise;
    expect(state.id).toBe(meeting2.id);
  });

  // -- Meeting log tests --

  describe('meeting log', () => {
    const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });

    it('logs meeting-started and agenda-item-started on first agenda advancement', async () => {
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'First Item', [owner]);

      const client = await joinMeeting(meeting.id);
      const statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('meeting:nextAgendaItem', { currentAgendaItemId: meeting.current.agendaItemId ?? null }, () => {});
      await statePromise;

      const log = ctx.meetingManager.getLog(meeting.id);
      expect(log).toHaveLength(2);
      expect(log[0].type).toBe('meeting-started');
      expect(log[1].type).toBe('agenda-item-started');
      expect(log[1].type === 'agenda-item-started' && log[1].itemName).toBe('First Item');
    });

    it('logs agenda-item-finished when advancing to the next item', async () => {
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'First Item', [owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'Second Item', [owner]);

      const client = await joinMeeting(meeting.id);

      // Start meeting (advance to first item)
      let statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('meeting:nextAgendaItem', { currentAgendaItemId: meeting.current.agendaItemId ?? null }, () => {});
      const state = await statePromise;

      // Advance to second item
      statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('meeting:nextAgendaItem', { currentAgendaItemId: state.current.agendaItemId ?? null }, () => {});
      await statePromise;

      // Should have: meeting-started, item-started(First), topic-discussed (intro), item-finished(First), item-started(Second)
      const log = ctx.meetingManager.getLog(meeting.id);
      const finished = log.find((e) => e.type === 'agenda-item-finished');
      expect(finished).toBeDefined();
      expect(finished!.type === 'agenda-item-finished' && finished!.itemName).toBe('First Item');
      expect(finished!.type === 'agenda-item-finished' && finished!.duration).toBeGreaterThanOrEqual(0);
      expect(finished!.type === 'agenda-item-finished' && finished!.participantIds).toHaveLength(1);

      const secondStarted = log.filter((e) => e.type === 'agenda-item-started');
      expect(secondStarted).toHaveLength(2);
    });

    it('groups speakers under topic-discussed entries', async () => {
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'Item', [owner]);

      const client = await joinMeeting(meeting.id);

      // Start meeting
      let statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('meeting:nextAgendaItem', { currentAgendaItemId: meeting.current.agendaItemId ?? null }, () => {});
      await statePromise;

      // Add a new topic to the queue and advance
      statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('queue:add', { type: 'topic', topic: 'My topic' });
      let state = await statePromise;

      statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('queue:next', { currentSpeakerEntryId: state.current.speaker?.id ?? null }, () => {});
      state = await statePromise;

      // The introductory topic group should be finalised in the log
      const topicEntries = ctx.meetingManager.getLog(meeting.id).filter((e) => e.type === 'topic-discussed');
      expect(topicEntries).toHaveLength(1);
      expect(topicEntries[0].type === 'topic-discussed' && topicEntries[0].speakers).toHaveLength(1);

      // The new topic should be in currentTopicSpeakers (not yet finalised)
      expect(state.current.topicSpeakers).toHaveLength(1);
      expect(state.current.topicSpeakers[0].topic).toBe('My topic');
    });

    it('nests replies under the current topic group', async () => {
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'Item', [owner]);

      const client = await joinMeeting(meeting.id);

      // Start meeting — intro speaker is current, no current.topic yet
      let statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('meeting:nextAgendaItem', { currentAgendaItemId: meeting.current.agendaItemId ?? null }, () => {});
      await statePromise;

      // Queue a topic and advance to it so current.topic is populated
      statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('queue:add', { type: 'topic', topic: 'My topic' });
      let state = await statePromise;

      statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('queue:next', { currentSpeakerEntryId: state.current.speaker?.id ?? null }, () => {});
      state = await statePromise;

      const topicSpeakerId = state.current.topic!.speakerId;

      // Add a reply against the live current.topic and advance to it
      statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('queue:add', { type: 'reply', topic: 'My reply', currentTopicSpeakerId: topicSpeakerId });
      state = await statePromise;

      statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('queue:next', { currentSpeakerEntryId: state.current.speaker?.id ?? null }, () => {});
      state = await statePromise;

      // Reply should be in the same topic group as the topic (not finalised yet)
      expect(state.current.topicSpeakers).toHaveLength(2);
      expect(state.current.topicSpeakers[0].type).toBe('topic');
      expect(state.current.topicSpeakers[1].type).toBe('reply');
      expect(state.current.topicSpeakers[1].topic).toBe('My reply');
    });

    it('excludes point-of-order speakers from topic groups', async () => {
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'Item', [owner]);

      const client = await joinMeeting(meeting.id);

      // Start meeting
      let statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('meeting:nextAgendaItem', { currentAgendaItemId: meeting.current.agendaItemId ?? null }, () => {});
      await statePromise;

      // Add a point-of-order and advance to it
      statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('queue:add', { type: 'point-of-order', topic: 'POO' });
      let state = await statePromise;

      statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('queue:next', { currentSpeakerEntryId: state.current.speaker?.id ?? null }, () => {});
      state = await statePromise;

      // Point-of-order should NOT be in the current topic speakers
      expect(state.current.topicSpeakers).toHaveLength(1);
      expect(state.current.topicSpeakers[0].topic).toContain('Introducing');
    });

    it('logs poll-ran entry when a poll is stopped', async () => {
      const meeting = ctx.meetingManager.create([owner]);

      const client = await joinMeeting(meeting.id);

      // Start a poll
      let statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('poll:start', {
        options: [
          { emoji: '👍', label: 'Yes' },
          { emoji: '👎', label: 'No' },
        ],
      });
      const state = await statePromise;

      // React to an option
      statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('poll:react', { optionId: state.poll!.options[0].id });
      await statePromise;

      // Stop the poll
      statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('poll:stop');
      await statePromise;

      const pollEntry = ctx.meetingManager.getLog(meeting.id).find((e) => e.type === 'poll-ran');
      expect(pollEntry).toBeDefined();
      if (pollEntry?.type === 'poll-ran') {
        expect(pollEntry.totalVoters).toBe(1);
        expect(pollEntry.results).toHaveLength(2);
        expect(pollEntry.duration).toBeGreaterThanOrEqual(0);
      }
    });

    it('includes remaining queue in agenda-item-finished when queue is non-empty', async () => {
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'First', [owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'Second', [owner]);

      const client = await joinMeeting(meeting.id);

      // Start meeting
      let statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('meeting:nextAgendaItem', { currentAgendaItemId: meeting.current.agendaItemId ?? null }, () => {});
      await statePromise;

      // Add entries to the queue
      statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('queue:add', { type: 'topic', topic: 'Leftover topic' });
      const state = await statePromise;

      // Advance to next agenda item (leaving the queue non-empty)
      statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('meeting:nextAgendaItem', { currentAgendaItemId: state.current.agendaItemId ?? null }, () => {});
      await statePromise;

      const finished = ctx.meetingManager.getLog(meeting.id).find((e) => e.type === 'agenda-item-finished');
      expect(finished).toBeDefined();
      if (finished?.type === 'agenda-item-finished') {
        expect(finished.remainingQueue).toBeDefined();
        expect(finished.remainingQueue).toContain('Leftover topic');
        expect(finished.remainingQueue).toContain('testuser');
      }
    });

    it('serialises a handle-less author in remainingQueue as the full provider key', async () => {
      // Parity with the client's "Copy queue": a handle-less author (Google/
      // Microsoft/ORCID) must be written as the full `provider:accountId` key,
      // not the bare accountId — so the log text round-trips through "Restore
      // Queue" (the colon routes `resolveUserRef` down the key path).
      const meeting = ctx.meetingManager.create([owner]);
      const googleAuthor = googleUser({ sub: '110169484476', name: 'Ada Lovelace', email: 'ada@example.com' });
      ctx.meetingManager.addAgendaItem(meeting.id, 'First', [googleAuthor]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'Second', [owner]);

      const client = await joinMeeting(meeting.id);

      let statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('meeting:nextAgendaItem', { currentAgendaItemId: meeting.current.agendaItemId ?? null }, () => {});
      await statePromise;

      // Chair adds a queue entry on behalf of the handle-less Google author.
      statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('queue:add', { type: 'topic', topic: 'Ada topic', asUsername: 'google:110169484476' });
      const state = await statePromise;

      // Advance, leaving the queue non-empty so it gets serialised.
      statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('meeting:nextAgendaItem', { currentAgendaItemId: state.current.agendaItemId ?? null }, () => {});
      await statePromise;

      const finished = ctx.meetingManager.getLog(meeting.id).find((e) => e.type === 'agenda-item-finished');
      expect(finished?.type).toBe('agenda-item-finished');
      if (finished?.type === 'agenda-item-finished') {
        expect(finished.remainingQueue).toContain('(google:110169484476)');
      }
    });

    it('does not include remainingQueue when queue is empty at advancement', async () => {
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'First', [owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'Second', [owner]);

      const client = await joinMeeting(meeting.id);

      // Start meeting
      let statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('meeting:nextAgendaItem', { currentAgendaItemId: meeting.current.agendaItemId ?? null }, () => {});
      const state = await statePromise;

      // Advance to next item with empty queue
      statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('meeting:nextAgendaItem', { currentAgendaItemId: state.current.agendaItemId ?? null }, () => {});
      await statePromise;

      const finished = ctx.meetingManager.getLog(meeting.id).find((e) => e.type === 'agenda-item-finished');
      expect(finished).toBeDefined();
      if (finished?.type === 'agenda-item-finished') {
        expect(finished.remainingQueue).toBeUndefined();
      }
    });

    it('persists conclusion onto outgoing item and embeds it in the finished log entry', async () => {
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'First', [owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'Second', [owner]);

      const client = await joinMeeting(meeting.id);

      // Start meeting (no outgoing item yet — conclusion is ignored on this hop)
      let statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit(
        'meeting:nextAgendaItem',
        { currentAgendaItemId: null, conclusion: 'ignored — nothing to conclude' },
        () => {},
      );
      let state = await statePromise;

      // Advance past First with a conclusion
      const firstId = state.current.agendaItemId!;
      statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('meeting:nextAgendaItem', { currentAgendaItemId: firstId, conclusion: '  Decided X.  ' }, () => {});
      state = await statePromise;

      // Conclusion is trimmed and stored on the agenda item
      const firstItem = state.agenda.find(
        (e): e is import('@tcq/shared').AgendaItem => e.kind === 'item' && e.id === firstId,
      );
      expect(firstItem?.conclusion).toBe('Decided X.');

      // Conclusion is embedded in the snapshot log entry
      const finished = ctx.meetingManager.getLog(meeting.id).find((e) => e.type === 'agenda-item-finished');
      expect(finished).toBeDefined();
      if (finished?.type === 'agenda-item-finished') {
        expect(finished.conclusion).toBe('Decided X.');
      }
    });

    it('clears the conclusion when the chair submits a blank value', async () => {
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'First', [owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'Second', [owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'Third', [owner]);

      // Pre-seed a conclusion as if a previous advancement set one (e.g. revisit case).
      const m = ctx.meetingManager.get(meeting.id)!;
      const firstAgendaItem = m.agenda.find((e): e is import('@tcq/shared').AgendaItem => e.kind === 'item');
      firstAgendaItem!.conclusion = 'old conclusion';

      const client = await joinMeeting(meeting.id);

      // Start
      let statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('meeting:nextAgendaItem', { currentAgendaItemId: null }, () => {});
      let state = await statePromise;

      const firstId = state.current.agendaItemId!;

      // Advance past First with an empty conclusion (chair cleared the textarea).
      statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('meeting:nextAgendaItem', { currentAgendaItemId: firstId, conclusion: '   ' }, () => {});
      state = await statePromise;

      const firstItem = state.agenda.find(
        (e): e is import('@tcq/shared').AgendaItem => e.kind === 'item' && e.id === firstId,
      );
      expect(firstItem?.conclusion).toBeUndefined();

      const finished = ctx.meetingManager.getLog(meeting.id).find((e) => e.type === 'agenda-item-finished');
      if (finished?.type === 'agenda-item-finished') {
        expect(finished.conclusion).toBeUndefined();
      }
    });
  });

  describe('queue:setClosed', () => {
    it('chair can close and open the queue', async () => {
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);

      const client = await joinMeeting(meeting.id);

      // Close the queue
      let statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('queue:setClosed', { closed: true });
      let state = await statePromise;
      expect(state.queue.closed).toBe(true);

      // Re-open the queue
      statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('queue:setClosed', { closed: false });
      state = await statePromise;
      expect(state.queue.closed).toBe(false);
    });

    it('rejects from non-chair', async () => {
      const meeting = ctx.meetingManager.create([
        githubUser({ id: 999, login: 'chairperson', name: 'Chair', organisation: '' }),
      ]);

      const client = await joinMeeting(meeting.id);

      const errorPromise = waitForEvent<string>(client, 'error');
      client.emit('queue:setClosed', { closed: true });
      const error = await errorPromise;

      expect(error).toMatch(/only chairs/i);
    });

    it('non-chair queue:add rejected when queue is closed', async () => {
      const meeting = ctx.meetingManager.create([
        githubUser({ id: 999, login: 'chairperson', name: 'Chair', organisation: '' }),
      ]);
      // Close the queue
      ctx.meetingManager.setQueueClosed(meeting.id, true);

      const client = await joinMeeting(meeting.id);

      const errorPromise = waitForEvent<string>(client, 'error');
      client.emit('queue:add', { type: 'topic', topic: 'Should fail' });
      const error = await errorPromise;

      expect(error).toMatch(/queue is closed/i);
      expect(ctx.meetingManager.get(meeting.id)!.queue.orderedIds).toHaveLength(0);
    });

    it('non-chair can add a Point of Order when queue is closed', async () => {
      const meeting = ctx.meetingManager.create([
        githubUser({ id: 999, login: 'chairperson', name: 'Chair', organisation: '' }),
      ]);
      // Close the queue — the joining user (testuser, ghid: 1) is not a chair
      ctx.meetingManager.setQueueClosed(meeting.id, true);

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('queue:add', { type: 'point-of-order', topic: 'Point of order' });
      const state = await statePromise;

      expect(state.queue.orderedIds).toHaveLength(1);
      const entry = state.queue.entries[state.queue.orderedIds[0]];
      expect(entry.type).toBe('point-of-order');
      expect(entry.topic).toBe('Point of order');
    });

    it('non-chair queue:add still rejected for non-POO types when queue is closed', async () => {
      const meeting = ctx.meetingManager.create([
        githubUser({ id: 999, login: 'chairperson', name: 'Chair', organisation: '' }),
      ]);
      ctx.meetingManager.setQueueClosed(meeting.id, true);

      const client = await joinMeeting(meeting.id);

      for (const type of ['topic', 'reply', 'question'] as const) {
        const errorPromise = waitForEvent<string>(client, 'error');
        client.emit('queue:add', { type, topic: 'Should fail' });
        const error = await errorPromise;
        expect(error).toMatch(/queue is closed/i);
      }
      expect(ctx.meetingManager.get(meeting.id)!.queue.orderedIds).toHaveLength(0);
    });

    it('chair can add entries when queue is closed', async () => {
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);
      // Close the queue
      ctx.meetingManager.setQueueClosed(meeting.id, true);

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('queue:add', { type: 'topic', topic: 'Chair entry' });
      const state = await statePromise;

      expect(state.queue.orderedIds).toHaveLength(1);
      expect(state.queue.entries[state.queue.orderedIds[0]].topic).toBe('Chair entry');
    });

    it('meeting:nextAgendaItem reopens the queue', async () => {
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'Item 1', [owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'Item 2', [owner]);

      const client = await joinMeeting(meeting.id);

      // Start the meeting (advances to first agenda item)
      let statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('meeting:nextAgendaItem', { currentAgendaItemId: meeting.current.agendaItemId ?? null }, () => {});
      let state = await statePromise;
      expect(state.queue.closed).toBe(false);

      // Close the queue
      statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('queue:setClosed', { closed: true });
      state = await statePromise;
      expect(state.queue.closed).toBe(true);

      // Advance to next agenda item — should reopen queue
      statePromise = waitForChange(client, ctx.meetingManager, meeting.id);
      client.emit('meeting:nextAgendaItem', { currentAgendaItemId: state.current.agendaItemId ?? null }, () => {});
      state = await statePromise;
      expect(state.queue.closed).toBe(false);
    });

    it('queue is closed by default before meeting starts', async () => {
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);

      await joinMeeting(meeting.id);
      const state = ctx.meetingManager.get(meeting.id)!;
      expect(state.queue.closed).toBe(true);
    });
  });

  // -- Gap detection and recovery ---------------------------------------
  // The delta-broadcast path's correctness rests on two invariants:
  //   1. Clients detect a missing delta (gap in the version sequence).
  //   2. On detection, the resync codepath repairs the divergence so
  //      the client converges to the server's state.
  // The surrogate tests below force a drop on the wire and then make
  // assertions about both halves.
  describe('delta gap detection and resync', () => {
    const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });

    /**
     * Attach a surrogate *before* the join handshake so the bootstrap
     * `state` event fires the surrogate's listener (the regular
     * `joinMeeting` consumes the state event itself, so listeners
     * attached after the await never see the bootstrap).
     */
    async function joinWithSurrogate(meetingId: string) {
      const socket = makeClient();
      await new Promise<void>((r) => socket.on('connect', r));
      const surrogate = createClientSurrogate(socket);
      socket.emit('join', meetingId);
      // Bootstrap `state` carries the meeting's current `operational.version`
      // (which is `0` for a freshly-created meeting), so waiting for >= 0
      // resolves on the first state event regardless of timing.
      await surrogate.waitForVersion(0);
      return { socket, surrogate };
    }

    it('detects a missing delta and recovers via state:resync', async () => {
      const meeting = ctx.meetingManager.create([owner]);
      const driver = await joinMeeting(meeting.id);
      const { socket: observer, surrogate } = await joinWithSurrogate(meeting.id);

      // First mutation lands normally — surrogate applies it.
      driver.emit('agenda:add', { name: 'First', presenters: [{ handle: 'testuser' }] });
      await surrogate.waitForVersion(1);
      expect(surrogate.state?.agenda).toHaveLength(1);

      // Force the surrogate to silently drop the *next* delta.
      surrogate.options.dropNext = true;
      driver.emit('agenda:add', { name: 'Second', presenters: [{ handle: 'testuser' }] });
      // Wait until the drop has been recorded (events.length grows even
      // though no version is applied — the surrogate logs `[dropped]`).
      await surrogate.waitForNextEvent();
      expect(surrogate.lastSeenVersion).toBe(1); // didn't advance
      expect(surrogate.state?.agenda).toHaveLength(1); // still stale

      // A subsequent mutation triggers gap detection — version is now
      // lastSeen+2, surrogate emits state:resync, server replies with
      // a fresh state and the surrogate re-seeds.
      driver.emit('agenda:add', { name: 'Third', presenters: [{ handle: 'testuser' }] });
      // Convergence: the resync replays the full state with version 3.
      await surrogate.waitForVersion(3);

      expect(surrogate.resyncRequestCount).toBe(1);
      expect(surrogate.state?.agenda.map((e) => 'name' in e && e.name)).toEqual(['First', 'Second', 'Third']);
      // The state event from the resync should have arrived.
      expect(surrogate.events.some((e) => e.event === 'state' && e.version === 3)).toBe(true);

      surrogate.detach();
      observer.disconnect();
    });

    it('server tracks state:resync requests in its socket counters', async () => {
      const { resetSocketCounters, getSocketCounters } = await import('./socketCounters.js');
      resetSocketCounters();

      const meeting = ctx.meetingManager.create([owner]);
      const driver = await joinMeeting(meeting.id);
      const { socket: observer, surrogate } = await joinWithSurrogate(meeting.id);

      // Drop one and provoke a gap.
      surrogate.options.dropNext = true;
      driver.emit('agenda:add', { name: 'A', presenters: [{ handle: 'testuser' }] });
      await surrogate.waitForNextEvent();
      driver.emit('agenda:add', { name: 'B', presenters: [{ handle: 'testuser' }] });
      await surrogate.waitForVersion(2);

      expect(getSocketCounters().stateResyncs).toBeGreaterThanOrEqual(1);

      surrogate.detach();
      observer.disconnect();
    });

    it('resync converges even after multiple consecutive dropped deltas', async () => {
      const meeting = ctx.meetingManager.create([owner]);
      const driver = await joinMeeting(meeting.id);
      const { socket: observer, surrogate } = await joinWithSurrogate(meeting.id);

      // Drop the next two deltas in a row, then make a third mutation.
      surrogate.options.dropNext = true;
      driver.emit('agenda:add', { name: 'A', presenters: [{ handle: 'testuser' }] });
      await surrogate.waitForNextEvent();
      surrogate.options.dropNext = true;
      driver.emit('agenda:add', { name: 'B', presenters: [{ handle: 'testuser' }] });
      await surrogate.waitForNextEvent();
      driver.emit('agenda:add', { name: 'C', presenters: [{ handle: 'testuser' }] });

      // The third delta triggers gap detection (expected v2, got v3),
      // and the resync replays the full state with version 3 — both
      // missing items appear.
      await surrogate.waitForVersion(3);
      expect(surrogate.state?.agenda.map((e) => 'name' in e && e.name)).toEqual(['A', 'B', 'C']);

      surrogate.detach();
      observer.disconnect();
    });

    it('reconnect re-emits state and re-seeds the surrogate', async () => {
      const meeting = ctx.meetingManager.create([owner]);
      const driver = await joinMeeting(meeting.id);
      // Apply a mutation before the observer joins, so the post-join
      // state is non-trivially different from the initial empty meeting.
      driver.emit('agenda:add', { name: 'Pre-join', presenters: [{ handle: 'testuser' }] });
      // Wait for the server-side mutation to land (emit is async).
      await new Promise<void>((resolve) => {
        const check = () => {
          if ((ctx.meetingManager.get(meeting.id)?.agenda.length ?? 0) > 0) resolve();
          else setTimeout(check, 10);
        };
        check();
      });

      const { socket: observer, surrogate } = await joinWithSurrogate(meeting.id);
      expect(surrogate.state?.agenda).toHaveLength(1);
      const versionBeforeDisconnect = surrogate.lastSeenVersion ?? 0;

      // Disconnect and apply more mutations while away.
      observer.disconnect();
      driver.emit('agenda:add', { name: 'During disconnect', presenters: [{ handle: 'testuser' }] });
      await new Promise<void>((resolve) => {
        const check = () => {
          if ((ctx.meetingManager.get(meeting.id)?.agenda.length ?? 0) === 2) resolve();
          else setTimeout(check, 10);
        };
        check();
      });

      // Reconnect and re-join — the server emits a fresh state event,
      // the surrogate re-seeds and now reflects the away-period mutation.
      observer.connect();
      await new Promise<void>((r) => observer.once('connect', r));
      observer.emit('join', meeting.id);
      await surrogate.waitForVersion(versionBeforeDisconnect + 1);
      expect(surrogate.state?.agenda).toHaveLength(2);

      surrogate.detach();
      observer.disconnect();
    });
  });

  // -- Reducer/server equivalence ---------------------------------------
  // The strongest guarantee against silent client/server divergence is
  // that after every server mutation, the surrogate's state — produced
  // by applying the emitted delta through the real `applyDelta` from
  // `@tcq/shared` — is byte-equal to the canonical state on the server.
  // The test below sequences every supported mutation type through a
  // single connected surrogate and asserts equivalence after each one;
  // a reducer bug for any single delta type fails this test
  // immediately and pinpoints which step diverged.
  describe('reducer/server equivalence', () => {
    const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });

    /**
     * Strip the one field that's intentionally divergent. The server's
     * `emitDelta` clears `operational.lastAdvancementBy` after emitting
     * each `speaker:advanced` / `agenda:advanced` (it's a one-shot
     * attribution signal), but the client surrogate keeps it on local
     * state until the next advance overwrites it. This is acceptable
     * production behaviour — the client uses the field for transient
     * cooldown UI — but it's not part of the equivalence we're
     * asserting.
     */
    function normalise(state: import('@tcq/shared').MeetingState | null) {
      if (!state) return state;
      const { lastAdvancementBy: _ignored, ...operationalRest } = state.operational;
      return { ...state, operational: operationalRest };
    }

    /**
     * Each step of the sequence: emit a client-to-server action via the
     * driver, wait for the surrogate to see the resulting delta, and
     * assert byte-equivalence with the server's state.
     */
    async function runStep(
      label: string,
      driver: TypedClientSocket,
      surrogate: ReturnType<typeof createClientSurrogate>,
      meetingId: string,
      emit: () => void,
    ) {
      const versionBefore = surrogate.lastSeenVersion ?? 0;
      emit();
      await surrogate.waitForVersion(versionBefore + 1);
      const expected = normalise(ctx.meetingManager.get(meetingId)!);
      const actual = normalise(surrogate.state);
      // The label is included on the assertion message via the
      // third argument so a failure points at the offending mutation
      // (vitest's diff is preserved).
      expect(actual, `divergence after step "${label}"`).toEqual(expected);
    }

    it('surrogate state matches server state byte-for-byte after every mutation type', async () => {
      const meeting = ctx.meetingManager.create([owner]);
      const driver = await joinMeeting(meeting.id);
      const observerSocket = makeClient();
      await new Promise<void>((r) => observerSocket.on('connect', r));
      const surrogate = createClientSurrogate(observerSocket);
      observerSocket.emit('join', meeting.id);
      await surrogate.waitForVersion(0);

      // Capture ids as the test creates entries — needed for the
      // edit/delete/reorder steps below.
      const itemIds: string[] = [];
      const sessionIds: string[] = [];
      const queueIds: string[] = [];

      // Set up an ack-collecting helper so adds can return us the new id.
      // The server's responses are async, but the surrogate's
      // waitForVersion is sufficient — we read the new id off the
      // current state via `meetingManager.get` after each step.

      // --- agenda:added (chair-only) ---
      await runStep('agenda:added (item)', driver, surrogate, meeting.id, () => {
        driver.emit('agenda:add', { name: 'First', presenters: [{ handle: 'testuser' }] });
      });
      itemIds.push(ctx.meetingManager.get(meeting.id)!.agenda.at(-1)!.id);

      // --- agenda:added (session header) ---
      await runStep('agenda:added (session)', driver, surrogate, meeting.id, () => {
        driver.emit('session:add', { name: 'Morning Session', capacity: 60 });
      });
      sessionIds.push(ctx.meetingManager.get(meeting.id)!.agenda.at(-1)!.id);

      // --- agenda:added (item, used later for reorder/delete) ---
      await runStep('agenda:added (item 2)', driver, surrogate, meeting.id, () => {
        driver.emit('agenda:add', { name: 'Second', presenters: [{ handle: 'testuser' }] });
      });
      itemIds.push(ctx.meetingManager.get(meeting.id)!.agenda.at(-1)!.id);

      // --- agenda:edited ---
      await runStep('agenda:edited (item)', driver, surrogate, meeting.id, () => {
        driver.emit('agenda:edit', { id: itemIds[0], name: 'First (edited)' });
      });

      // --- agenda:edited (session) ---
      await runStep('agenda:edited (session)', driver, surrogate, meeting.id, () => {
        driver.emit('session:edit', { id: sessionIds[0], capacity: 90 });
      });

      // --- agenda:reordered ---
      await runStep('agenda:reordered', driver, surrogate, meeting.id, () => {
        driver.emit('agenda:reorder', { id: itemIds[1], afterId: null });
      });

      // --- agenda:deleted (session) ---
      await runStep('agenda:deleted (session)', driver, surrogate, meeting.id, () => {
        driver.emit('session:delete', { id: sessionIds[0] });
      });

      // --- chairs:updated (admin path is not exercised — non-admin
      // chair must keep themselves; the test user is the chair). ---
      await runStep('chairs:updated', driver, surrogate, meeting.id, () => {
        driver.emit('meeting:updateChairs', { chairs: [{ handle: 'testuser' }, { handle: 'other' }] });
      });

      // --- agenda:advanced (start the meeting → first item is current) ---
      await runStep('agenda:advanced (start)', driver, surrogate, meeting.id, () => {
        driver.emit('meeting:nextAgendaItem', { currentAgendaItemId: null }, () => {});
      });

      // --- queue:added ---
      await runStep('queue:added', driver, surrogate, meeting.id, () => {
        driver.emit('queue:add', { type: 'topic', topic: 'My topic' });
      });
      queueIds.push(ctx.meetingManager.get(meeting.id)!.queue.orderedIds.at(-1)!);

      // --- queue:added (second, for reorder later) ---
      await runStep('queue:added (2)', driver, surrogate, meeting.id, () => {
        driver.emit('queue:add', { type: 'topic', topic: 'Another topic' });
      });
      queueIds.push(ctx.meetingManager.get(meeting.id)!.queue.orderedIds.at(-1)!);

      // --- queue:edited ---
      await runStep('queue:edited', driver, surrogate, meeting.id, () => {
        driver.emit('queue:edit', { id: queueIds[0], topic: 'My topic (edited)' });
      });

      // --- queue:reordered ---
      await runStep('queue:reordered', driver, surrogate, meeting.id, () => {
        driver.emit('queue:reorder', { id: queueIds[1], afterId: null });
      });

      // --- queue:closedChanged ---
      await runStep('queue:closedChanged (close)', driver, surrogate, meeting.id, () => {
        driver.emit('queue:setClosed', { closed: true });
      });
      await runStep('queue:closedChanged (open)', driver, surrogate, meeting.id, () => {
        driver.emit('queue:setClosed', { closed: false });
      });

      // --- queue:removed ---
      await runStep('queue:removed', driver, surrogate, meeting.id, () => {
        driver.emit('queue:remove', { id: queueIds[0] });
      });

      // --- speaker:advanced (queue:next pops the head into current) ---
      await runStep('speaker:advanced', driver, surrogate, meeting.id, () => {
        const currentSpeakerEntryId = ctx.meetingManager.get(meeting.id)!.current.speaker?.id ?? null;
        driver.emit('queue:next', { currentSpeakerEntryId }, () => {});
      });

      // --- poll:started ---
      await runStep('poll:started', driver, surrogate, meeting.id, () => {
        driver.emit('poll:start', {
          options: [
            { emoji: '👍', label: 'Yes' },
            { emoji: '👎', label: 'No' },
          ],
          topic: 'Continue?',
          multiSelect: true,
        });
      });

      // --- poll:reacted ---
      await runStep('poll:reacted', driver, surrogate, meeting.id, () => {
        const optionId = ctx.meetingManager.get(meeting.id)!.poll!.options[0].id;
        driver.emit('poll:react', { optionId });
      });

      // --- poll:stopped ---
      await runStep('poll:stopped', driver, surrogate, meeting.id, () => {
        driver.emit('poll:stop');
      });

      // --- agenda:advanced (advance past first → second item) ---
      await runStep('agenda:advanced (advance)', driver, surrogate, meeting.id, () => {
        const currentAgendaItemId = ctx.meetingManager.get(meeting.id)!.current.agendaItemId ?? null;
        driver.emit('meeting:nextAgendaItem', { currentAgendaItemId }, () => {});
      });

      // --- agenda:deleted (item) ---
      // Add a third item then delete it so we exercise the
      // `currentCleared: false` branch (deleting a non-current item).
      await runStep('agenda:added (item 3)', driver, surrogate, meeting.id, () => {
        driver.emit('agenda:add', { name: 'Third', presenters: [{ handle: 'testuser' }] });
      });
      const thirdItemId = ctx.meetingManager.get(meeting.id)!.agenda.at(-1)!.id;
      await runStep('agenda:deleted (item)', driver, surrogate, meeting.id, () => {
        driver.emit('agenda:delete', { id: thirdItemId });
      });

      // --- agenda:prologueSet (set, then clear) ---
      await runStep('agenda:prologueSet (set)', driver, surrogate, meeting.id, () => {
        driver.emit('agenda:setPrologue', { prologue: '# welcome\n\n- one\n- two' });
      });
      await runStep('agenda:prologueSet (clear)', driver, surrogate, meeting.id, () => {
        driver.emit('agenda:setPrologue', { prologue: '' });
      });

      // --- agenda:epilogueSet (set, then clear) ---
      await runStep('agenda:epilogueSet (set)', driver, surrogate, meeting.id, () => {
        driver.emit('agenda:setEpilogue', { epilogue: 'thanks **everyone**' });
      });
      await runStep('agenda:epilogueSet (clear)', driver, surrogate, meeting.id, () => {
        driver.emit('agenda:setEpilogue', { epilogue: '' });
      });

      surrogate.detach();
      observerSocket.disconnect();

      // Final sanity: the version cursor advanced exactly once per
      // mutation step. 27 mutations were emitted above (23 original +
      // 2 prologue + 2 epilogue); the bootstrap `state` doesn't bump
      // the counter, so the surrogate ends at 27.
      expect(surrogate.lastSeenVersion).toBe(27);
    });
  });

  // -- Multi-client convergence ----------------------------------------
  // The delta architecture's correctness depends on every connected
  // socket receiving the same delta in the same order. A bug that
  // emitted with `socket.emit` instead of `io.to(roomId).emit`, or one
  // that dropped a delta for a specific socket, would let two clients
  // diverge while neither's gap detection fires. The tests below
  // connect multiple surrogate observers, drive mutations from one
  // client, and assert every observer ends up byte-equal to the
  // server's state and to each other.
  describe('multi-client convergence', () => {
    const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });

    /**
     * Same `joinWithSurrogate` shape as the gap-detection block, but
     * inlined here to keep the two test suites independent.
     */
    async function joinWithSurrogate(meetingId: string) {
      const socket = makeClient();
      await new Promise<void>((r) => socket.on('connect', r));
      const surrogate = createClientSurrogate(socket);
      socket.emit('join', meetingId);
      await surrogate.waitForVersion(0);
      return { socket, surrogate };
    }

    /**
     * Strip operational fields that legitimately diverge between
     * server and clients: `lastAdvancementBy` is a one-shot signal
     * cleared on the server after each advance, and
     * `lastConnectionTime` / `maxConcurrent` are admin-dashboard
     * bookkeeping the server updates on connect/disconnect without
     * propagating via deltas.
     */
    function normalise(state: import('@tcq/shared').MeetingState | null | undefined) {
      if (!state) return state;
      const {
        lastAdvancementBy: _ignored,
        lastConnectionTime: _t,
        maxConcurrent: _m,
        ...operationalRest
      } = state.operational;
      return { ...state, operational: operationalRest };
    }

    it('three surrogates converge after a sequence of mutations', async () => {
      const meeting = ctx.meetingManager.create([owner]);
      const driver = await joinMeeting(meeting.id);
      const a = await joinWithSurrogate(meeting.id);
      const b = await joinWithSurrogate(meeting.id);
      const c = await joinWithSurrogate(meeting.id);

      // Drive a sequence of mutations of different types.
      driver.emit('agenda:add', { name: 'Item 1', presenters: [{ handle: 'testuser' }] });
      driver.emit('agenda:add', { name: 'Item 2', presenters: [{ handle: 'testuser' }] });
      driver.emit('queue:setClosed', { closed: true });
      driver.emit('queue:setClosed', { closed: false });

      // Wait for every observer to have applied all four deltas.
      await Promise.all([a.surrogate.waitForVersion(4), b.surrogate.waitForVersion(4), c.surrogate.waitForVersion(4)]);

      const expected = normalise(ctx.meetingManager.get(meeting.id));
      expect(normalise(a.surrogate.state)).toEqual(expected);
      expect(normalise(b.surrogate.state)).toEqual(expected);
      expect(normalise(c.surrogate.state)).toEqual(expected);

      a.surrogate.detach();
      b.surrogate.detach();
      c.surrogate.detach();
      a.socket.disconnect();
      b.socket.disconnect();
      c.socket.disconnect();
    });

    it('a delta dropped on one socket does not affect convergence on others', async () => {
      const meeting = ctx.meetingManager.create([owner]);
      const driver = await joinMeeting(meeting.id);
      const a = await joinWithSurrogate(meeting.id);
      const b = await joinWithSurrogate(meeting.id);

      // Drop the next delta on `a` only — `b` should still apply it
      // normally and never need a resync.
      a.surrogate.options.dropNext = true;

      driver.emit('agenda:add', { name: 'Skipped on a', presenters: [{ handle: 'testuser' }] });
      // `a` records the drop; `b` records the apply.
      await Promise.all([a.surrogate.waitForNextEvent(), b.surrogate.waitForVersion(1)]);
      expect(b.surrogate.state?.agenda).toHaveLength(1);
      expect(a.surrogate.lastSeenVersion).toBe(0); // dropped, didn't advance

      // Subsequent mutation: `a` detects a gap and resyncs; `b` applies
      // the delta normally. Both end up at version 2 and equivalent.
      driver.emit('agenda:add', { name: 'Triggers a resync', presenters: [{ handle: 'testuser' }] });
      await Promise.all([a.surrogate.waitForVersion(2), b.surrogate.waitForVersion(2)]);

      expect(a.surrogate.resyncRequestCount).toBe(1);
      expect(b.surrogate.resyncRequestCount).toBe(0);

      const expected = normalise(ctx.meetingManager.get(meeting.id));
      expect(normalise(a.surrogate.state)).toEqual(expected);
      expect(normalise(b.surrogate.state)).toEqual(expected);

      a.surrogate.detach();
      b.surrogate.detach();
      a.socket.disconnect();
      b.socket.disconnect();
    });

    it('surrogates that join late see post-mutation state via bootstrap', async () => {
      const meeting = ctx.meetingManager.create([owner]);
      const driver = await joinMeeting(meeting.id);

      // Apply some mutations before the late observer joins.
      driver.emit('agenda:add', { name: 'Pre-join 1', presenters: [{ handle: 'testuser' }] });
      driver.emit('agenda:add', { name: 'Pre-join 2', presenters: [{ handle: 'testuser' }] });
      // Wait for the second mutation to land on the server before the
      // late observer joins, otherwise the bootstrap state would be
      // empty and any incoming delta would arrive in-flight.
      await new Promise<void>((resolve) => {
        const check = () => {
          if ((ctx.meetingManager.get(meeting.id)?.agenda.length ?? 0) >= 2) resolve();
          else setTimeout(check, 10);
        };
        check();
      });

      const late = await joinWithSurrogate(meeting.id);
      expect(late.surrogate.state?.agenda).toHaveLength(2);
      expect(late.surrogate.lastSeenVersion).toBe(2);

      // After joining, a further mutation arrives as a delta and applies
      // on top of the bootstrapped state.
      driver.emit('agenda:add', { name: 'Post-join', presenters: [{ handle: 'testuser' }] });
      await late.surrogate.waitForVersion(3);
      expect(late.surrogate.state?.agenda).toHaveLength(3);

      late.surrogate.detach();
      late.socket.disconnect();
    });
  });

  // -- Out-of-order delivery -------------------------------------------
  // Production sockets deliver in order, so the only way to reach the
  // application layer with deltas in a non-version order is via a
  // failure further down (a buggy proxy, a stalled connection, a
  // socket.io transport quirk, a future `transport: ['polling']`
  // fallback). The client's gap detector is the load-bearing defence:
  // if any delta arrives out of sequence, it must trigger a resync
  // and the surrogate must converge to the canonical server state.
  //
  // The tests below use the surrogate's `reorderNext` hook to
  // synthesise out-of-order arrival, then assert convergence. The
  // exact resync count is part of the assertion where it pins down a
  // useful invariant (e.g. only the gapped deltas trigger resync).
  describe('out-of-order delivery', () => {
    const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });

    /** Same join-with-surrogate shape as the convergence block above. */
    async function joinWithSurrogate(meetingId: string) {
      const socket = makeClient();
      await new Promise<void>((r) => socket.on('connect', r));
      const surrogate = createClientSurrogate(socket);
      socket.emit('join', meetingId);
      await surrogate.waitForVersion(0);
      return { socket, surrogate };
    }

    /** Strip server-only operational fields, same as the convergence block. */
    function normalise(state: import('@tcq/shared').MeetingState | null | undefined) {
      if (!state) return state;
      const {
        lastAdvancementBy: _ignored,
        lastConnectionTime: _t,
        maxConcurrent: _m,
        ...operationalRest
      } = state.operational;
      return { ...state, operational: operationalRest };
    }

    it('stale agenda:reorder applied after newer one — converges via resync', async () => {
      const meeting = ctx.meetingManager.create([owner]);
      const driver = await joinMeeting(meeting.id);
      const a = await joinWithSurrogate(meeting.id);

      // Build up a 3-item agenda that the observer can apply normally.
      driver.emit('agenda:add', { name: 'A', presenters: [{ handle: 'testuser' }] });
      driver.emit('agenda:add', { name: 'B', presenters: [{ handle: 'testuser' }] });
      driver.emit('agenda:add', { name: 'C', presenters: [{ handle: 'testuser' }] });
      await a.surrogate.waitForVersion(3);
      const idB = ctx.meetingManager.get(meeting.id)!.agenda[1].id;
      const idC = ctx.meetingManager.get(meeting.id)!.agenda[2].id;

      // The next two reorders arrive on the wire in reverse, so the
      // observer sees the newer reorder first (gap → resync) and then
      // the older one as a duplicate that gets applied by version
      // and immediately superseded when the resync state arrives.
      a.surrogate.reorderNext(2);
      driver.emit('agenda:reorder', { id: idB, afterId: null });
      driver.emit('agenda:reorder', { id: idC, afterId: null });

      await a.surrogate.waitForVersion(5);
      expect(normalise(a.surrogate.state)).toEqual(normalise(ctx.meetingManager.get(meeting.id)));
      // Only the out-of-order delta triggered a gap; the in-order one
      // matched its expected version and applied without resync.
      expect(a.surrogate.resyncRequestCount).toBe(1);

      a.surrogate.detach();
      a.socket.disconnect();
    });

    it('stale queue:reorder applied after newer one — converges via resync', async () => {
      const meeting = ctx.meetingManager.create([owner]);
      const driver = await joinMeeting(meeting.id);
      const a = await joinWithSurrogate(meeting.id);

      // Two queue entries, then two reorders.
      driver.emit('queue:add', { type: 'topic', topic: 'first' });
      driver.emit('queue:add', { type: 'topic', topic: 'second' });
      await a.surrogate.waitForVersion(2);
      const ids = ctx.meetingManager.get(meeting.id)!.queue.orderedIds;

      a.surrogate.reorderNext(2);
      driver.emit('queue:reorder', { id: ids[1], afterId: null });
      driver.emit('queue:reorder', { id: ids[0], afterId: null });

      await a.surrogate.waitForVersion(4);
      expect(normalise(a.surrogate.state)).toEqual(normalise(ctx.meetingManager.get(meeting.id)));
      expect(a.surrogate.resyncRequestCount).toBe(1);

      a.surrogate.detach();
      a.socket.disconnect();
    });

    it('stale chairs:updated applied after newer one — converges via resync', async () => {
      const meeting = ctx.meetingManager.create([owner]);
      const driver = await joinMeeting(meeting.id);
      const a = await joinWithSurrogate(meeting.id);

      // Two chair updates back-to-back, with the second strictly
      // larger so the wrong order would visibly diverge state.
      a.surrogate.reorderNext(2);
      driver.emit('meeting:updateChairs', { chairs: [{ handle: 'testuser' }, { handle: 'second' }] });
      driver.emit('meeting:updateChairs', {
        chairs: [{ handle: 'testuser' }, { handle: 'second' }, { handle: 'third' }],
      });

      await a.surrogate.waitForVersion(2);
      expect(normalise(a.surrogate.state)).toEqual(normalise(ctx.meetingManager.get(meeting.id)));
      expect(a.surrogate.state?.chairIds).toHaveLength(3);
      expect(a.surrogate.resyncRequestCount).toBe(1);

      a.surrogate.detach();
      a.socket.disconnect();
    });

    it('queue:next arrives before its prerequisite queue:add — converges via resync', async () => {
      const meeting = ctx.meetingManager.create([owner]);
      const driver = await joinMeeting(meeting.id);
      const a = await joinWithSurrogate(meeting.id);

      // The advance references a speaker the surrogate hasn't seen
      // added yet (in wire order). The gap detector is the only thing
      // that can save state here — applying the advance before the add
      // would mean operating on a queue entry the reducer doesn't know
      // about.
      a.surrogate.reorderNext(2);
      driver.emit('queue:add', { type: 'topic', topic: 'topic to advance to' });
      driver.emit('queue:next', { currentSpeakerEntryId: null }, () => {});

      await a.surrogate.waitForVersion(2);
      expect(normalise(a.surrogate.state)).toEqual(normalise(ctx.meetingManager.get(meeting.id)));
      expect(a.surrogate.state?.current.speaker).not.toBeNull();
      expect(a.surrogate.resyncRequestCount).toBe(1);

      a.surrogate.detach();
      a.socket.disconnect();
    });

    it('after a reorder-induced resync, subsequent in-order deltas apply normally', async () => {
      const meeting = ctx.meetingManager.create([owner]);
      const driver = await joinMeeting(meeting.id);
      const a = await joinWithSurrogate(meeting.id);

      // Step 1: induce a resync via reorder.
      a.surrogate.reorderNext(2);
      driver.emit('agenda:add', { name: 'A', presenters: [{ handle: 'testuser' }] });
      driver.emit('agenda:add', { name: 'B', presenters: [{ handle: 'testuser' }] });
      await a.surrogate.waitForVersion(2);
      expect(a.surrogate.resyncRequestCount).toBe(1);

      // Step 2: a follow-up delta should apply without another resync.
      // This pins down that the resync codepath leaves the surrogate
      // in a clean state — `lastSeenVersion` matches the server's, so
      // the next delta lands on `expected` rather than producing yet
      // another gap.
      driver.emit('agenda:add', { name: 'C', presenters: [{ handle: 'testuser' }] });
      await a.surrogate.waitForVersion(3);
      expect(a.surrogate.resyncRequestCount).toBe(1); // unchanged
      expect(normalise(a.surrogate.state)).toEqual(normalise(ctx.meetingManager.get(meeting.id)));

      a.surrogate.detach();
      a.socket.disconnect();
    });

    it('reorder around a precondition-protected event — converges via resync', async () => {
      const meeting = ctx.meetingManager.create([owner]);
      const driver = await joinMeeting(meeting.id);
      const a = await joinWithSurrogate(meeting.id);

      // Establish a queue entry first (in-order on the surrogate).
      driver.emit('queue:add', { type: 'topic', topic: 'first' });
      await a.surrogate.waitForVersion(1);

      // Now reorder a queue:add with a queue:next that depends on the
      // current speaker precondition. The advance arrives first on the
      // wire, but the gap detector forces a resync so we never apply
      // the advance against a stale queue.
      a.surrogate.reorderNext(2);
      driver.emit('queue:add', { type: 'topic', topic: 'second' });
      driver.emit('queue:next', { currentSpeakerEntryId: null }, () => {});

      await a.surrogate.waitForVersion(3);
      expect(normalise(a.surrogate.state)).toEqual(normalise(ctx.meetingManager.get(meeting.id)));
      // Server should have advanced — the precondition matched at
      // emit time on the driver side (current speaker was null).
      expect(a.surrogate.state?.current.speaker).not.toBeNull();
      expect(a.surrogate.resyncRequestCount).toBe(1);

      a.surrogate.detach();
      a.socket.disconnect();
    });

    it('three surrogates with divergent reorderings all converge to server state', async () => {
      const meeting = ctx.meetingManager.create([owner]);
      const driver = await joinMeeting(meeting.id);
      const a = await joinWithSurrogate(meeting.id);
      const b = await joinWithSurrogate(meeting.id);
      const c = await joinWithSurrogate(meeting.id);

      // Three different permutations of the next four deltas. Each
      // surrogate's resync count varies (depending on how many gaps
      // its permutation produces) but all must converge to the same
      // final state. This is the strongest version of the convergence
      // claim: order-independence under arbitrary wire-order
      // scrambling.
      a.surrogate.reorderNext(4); // default: full reverse
      b.surrogate.reorderNext(4, [1, 3, 0, 2]);
      c.surrogate.reorderNext(4, [0, 2, 1, 3]);

      driver.emit('agenda:add', { name: 'I1', presenters: [{ handle: 'testuser' }] });
      driver.emit('agenda:add', { name: 'I2', presenters: [{ handle: 'testuser' }] });
      driver.emit('queue:setClosed', { closed: true });
      driver.emit('queue:setClosed', { closed: false });

      await Promise.all([a.surrogate.waitForVersion(4), b.surrogate.waitForVersion(4), c.surrogate.waitForVersion(4)]);

      const expected = normalise(ctx.meetingManager.get(meeting.id));
      expect(normalise(a.surrogate.state)).toEqual(expected);
      expect(normalise(b.surrogate.state)).toEqual(expected);
      expect(normalise(c.surrogate.state)).toEqual(expected);
      // Each permutation produces at least one out-of-order arrival
      // (the first delivered delta has version > expected), so each
      // surrogate triggers at least one resync.
      expect(a.surrogate.resyncRequestCount).toBeGreaterThanOrEqual(1);
      expect(b.surrogate.resyncRequestCount).toBeGreaterThanOrEqual(1);
      expect(c.surrogate.resyncRequestCount).toBeGreaterThanOrEqual(1);

      a.surrogate.detach();
      b.surrogate.detach();
      c.surrogate.detach();
      a.socket.disconnect();
      b.socket.disconnect();
      c.socket.disconnect();
    });

    it('mixed-type reorder (agenda:add and meeting:nextAgendaItem) — converges via resync', async () => {
      const meeting = ctx.meetingManager.create([owner]);
      const driver = await joinMeeting(meeting.id);
      // Create an initial agenda item the meeting can advance into.
      driver.emit('agenda:add', { name: 'I1', presenters: [{ handle: 'testuser' }] });

      const a = await joinWithSurrogate(meeting.id);
      // Surrogate joined after the first add — bootstrap seeds at v1.
      // Reorder the next two deltas (a second add and an advance).
      a.surrogate.reorderNext(2);
      driver.emit('agenda:add', { name: 'I2', presenters: [{ handle: 'testuser' }] });
      driver.emit('meeting:nextAgendaItem', { currentAgendaItemId: null }, () => {});

      await a.surrogate.waitForVersion(3);
      expect(normalise(a.surrogate.state)).toEqual(normalise(ctx.meetingManager.get(meeting.id)));
      // Confirm the advance landed: agenda is no longer un-started.
      expect(a.surrogate.state?.current.agendaItemId).not.toBeNull();
      expect(a.surrogate.resyncRequestCount).toBe(1);

      a.surrogate.detach();
      a.socket.disconnect();
    });
  });

  // -- Delay / latency -------------------------------------------------
  // Drops and significant delays look the same to the gap detector
  // until enough time has passed: a delta that takes 5 s to arrive is
  // indistinguishable from a delta that's gone for the first 4.999 s.
  // The tests below distinguish the two by actually delivering the
  // late delta and asserting how the surrogate handles it.
  //
  // Three scenarios that *can't* easily be tested through the live
  // socket and are intentionally absent:
  //
  //   - **Bootstrap state arriving after deltas.** Socket.IO emits
  //     `state` in response to `join` before any delta is broadcast
  //     to the joining socket, so a real wire can't produce this
  //     ordering without a custom transport.
  //
  //   - **Optimistic UI under delayed acks.** The client doesn't
  //     paint optimistic state for queue:add or any other emit — the
  //     UI waits for the broadcast — so there is no optimistic codepath
  //     to delay-test.
  //
  //   - **Surrogate-driven reconnect on long partition.** The
  //     surrogate's `partition` hook just buffers; it doesn't model a
  //     resync threshold. The reconnect-and-rejoin codepath is
  //     covered by the existing "reconnect re-emits state and re-seeds
  //     the surrogate" test in the gap-detection block above.
  describe('premium-tier stamping on broadcast', () => {
    it('marks premium users with isPremium:true and omits the field for non-premium users', async () => {
      // The connecting user (TEST_USER, ghUsername=testuser) is premium; the
      // second chair is not. The emitted state should carry isPremium:true
      // on the premium user and have no isPremium key at all on the other,
      // so absence stays the bandwidth-saving default.
      await ctx.appSettings.addPremiumUsername('testuser');
      const otherChair: User = githubUser({ id: 5, login: 'plainuser', name: 'Plain User', organisation: '' });
      const meeting = ctx.meetingManager.create([TEST_USER, otherChair]);

      const client = makeClient();
      const statePromise = waitForEvent<MeetingState>(client, 'state');
      await new Promise<void>((r) => client.on('connect', r));
      client.emit('join', meeting.id);
      const state = await statePromise;

      expect(state.users[userKey(TEST_USER)].isPremium).toBe(true);
      expect('isPremium' in state.users[userKey(otherChair)]).toBe(false);
    });

    it('stamps isPremium on delta-piggybacked user records too', async () => {
      // Make the joining client premium; when they add a queue entry, the
      // resulting queue:added delta piggybacks their User record — which
      // should also carry the isPremium flag.
      await ctx.appSettings.addPremiumUsername('testuser');
      const meeting = ctx.meetingManager.create([TEST_USER]);
      // Advance to an agenda item so the queue is open for entries.
      const item: AgendaItem = { kind: 'item', id: 'a1', name: 'Item 1', presenterIds: [] };
      const mgr = ctx.meetingManager.get(meeting.id)!;
      mgr.agenda.push(item);
      mgr.current.agendaItemId = item.id;

      const client = await joinMeeting(meeting.id);
      const deltaPromise = waitForEvent<{ users?: Record<string, User> }>(client, 'queue:added');
      client.emit('queue:add', { type: 'topic', topic: 'Hello' });
      const delta = await deltaPromise;
      const piggybacked = delta.users?.[userKey(TEST_USER)];
      expect(piggybacked?.isPremium).toBe(true);
    });

    it('broadcastPremiumChange re-emits state to rooms where the affected user is present', async () => {
      // Simulates an admin adding a username to the premium list: only
      // meetings whose users map contains that username should receive a
      // fresh `state` event. We hook the io.to(...).emit machinery so we
      // can count emissions per room without depending on a second
      // connected client per meeting.
      const otherUser: User = githubUser({ id: 6, login: 'about-to-be-premium', name: 'P', organisation: '' });
      const containingMeeting = ctx.meetingManager.create([TEST_USER, otherUser]);
      const unrelatedMeeting = ctx.meetingManager.create([TEST_USER]);

      const emitsPerRoom = new Map<string, number>();
      const origTo = ctx.io.to.bind(ctx.io);
      vi.spyOn(ctx.io, 'to').mockImplementation((room: string | string[]) => {
        // BroadcastOperator.to accepts string|string[]; the broadcast
        // helper only ever passes a single room id, but we narrow here
        // to satisfy the typed signature.
        const roomId = Array.isArray(room) ? room.join(',') : room;
        const real = origTo(room);
        return new Proxy(real, {
          get(target, prop, recv) {
            if (prop === 'emit') {
              return (event: string, ..._args: unknown[]) => {
                if (event === 'state') emitsPerRoom.set(roomId, (emitsPerRoom.get(roomId) ?? 0) + 1);
                return true;
              };
            }
            return Reflect.get(target, prop, recv);
          },
        });
      });

      const { broadcastPremiumChange } = await import('./socket.js');
      // broadcastPremiumChange takes a bare GitHub handle (what
      // AppSettingsManager.add/removePremiumUsername returns), since premium
      // membership is matched by handle.
      broadcastPremiumChange(ctx.io, ctx.meetingManager, ctx.appSettings, otherUser.handle!);

      expect(emitsPerRoom.get(containingMeeting.id) ?? 0).toBe(1);
      expect(emitsPerRoom.get(unrelatedMeeting.id) ?? 0).toBe(0);
    });
  });

  describe('delay and partition', () => {
    const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });

    async function joinWithSurrogate(meetingId: string) {
      const socket = makeClient();
      await new Promise<void>((r) => socket.on('connect', r));
      const surrogate = createClientSurrogate(socket);
      socket.emit('join', meetingId);
      await surrogate.waitForVersion(0);
      return { socket, surrogate };
    }

    function normalise(state: import('@tcq/shared').MeetingState | null | undefined) {
      if (!state) return state;
      const {
        lastAdvancementBy: _ignored,
        lastConnectionTime: _t,
        maxConcurrent: _m,
        ...operationalRest
      } = state.operational;
      return { ...state, operational: operationalRest };
    }

    it('a single delayed delta eventually applies and produces no resync', async () => {
      const meeting = ctx.meetingManager.create([owner]);
      const driver = await joinMeeting(meeting.id);
      const a = await joinWithSurrogate(meeting.id);

      a.surrogate.delayNext('agenda:added', 100);
      driver.emit('agenda:add', { name: 'late but only one', presenters: [{ handle: 'testuser' }] });

      // Synchronously after the emit, the surrogate hasn't processed
      // the broadcast yet — the delta is parked in the delay timer.
      expect(a.surrogate.lastSeenVersion).toBe(0);

      // Wait for the timer to fire and the delta to apply normally.
      await a.surrogate.waitForVersion(1);
      // No gap was ever seen — the in-order delta arrived late but
      // alone, so there's nothing to resync from.
      expect(a.surrogate.resyncRequestCount).toBe(0);
      expect(normalise(a.surrogate.state)).toEqual(normalise(ctx.meetingManager.get(meeting.id)));

      a.surrogate.detach();
      a.socket.disconnect();
    });

    it('a delayed delta followed by a fresh one triggers gap detection on the fresh one', async () => {
      const meeting = ctx.meetingManager.create([owner]);
      const driver = await joinMeeting(meeting.id);
      const a = await joinWithSurrogate(meeting.id);

      // Hold the next agenda:added for long enough that the follow-up
      // mutation arrives first and forces a resync.
      a.surrogate.delayNext('agenda:added', 200);
      driver.emit('agenda:add', { name: 'held', presenters: [{ handle: 'testuser' }] });
      driver.emit('queue:setClosed', { closed: true });

      // The closed-changed delta is processed immediately and gaps
      // (expected v1, got v2). Resync repairs the divergence.
      await a.surrogate.waitForVersion(2);
      expect(a.surrogate.resyncRequestCount).toBe(1);
      const stateAfterResync = a.surrogate.state;
      expect(normalise(stateAfterResync)).toEqual(normalise(ctx.meetingManager.get(meeting.id)));

      // Wait long enough that the held delta's timer has definitely
      // fired. The processDelta call on it should classify it as a
      // late duplicate (delta.version <= lastSeenVersion) and silently
      // drop it without disturbing state or counters.
      await new Promise((r) => setTimeout(r, 250));
      expect(a.surrogate.lastSeenVersion).toBe(2);
      expect(a.surrogate.resyncRequestCount).toBe(1);
      expect(normalise(a.surrogate.state)).toEqual(normalise(stateAfterResync));

      a.surrogate.detach();
      a.socket.disconnect();
    });

    it('partition flushes a buffered burst in arrival order without resyncing', async () => {
      const meeting = ctx.meetingManager.create([owner]);
      const driver = await joinMeeting(meeting.id);
      const a = await joinWithSurrogate(meeting.id);

      // Block delivery long enough to capture the whole burst, then
      // drive five mutations of mixed types. Server processes them
      // serially on the driver's socket, so they reach the observer
      // in version order — the partition holds them while they pile
      // up.
      a.surrogate.partition(150);
      driver.emit('agenda:add', { name: 'A', presenters: [{ handle: 'testuser' }] });
      driver.emit('agenda:add', { name: 'B', presenters: [{ handle: 'testuser' }] });
      driver.emit('queue:setClosed', { closed: true });
      driver.emit('agenda:add', { name: 'C', presenters: [{ handle: 'testuser' }] });
      driver.emit('queue:setClosed', { closed: false });

      // Mid-partition: buffer is filling but nothing has been processed.
      await new Promise((r) => setTimeout(r, 50));
      expect(a.surrogate.lastSeenVersion).toBe(0);
      expect(a.surrogate.resyncRequestCount).toBe(0);

      // After the partition timer fires, the buffer is flushed in
      // arrival order. Every delta hits processDelta with the
      // expected version, so none triggers a gap.
      await a.surrogate.waitForVersion(5);
      expect(a.surrogate.resyncRequestCount).toBe(0);
      expect(normalise(a.surrogate.state)).toEqual(normalise(ctx.meetingManager.get(meeting.id)));

      a.surrogate.detach();
      a.socket.disconnect();
    });

    it('a stale delayed delta arriving after a resync is discarded as a late duplicate', async () => {
      const meeting = ctx.meetingManager.create([owner]);
      const driver = await joinMeeting(meeting.id);
      const a = await joinWithSurrogate(meeting.id);

      // Hold v1 well past the point at which v2 arrives, gaps, and
      // the resync state event lands. By the time the timer for v1
      // fires, the surrogate's lastSeenVersion has already been
      // bumped to >= 2 by the resync, so v1 must be treated as a
      // late duplicate.
      a.surrogate.delayNext('agenda:added', 200);
      driver.emit('agenda:add', { name: 'held', presenters: [{ handle: 'testuser' }] });
      driver.emit('queue:setClosed', { closed: true });
      await a.surrogate.waitForVersion(2);

      const eventCountBeforeLate = a.surrogate.events.length;
      const versionAfterResync = a.surrogate.lastSeenVersion;
      const resyncCountAfterResync = a.surrogate.resyncRequestCount;

      // Wait through the timer. processDelta runs on the held delta
      // but takes the silent-drop branch — no events.push, no
      // state:resync, no state mutation.
      await new Promise((r) => setTimeout(r, 250));
      expect(a.surrogate.events.length).toBe(eventCountBeforeLate);
      expect(a.surrogate.lastSeenVersion).toBe(versionAfterResync);
      expect(a.surrogate.resyncRequestCount).toBe(resyncCountAfterResync);

      a.surrogate.detach();
      a.socket.disconnect();
    });
  });

  // -- Concurrent emits ------------------------------------------------
  // The existing precondition-guard tests in this file simulate
  // contention by sequencing operations server-side: chair A's mutation
  // is invoked directly via the meeting manager, then chair B emits
  // through a real socket carrying a now-stale precondition. That
  // proves the guard's logical correctness, but the actual JS event
  // loop interleaving — what the server sees when two emits arrive on
  // separate sockets at the same instant — is never exercised. The
  // tests below close that gap. Each one fires N emits on N sockets
  // through `Promise.all`, so the server's I/O dispatch picks the
  // ordering, and the precondition guards must hold under that real
  // interleaving rather than a contrived sequence.
  //
  // What is *not* covered here:
  //
  //   - **3.7 (chairs:update vs advance).** This requires two
  //     distinct authenticated identities on the same server; the
  //     test scaffolding currently authenticates every socket as the
  //     same `TEST_USER` via session middleware. Adding multi-user
  //     auth is non-trivial (it would touch `createTestServer` and
  //     the socket connection helper) and the resulting test would
  //     duplicate per-event permission checks already covered
  //     elsewhere. Left out deliberately.
  describe('concurrent emits', () => {
    const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });

    async function joinWithSurrogate(meetingId: string) {
      const socket = makeClient();
      await new Promise<void>((r) => socket.on('connect', r));
      const surrogate = createClientSurrogate(socket);
      socket.emit('join', meetingId);
      await surrogate.waitForVersion(0);
      return { socket, surrogate };
    }

    function normalise(state: import('@tcq/shared').MeetingState | null | undefined) {
      if (!state) return state;
      const {
        lastAdvancementBy: _ignored,
        lastConnectionTime: _t,
        maxConcurrent: _m,
        ...operationalRest
      } = state.operational;
      return { ...state, operational: operationalRest };
    }

    /** Convenience: emit with an ack and resolve with the response. */
    function emitWithAck(
      socket: TypedClientSocket,
      event: 'queue:next',
      payload: { currentSpeakerEntryId: string | null },
    ) {
      return new Promise<{ ok: boolean; error?: string }>((resolve) => {
        socket.emit(event, payload, resolve);
      });
    }

    /** Same shape for meeting:nextAgendaItem. */
    function emitAdvanceAgenda(socket: TypedClientSocket, currentAgendaItemId: string | null) {
      return new Promise<{ ok: boolean; error?: string }>((resolve) => {
        socket.emit('meeting:nextAgendaItem', { currentAgendaItemId }, resolve);
      });
    }

    it('two concurrent queue:next emits — exactly one wins via the precondition guard', async () => {
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'First', owner);
      ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'Second', owner);

      const a = await joinMeeting(meeting.id);
      const b = await joinMeeting(meeting.id);

      // Both sockets see no current speaker, so both ack with the
      // same precondition. The server's per-emit handler must
      // serialise them: the first lands and updates state, the
      // second sees a now-stale precondition and rejects.
      const [r1, r2] = await emitInParallel(
        () => emitWithAck(a, 'queue:next', { currentSpeakerEntryId: null }),
        () => emitWithAck(b, 'queue:next', { currentSpeakerEntryId: null }),
      );

      const successes = [r1, r2].filter((r) => r.ok);
      const failures = [r1, r2].filter((r) => !r.ok);
      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);
      expect(failures[0].error).toMatch(/already advanced/i);

      // Speaker advanced exactly once: head of the queue is now
      // current, queue still holds the other entry.
      const after = ctx.meetingManager.get(meeting.id)!;
      expect(after.current.speaker?.topic).toBe('First');
      expect(after.queue.orderedIds).toHaveLength(1);
    });

    it('two concurrent meeting:nextAgendaItem emits — exactly one wins via the precondition guard', async () => {
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'I1', [owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'I2', [owner]);

      const a = await joinMeeting(meeting.id);
      const b = await joinMeeting(meeting.id);

      const [r1, r2] = await emitInParallel(
        () => emitAdvanceAgenda(a, null),
        () => emitAdvanceAgenda(b, null),
      );

      const successes = [r1, r2].filter((r) => r.ok);
      const failures = [r1, r2].filter((r) => !r.ok);
      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);
      expect(failures[0].error).toMatch(/already advanced|another chair/i);

      const after = ctx.meetingManager.get(meeting.id)!;
      expect(after.current.agendaItemId).toBe(after.agenda[0].id);
    });

    it('two concurrent agenda:reorder emits on different items — both succeed and observers converge', async () => {
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'A', [owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'B', [owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'C', [owner]);

      const a = await joinMeeting(meeting.id);
      const b = await joinMeeting(meeting.id);
      const observer = await joinWithSurrogate(meeting.id);

      const seed = ctx.meetingManager.get(meeting.id)!;
      const idB = seed.agenda[1].id;
      const idC = seed.agenda[2].id;

      // Both reorders move different items. agenda:reorder has no
      // ack and no version-style precondition, so both should land
      // and the server's serialisation order determines the final
      // arrangement. The strong assertion is convergence: an
      // observer surrogate ends byte-equal to the canonical state.
      a.emit('agenda:reorder', { id: idB, afterId: null });
      b.emit('agenda:reorder', { id: idC, afterId: null });

      await observer.surrogate.waitForVersion(2);
      expect(normalise(observer.surrogate.state)).toEqual(normalise(ctx.meetingManager.get(meeting.id)));

      observer.surrogate.detach();
      observer.socket.disconnect();
    });

    it('two concurrent queue:add emits — both entries land and observers converge', async () => {
      const meeting = ctx.meetingManager.create([owner]);
      const a = await joinMeeting(meeting.id);
      const b = await joinMeeting(meeting.id);
      const observer = await joinWithSurrogate(meeting.id);

      // queue:add of `topic` type has no precondition; concurrent
      // adds should not interfere with each other. This is the
      // "false positive" half of the guard: a guard that rejected
      // both would silently lose an entry.
      a.emit('queue:add', { type: 'topic', topic: 'from a' });
      b.emit('queue:add', { type: 'topic', topic: 'from b' });

      await observer.surrogate.waitForVersion(2);
      const final = ctx.meetingManager.get(meeting.id)!;
      expect(final.queue.orderedIds).toHaveLength(2);
      const topics = final.queue.orderedIds.map((id) => final.queue.entries[id].topic).sort();
      expect(topics).toEqual(['from a', 'from b']);
      expect(normalise(observer.surrogate.state)).toEqual(normalise(final));

      observer.surrogate.detach();
      observer.socket.disconnect();
    });

    /**
     * Seed a meeting's queue via real emits (rather than the
     * `meetingManager.*` helpers) so the user records on the meeting
     * state include the same `isAdmin` field the session middleware
     * adds. Mixing direct-manager seeds with emit-driven mutations
     * leaves a divergence in `users[testuser]` that the convergence
     * assertion would otherwise pick up.
     */
    async function seedQueue(driver: TypedClientSocket, meetingId: string, topics: string[]) {
      for (const topic of topics) driver.emit('queue:add', { type: 'topic', topic });
      await new Promise<void>((resolve) => {
        const check = () => {
          if ((ctx.meetingManager.get(meetingId)?.queue.orderedIds.length ?? 0) >= topics.length) resolve();
          else setTimeout(check, 5);
        };
        check();
      });
    }

    it('concurrent queue:add and queue:next — final state is internally consistent', async () => {
      const meeting = ctx.meetingManager.create([owner]);
      const driver = await joinMeeting(meeting.id);
      // Seed via real emit so the user record on `meeting.users` matches
      // what the session-driven mutations below will produce.
      await seedQueue(driver, meeting.id, ['pre-existing']);

      const a = await joinMeeting(meeting.id);
      const b = await joinMeeting(meeting.id);
      const observer = await joinWithSurrogate(meeting.id);

      // Whichever lands first determines the outcome:
      //   - add then advance: queue has the new entry, speaker is
      //     the pre-existing one.
      //   - advance then add: speaker is the pre-existing one,
      //     queue has the new entry.
      // Either way: speaker is the pre-existing entry, queue holds
      // exactly the new entry. Pin that down.
      a.emit('queue:add', { type: 'topic', topic: 'added concurrently' });
      const advanceAck = emitWithAck(b, 'queue:next', { currentSpeakerEntryId: null });

      const ack = await advanceAck;
      // The advance always succeeds — there's a queue entry to pop
      // (either pre-existing alone, or with the new entry behind it).
      expect(ack.ok).toBe(true);

      // Bootstrap is at v1 (after the seed emit). Add and advance
      // produce v2 and v3.
      await observer.surrogate.waitForVersion(3);
      const final = ctx.meetingManager.get(meeting.id)!;
      expect(final.current.speaker?.topic).toBe('pre-existing');
      expect(final.queue.orderedIds).toHaveLength(1);
      expect(final.queue.entries[final.queue.orderedIds[0]].topic).toBe('added concurrently');
      expect(normalise(observer.surrogate.state)).toEqual(normalise(final));

      observer.surrogate.detach();
      observer.socket.disconnect();
    });

    it('concurrent queue:next and queue:edit on a non-head entry — both succeed, no lost edit', async () => {
      const meeting = ctx.meetingManager.create([owner]);
      const driver = await joinMeeting(meeting.id);
      await seedQueue(driver, meeting.id, ['head', 'second']);
      const seedQueueIds = ctx.meetingManager.get(meeting.id)!.queue.orderedIds;
      const secondId = seedQueueIds[1];

      const a = await joinMeeting(meeting.id);
      const b = await joinMeeting(meeting.id);
      const observer = await joinWithSurrogate(meeting.id);

      // Advance pops the head; edit modifies the second entry's
      // topic. The two operations target disjoint state so neither
      // should clobber the other regardless of order.
      const [advance] = await emitInParallel(
        () => emitWithAck(a, 'queue:next', { currentSpeakerEntryId: null }),
        () =>
          new Promise<void>((resolve) => {
            b.emit('queue:edit', { id: secondId, topic: 'second (edited)' });
            // queue:edit has no ack; resolve once the server has had
            // a chance to process it. Convergence on the observer
            // pins down whether the edit actually landed.
            setImmediate(resolve);
          }),
      );

      expect(advance.ok).toBe(true);
      // Bootstrap is at v2 (after two seed emits). Advance and edit
      // produce v3 and v4.
      await observer.surrogate.waitForVersion(4);
      const final = ctx.meetingManager.get(meeting.id)!;
      expect(final.current.speaker?.topic).toBe('head');
      expect(final.queue.orderedIds).toEqual([secondId]);
      expect(final.queue.entries[secondId].topic).toBe('second (edited)');
      expect(normalise(observer.surrogate.state)).toEqual(normalise(final));

      observer.surrogate.detach();
      observer.socket.disconnect();
    });

    it('storm: ten concurrent queue:add emits — all land, version sequence is contiguous', async () => {
      const meeting = ctx.meetingManager.create([owner]);
      const observer = await joinWithSurrogate(meeting.id);

      // Ten distinct sockets, each firing a queue:add at the same
      // microtask tick. The server processes them serially but in
      // arbitrary order. Final queue size must be exactly ten, and
      // the observer's lastSeenVersion must be exactly ten — a
      // dropped or merged delta would surface as a wrong count or
      // a contiguity gap.
      const sockets = await Promise.all(Array.from({ length: 10 }, () => joinMeeting(meeting.id)));
      const thunks = sockets.map(
        (s, i) => () =>
          new Promise<void>((resolve) => {
            s.emit('queue:add', { type: 'topic', topic: `entry ${i}` });
            setImmediate(resolve);
          }),
      );
      await emitInParallel(...thunks);

      await observer.surrogate.waitForVersion(10);
      const final = ctx.meetingManager.get(meeting.id)!;
      expect(final.queue.orderedIds).toHaveLength(10);
      expect(final.operational.version).toBe(10);
      // Surrogate's events log every applied delta with its version;
      // contiguity from v1..v10 means no broadcast was lost.
      const appliedVersions = observer.surrogate.events.filter((e) => e.event === 'queue:added').map((e) => e.version);
      expect(appliedVersions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(normalise(observer.surrogate.state)).toEqual(normalise(final));

      observer.surrogate.detach();
      observer.socket.disconnect();
    });
  });

  // -- Emit semantics: deliberate at-least-once -----------------------
  // The protocol does NOT guarantee exactly-once delivery for
  // client-to-server emits. There are no idempotency keys and no
  // server-side request-ID dedup; each emit handler runs once per
  // packet and creates whatever state it creates. For
  // precondition-guarded events (queue:next, meeting:nextAgendaItem)
  // and natural state-setters (queue:edit, queue:closedChanged,
  // meeting:updateChairs) this is invisible — duplicate emits collapse
  // via stale preconditions or overwrite-with-the-same-value. For
  // *append* events like queue:add it isn't: two emits create two
  // entries. The protection against accidental double-submits is
  // client-side (forms close on submit, advance buttons debounce) —
  // not a wire-level guarantee.
  //
  // The test below pins this design choice down. If a future change
  // adds server-side dedup (idempotency keys, request IDs, content
  // hashing), this test will fail and force a deliberate update —
  // which is the point. It's a tripwire, not a behaviour we're
  // celebrating.
  describe('at-least-once emit semantics', () => {
    it('two queue:add emits on the same socket create two distinct entries', async () => {
      const owner = githubUser({ id: 1, login: 'testuser', name: 'Test User', organisation: 'Test Org' });
      const meeting = ctx.meetingManager.create([owner]);
      const driver = await joinMeeting(meeting.id);

      // Same socket, same payload, fired back-to-back without any
      // intervening await. Socket.IO processes them serially and the
      // queue:add handler is invoked twice, each creating its own
      // UUID-keyed entry.
      driver.emit('queue:add', { type: 'topic', topic: 'duplicate' });
      driver.emit('queue:add', { type: 'topic', topic: 'duplicate' });

      // Wait until both have landed server-side. Polling here rather
      // than relying on a surrogate keeps the test focused on the
      // server's at-least-once semantics — what reaches the meeting
      // state is the assertion that pins down the design.
      await new Promise<void>((resolve) => {
        const check = () => {
          if ((ctx.meetingManager.get(meeting.id)?.queue.orderedIds.length ?? 0) >= 2) resolve();
          else setTimeout(check, 5);
        };
        check();
      });

      const final = ctx.meetingManager.get(meeting.id)!;
      // Both emits produced an entry — they are distinguishable only
      // by their server-assigned UUIDs.
      expect(final.queue.orderedIds).toHaveLength(2);
      const topics = final.queue.orderedIds.map((id) => final.queue.entries[id].topic);
      expect(topics).toEqual(['duplicate', 'duplicate']);
      expect(final.queue.orderedIds[0]).not.toBe(final.queue.orderedIds[1]);
    });
  });
});
