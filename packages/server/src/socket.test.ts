import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import session from 'express-session';
import { createServer, type Server as HttpServer } from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import type {
  AgendaEntry,
  AgendaItem,
  MeetingState,
  ClientToServerEvents,
  ServerToClientEvents,
  User,
} from '@tcq/shared';
import { asUserKey, isAgendaItem } from '@tcq/shared';
import type { MeetingStore } from './store.js';
import { MeetingManager } from './meetings.js';
import { registerSocketHandlers } from './socket.js';
import { toSessionUser } from './session.js';

// --- Helpers ---

/** Narrow an entry we expect to be an agenda item — fails if it's not. */
function asItem(entry: AgendaEntry | undefined): AgendaItem {
  if (!entry || !isAgendaItem(entry)) throw new Error('expected an AgendaItem');
  return entry;
}

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

/** Typed client socket matching our event interfaces (reversed: client receives ServerToClient). */
type TypedClientSocket = ClientSocket<ServerToClientEvents, ClientToServerEvents>;

interface TestContext {
  httpServer: HttpServer;
  io: SocketIOServer<ClientToServerEvents, ServerToClientEvents>;
  meetingManager: MeetingManager;
  baseUrl: string;
}

/** The default test user — used by most socket tests as the session identity. */
const TEST_USER: User = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };

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

  const io = new SocketIOServer<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    cors: { origin: '*', credentials: true },
  });

  // Share session with Socket.IO (same as production setup)
  io.engine.use(sessionMiddleware);
  io.engine.use(authMiddleware);

  registerSocketHandlers(io, meetingManager);

  return { httpServer, io, meetingManager, baseUrl: '' };
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
  });
}

/** Wait for a socket event and return the payload. */
function waitForEvent<T>(socket: TypedClientSocket, event: string): Promise<T> {
  return new Promise((resolve) => {
    socket.once(event as any, (data: T) => resolve(data));
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
      {
        ghid: 1,
        ghUsername: 'testuser',
        name: 'Test User',
        organisation: 'Test Org',
      },
    ]);

    // Connect a client and join the meeting
    const client = makeClient();
    const statePromise = waitForEvent<MeetingState>(client, 'state');

    await new Promise<void>((resolve) => {
      client.on('connect', () => {
        client.emit('join', meeting.id);
        resolve();
      });
    });

    const state = await statePromise;
    expect(state.id).toBe(meeting.id);
    expect(state.chairIds).toHaveLength(1);
    expect(state.users[state.chairIds[0]].ghUsername).toBe('testuser');
    expect(state.agenda).toEqual([]);
    expect(state.queue.orderedIds).toEqual([]);
  });

  it('two clients in the same meeting both receive state', async () => {
    const meeting = ctx.meetingManager.create([
      {
        ghid: 1,
        ghUsername: 'testuser',
        name: 'Test User',
        organisation: 'Test Org',
      },
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

  it('does not receive state when joining a non-existent meeting', async () => {
    const client = makeClient();

    await new Promise<void>((r) => client.on('connect', r));

    // Join a meeting that doesn't exist
    client.emit('join', 'no-such-meeting');

    // Wait a short time — no state event should arrive
    const received = await Promise.race([
      waitForEvent<MeetingState>(client, 'state').then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 200)),
    ]);

    expect(received).toBe(false);
  });

  // -- Agenda events --

  /** Helper: connect a client, join a meeting, and wait for initial state. */
  async function joinMeeting(meetingId: string): Promise<TypedClientSocket> {
    const client = makeClient();
    const statePromise = waitForEvent<MeetingState>(client, 'state');
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
        {
          ghid: 1,
          ghUsername: 'testuser',
          name: 'Test User',
          organisation: 'Test Org',
        },
      ]);

      const client = await joinMeeting(meeting.id);

      // Listen for the state update after adding
      const statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('agenda:add', { name: 'First item', presenterUsernames: ['testuser'], duration: 15 });
      const state = await statePromise;

      expect(state.agenda).toHaveLength(1);
      const first = asItem(state.agenda[0]);
      expect(first.name).toBe('First item');
      expect(state.users[first.presenterIds[0]].ghUsername).toBe('testuser');
      expect(first.duration).toBe(15);
    });

    it('broadcasts to all clients in the meeting', async () => {
      const meeting = ctx.meetingManager.create([
        {
          ghid: 1,
          ghUsername: 'testuser',
          name: 'Test User',
          organisation: 'Test Org',
        },
      ]);

      const client1 = await joinMeeting(meeting.id);
      const client2 = await joinMeeting(meeting.id);

      // Client 2 waits for the broadcast
      const state2Promise = waitForEvent<MeetingState>(client2, 'state');
      client1.emit('agenda:add', { name: 'Broadcast test', presenterUsernames: ['testuser'] });
      const state2 = await state2Promise;

      expect(state2.agenda).toHaveLength(1);
      expect(state2.agenda[0].name).toBe('Broadcast test');
    });

    it('rejects add from non-chair', async () => {
      // Create meeting where chair is someone else (ghid: 99)
      const meeting = ctx.meetingManager.create([
        {
          ghid: 99,
          ghUsername: 'chairperson',
          name: 'Chair',
          organisation: '',
        },
      ]);

      const client = await joinMeeting(meeting.id);

      // Listen for error
      const errorPromise = waitForEvent<string>(client, 'error');
      client.emit('agenda:add', { name: 'Should fail', presenterUsernames: ['testuser'] });
      const error = await errorPromise;

      expect(error).toMatch(/only chairs/i);
      // Agenda should still be empty
      expect(ctx.meetingManager.get(meeting.id)!.agenda).toHaveLength(0);
    });
  });

  describe('agenda:delete', () => {
    it('deletes an agenda item and broadcasts updated state', async () => {
      const meeting = ctx.meetingManager.create([
        {
          ghid: 1,
          ghUsername: 'testuser',
          name: 'Test User',
          organisation: 'Test Org',
        },
      ]);
      const item = ctx.meetingManager.addAgendaItem(meeting.id, 'To delete', [
        {
          ghid: 1,
          ghUsername: 'testuser',
          name: 'Test User',
          organisation: 'Test Org',
        },
      ])!;

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('agenda:delete', { id: item.id });
      const state = await statePromise;

      expect(state.agenda).toHaveLength(0);
    });
  });

  describe('agenda:reorder', () => {
    it('reorders agenda items and broadcasts updated state', async () => {
      const meeting = ctx.meetingManager.create([
        {
          ghid: 1,
          ghUsername: 'testuser',
          name: 'Test User',
          organisation: 'Test Org',
        },
      ]);
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      ctx.meetingManager.addAgendaItem(meeting.id, 'A', [owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'B', [owner]);
      const itemC = ctx.meetingManager.addAgendaItem(meeting.id, 'C', [owner])!;

      const client = await joinMeeting(meeting.id);

      // Move C to the beginning (afterId: null)
      const statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('agenda:reorder', { id: itemC.id, afterId: null });
      const state = await statePromise;

      expect(state.agenda.map((i) => i.name)).toEqual(['C', 'A', 'B']);
    });

    it('reorders a session entry through the same protocol', async () => {
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);
      const itemA = ctx.meetingManager.addAgendaItem(meeting.id, 'A', [owner])!;
      const session = ctx.meetingManager.addSession(meeting.id, 'Block', 30)!;
      const itemB = ctx.meetingManager.addAgendaItem(meeting.id, 'B', [owner])!;

      const client = await joinMeeting(meeting.id);
      const statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('agenda:reorder', { id: session.id, afterId: null });
      const state = await statePromise;

      expect(state.agenda.map((e) => e.id)).toEqual([session.id, itemA.id, itemB.id]);
    });
  });

  describe('agenda:edit', () => {
    it('edits an agenda item and broadcasts updated state', async () => {
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);
      const item = ctx.meetingManager.addAgendaItem(meeting.id, 'Old name', [owner])!;

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('agenda:edit', { id: item.id, name: 'New name' });
      const state = await statePromise;

      expect(state.agenda[0].name).toBe('New name');
    });

    it('rejects edit from non-chair', async () => {
      // Meeting where chair is someone else (ghid: 99)
      const meeting = ctx.meetingManager.create([
        {
          ghid: 99,
          ghUsername: 'chairperson',
          name: 'Chair',
          organisation: '',
        },
      ]);
      const item = ctx.meetingManager.addAgendaItem(meeting.id, 'Item', [
        {
          ghid: 99,
          ghUsername: 'chairperson',
          name: 'Chair',
          organisation: '',
        },
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
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);

      const client = await joinMeeting(meeting.id);
      const statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('session:add', { name: 'Morning block', capacity: 90 });
      const state = await statePromise;

      expect(state.agenda).toHaveLength(1);
      const entry = state.agenda[0];
      expect(entry).toMatchObject({ kind: 'session', name: 'Morning block', capacity: 90 });
    });

    it('rejects non-positive capacity', async () => {
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);

      const client = await joinMeeting(meeting.id);
      const errorPromise = waitForEvent<string>(client, 'error');
      client.emit('session:add', { name: 'Block', capacity: 0 });
      await errorPromise;
      expect(ctx.meetingManager.get(meeting.id)!.agenda).toHaveLength(0);
    });

    it('rejects empty name', async () => {
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);

      const client = await joinMeeting(meeting.id);
      const errorPromise = waitForEvent<string>(client, 'error');
      client.emit('session:add', { name: '   ', capacity: 30 });
      await errorPromise;
      expect(ctx.meetingManager.get(meeting.id)!.agenda).toHaveLength(0);
    });

    it('rejects add from non-chair', async () => {
      const meeting = ctx.meetingManager.create([
        { ghid: 99, ghUsername: 'chairperson', name: 'Chair', organisation: '' },
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
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);
      const session = ctx.meetingManager.addSession(meeting.id, 'Old', 30)!;

      const client = await joinMeeting(meeting.id);
      const statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('session:edit', { id: session.id, name: 'New', capacity: 45 });
      const state = await statePromise;

      expect(state.agenda[0]).toMatchObject({ kind: 'session', name: 'New', capacity: 45 });
    });

    it('rejects edit from non-chair', async () => {
      const meeting = ctx.meetingManager.create([
        { ghid: 99, ghUsername: 'chairperson', name: 'Chair', organisation: '' },
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
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);
      const session = ctx.meetingManager.addSession(meeting.id, 'Block', 30)!;
      ctx.meetingManager.addAgendaItem(meeting.id, 'Contained', [owner]);

      const client = await joinMeeting(meeting.id);
      const statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('session:delete', { id: session.id });
      const state = await statePromise;

      expect(state.agenda).toHaveLength(1);
      expect(state.agenda[0]).toMatchObject({ name: 'Contained' });
    });

    it('rejects delete from non-chair', async () => {
      const meeting = ctx.meetingManager.create([
        { ghid: 99, ghUsername: 'chairperson', name: 'Chair', organisation: '' },
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
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('queue:add', { type: 'topic', topic: 'My topic' });
      const state = await statePromise;

      expect(state.queue.orderedIds).toHaveLength(1);
      const entry = state.queue.entries[state.queue.orderedIds[0]];
      expect(entry.type).toBe('topic');
      expect(entry.topic).toBe('My topic');
      expect(state.users[entry.userId].ghUsername).toBe('testuser');
    });

    it('inserts entries in priority order', async () => {
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);

      const client = await joinMeeting(meeting.id);

      // Add a topic first, then a point-of-order
      let statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('queue:add', { type: 'topic', topic: 'Low priority' });
      await statePromise;

      statePromise = waitForEvent<MeetingState>(client, 'state');
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
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'Item', [owner]);

      const client = await joinMeeting(meeting.id);

      // Start meeting — intro speaker is current, no current.topic yet
      let statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('meeting:nextAgendaItem', { currentAgendaItemId: meeting.current.agendaItemId ?? null }, () => {});
      let state = await statePromise;

      // Add a topic-type entry and advance to it — this sets current.topic
      statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('queue:add', { type: 'topic', topic: 'Real topic' });
      state = await statePromise;

      statePromise = waitForEvent<MeetingState>(client, 'state');
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
      const statePromise = waitForEvent<MeetingState>(client, 'state');
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

    it('bypasses the precondition when the chair adds a reply via asUsername', async () => {
      const { client, meetingId } = await setupWithCurrentTopic();

      // No currentTopicSpeakerId; the asUsername path is a chair-driven
      // admin operation (e.g. Restore Queue) and skips the race guard.
      const statePromise = waitForEvent<MeetingState>(client, 'state');
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
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('queue:add', { type: 'topic', topic: 'Their topic', asUsername: 'alice' });
      const state = await statePromise;

      expect(state.queue.orderedIds).toHaveLength(1);
      const entry = state.queue.entries[state.queue.orderedIds[0]];
      expect(state.users[entry.userId].ghUsername).toBe('alice');
      expect(entry.topic).toBe('Their topic');
    });

    it('resolves known users from the meeting when using asUsername', async () => {
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);
      // Add an agenda item owned by a known user with a full profile
      ctx.meetingManager.addAgendaItem(meeting.id, 'Item', [
        {
          ghid: 42,
          ghUsername: 'knownuser',
          name: 'Known User',
          organisation: 'ACME',
        },
      ]);

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('queue:add', { type: 'topic', topic: 'Test', asUsername: 'knownuser' });
      const state = await statePromise;

      // Should use the full profile, not a placeholder
      const entry = state.queue.entries[state.queue.orderedIds[0]];
      expect(state.users[entry.userId].name).toBe('Known User');
      expect(state.users[entry.userId].organisation).toBe('ACME');
    });

    it('creates a placeholder user for unknown asUsername', async () => {
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('queue:add', { type: 'topic', topic: 'Test', asUsername: 'unknownperson' });
      const state = await statePromise;

      const entry = state.queue.entries[state.queue.orderedIds[0]];
      expect(state.users[entry.userId].ghUsername).toBe('unknownperson');
      expect(state.users[entry.userId].name).toBe('unknownperson');
    });

    it('rejects asUsername from non-chair', async () => {
      // Meeting where chair is someone else
      const meeting = ctx.meetingManager.create([
        {
          ghid: 99,
          ghUsername: 'chairperson',
          name: 'Chair',
          organisation: '',
        },
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

  describe('queue:remove', () => {
    it('removes own entry from the queue', async () => {
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);

      const client = await joinMeeting(meeting.id);

      // Add an entry
      let statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('queue:add', { type: 'topic', topic: 'Remove me' });
      const stateAfterAdd = await statePromise;
      const entryId = stateAfterAdd.queue.orderedIds[0];

      // Remove it
      statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('queue:remove', { id: entryId });
      const state = await statePromise;

      expect(state.queue.orderedIds).toHaveLength(0);
    });

    it("rejects removal of another user's entry by non-chair", async () => {
      // Meeting where chair is someone else
      const meeting = ctx.meetingManager.create([
        {
          ghid: 99,
          ghUsername: 'chairperson',
          name: 'Chair',
          organisation: '',
        },
      ]);
      // Add an entry by a different user
      const entry = ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'Not yours', {
        ghid: 99,
        ghUsername: 'chairperson',
        name: 'Chair',
        organisation: '',
      })!;

      const client = await joinMeeting(meeting.id);

      const errorPromise = waitForEvent<string>(client, 'error');
      client.emit('queue:remove', { id: entry.id });
      const error = await errorPromise;

      expect(error).toMatch(/your own/i);
    });
  });

  describe('queue:reorder', () => {
    it('reorders queue entries and broadcasts updated state', async () => {
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'A', owner);
      ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'B', owner);
      const c = ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'C', owner)!;

      const client = await joinMeeting(meeting.id);

      // Move C to the beginning
      const statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('queue:reorder', { id: c.id, afterId: null });
      const state = await statePromise;

      expect(state.queue.orderedIds.map((id) => state.queue.entries[id].topic)).toEqual(['C', 'A', 'B']);
    });

    it('changes entry type when crossing a type boundary', async () => {
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.addQueueEntry(meeting.id, 'question', 'Q', owner);
      const t = ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'T', owner)!;

      const client = await joinMeeting(meeting.id);

      // Move topic before question — should change to question type
      const statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('queue:reorder', { id: t.id, afterId: null });
      const state = await statePromise;

      expect(state.queue.orderedIds[0]).toBe(t.id);
      expect(state.queue.entries[state.queue.orderedIds[0]].type).toBe('question');
    });

    it('rejects non-owner non-chair from reordering', async () => {
      const meeting = ctx.meetingManager.create([
        {
          ghid: 99,
          ghUsername: 'chairperson',
          name: 'Chair',
          organisation: '',
        },
      ]);
      // Entry owned by the chair, not the mock test user
      const entry = ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'A', {
        ghid: 99,
        ghUsername: 'chairperson',
        name: 'Chair',
        organisation: '',
      })!;

      const client = await joinMeeting(meeting.id);

      const errorPromise = waitForEvent<string>(client, 'error');
      client.emit('queue:reorder', { id: entry.id, afterId: null });
      const error = await errorPromise;

      expect(error).toMatch(/your own/i);
    });

    it('allows owner to move their entry down but not up', async () => {
      // Meeting where testuser is NOT a chair
      const meeting = ctx.meetingManager.create([
        {
          ghid: 99,
          ghUsername: 'chairperson',
          name: 'Chair',
          organisation: '',
        },
      ]);
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const a = ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'A', owner)!;
      const b = ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'B', {
        ghid: 99,
        ghUsername: 'chairperson',
        name: 'Chair',
        organisation: '',
      })!;

      const client = await joinMeeting(meeting.id);

      // Moving own entry (A) after B (down) should succeed
      const statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('queue:reorder', { id: a.id, afterId: b.id });
      const state = await statePromise;
      expect(state.queue.orderedIds[0]).toBe(b.id);
      expect(state.queue.orderedIds[1]).toBe(a.id);
    });

    it('rejects owner moving up over a non-owner directly above', async () => {
      // Meeting where testuser is NOT a chair
      const chair = { ghid: 99, ghUsername: 'chairperson', name: 'Chair', organisation: '' };
      const meeting = ctx.meetingManager.create([chair]);
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
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
      const other = { ghid: 42, ghUsername: 'someone-else', name: 'Other', organisation: '' };
      const a = ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'A', other)!;
      ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'B', other);
      const c = ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'C', other)!;

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('queue:reorder', { id: c.id, afterId: a.id });
      const state = await statePromise;

      expect(state.queue.orderedIds.map((id) => state.queue.entries[id].topic)).toEqual(['A', 'C', 'B']);
    });

    it('allows owner to move their entry up within their own block', async () => {
      // [A:chair, B:testuser, C:testuser] — testuser may move C above B
      // (their own contiguous block) but no further.
      const chair = { ghid: 99, ghUsername: 'chairperson', name: 'Chair', organisation: '' };
      const meeting = ctx.meetingManager.create([chair]);
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const a = ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'A', chair)!;
      const b = ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'B', owner)!;
      const c = ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'C', owner)!;

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('queue:reorder', { id: c.id, afterId: a.id });
      const state = await statePromise;

      expect(state.queue.orderedIds).toEqual([a.id, c.id, b.id]);
    });

    it('allows owner to move their entry to the top when all above are theirs', async () => {
      // [A:testuser, B:testuser, C:testuser] in a meeting chaired by
      // someone else — testuser may freely reorder among their block, all
      // the way to the top.
      const chair = { ghid: 99, ghUsername: 'chairperson', name: 'Chair', organisation: '' };
      const meeting = ctx.meetingManager.create([chair]);
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const a = ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'A', owner)!;
      const b = ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'B', owner)!;
      const c = ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'C', owner)!;

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('queue:reorder', { id: c.id, afterId: null });
      const state = await statePromise;

      expect(state.queue.orderedIds).toEqual([c.id, a.id, b.id]);
    });

    it('rejects owner upward move that crosses a non-owner entry', async () => {
      // [A:testuser, B:chair, C:testuser] — testuser tries to move C past
      // B (the chair's entry) to the top. The slice being jumped over
      // contains B, so the move is rejected.
      const chair = { ghid: 99, ghUsername: 'chairperson', name: 'Chair', organisation: '' };
      const meeting = ctx.meetingManager.create([chair]);
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
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
      const chair = { ghid: 99, ghUsername: 'chairperson', name: 'Chair', organisation: '' };
      const meeting = ctx.meetingManager.create([chair]);
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
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
      const chair = { ghid: 99, ghUsername: 'chairperson', name: 'Chair', organisation: '' };
      const meeting = ctx.meetingManager.create([chair]);
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
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
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);
      const entry = ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'Old topic', owner)!;

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('queue:edit', { id: entry.id, topic: 'New topic' });
      const state = await statePromise;

      expect(state.queue.entries[state.queue.orderedIds[0]].topic).toBe('New topic');
    });

    it('rejects edit from non-owner non-chair', async () => {
      // Meeting where chair is someone else (ghid: 99)
      const meeting = ctx.meetingManager.create([
        {
          ghid: 99,
          ghUsername: 'chairperson',
          name: 'Chair',
          organisation: '',
        },
      ]);
      // Queue entry created by the chair, not the mock test user
      const entry = ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'Not yours', {
        ghid: 99,
        ghUsername: 'chairperson',
        name: 'Chair',
        organisation: '',
      })!;

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
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const chair = { ghid: 99, ghUsername: 'chairperson', name: 'Chair', organisation: '' };
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
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);
      const entry = ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'Test', {
        ghid: 99,
        ghUsername: 'other',
        name: 'Other',
        organisation: '',
      })!;

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('queue:edit', { id: entry.id, type: 'question' });
      const state = await statePromise;

      expect(state.queue.entries[state.queue.orderedIds[0]].type).toBe('question');
    });

    it('allows chair to edit any entry', async () => {
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);
      // Entry created by someone else
      const entry = ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'Other topic', {
        ghid: 99,
        ghUsername: 'other',
        name: 'Other',
        organisation: '',
      })!;

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('queue:edit', { id: entry.id, topic: 'Chair edited' });
      const state = await statePromise;

      expect(state.queue.entries[state.queue.orderedIds[0]].topic).toBe('Chair edited');
    });
  });

  describe('queue:next', () => {
    it('advances to the next speaker and broadcasts', async () => {
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'First', owner);
      ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'Second', owner);

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('queue:next', { currentSpeakerEntryId: meeting.current.speaker?.id ?? null }, () => {});
      const state = await statePromise;

      expect(state.current.speaker?.topic).toBe('First');
      expect(state.queue.orderedIds).toHaveLength(1);
      expect(state.queue.entries[state.queue.orderedIds[0]].topic).toBe('Second');
    });

    it('sets currentTopic when advancing a topic-type entry', async () => {
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'New discussion', owner);

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('queue:next', { currentSpeakerEntryId: meeting.current.speaker?.id ?? null }, () => {});
      const state = await statePromise;

      expect(state.current.topic?.topic).toBe('New discussion');
    });

    it('clears the speaker when queue is empty', async () => {
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);
      // Set a current speaker and topic but leave queue empty
      const ownerKey = asUserKey('testuser');
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

      const statePromise = waitForEvent<MeetingState>(client, 'state');
      // Use the current speaker id as the precondition
      client.emit('queue:next', { currentSpeakerEntryId: meeting.current.speaker?.id ?? null }, () => {});
      const state = await statePromise;

      expect(state.current.speaker).toBeUndefined();
    });

    it('rejects conflicting advance when currentSpeakerEntryId does not match', async () => {
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
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
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
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
        {
          ghid: 99,
          ghUsername: 'chairperson',
          name: 'Chair',
          organisation: '',
        },
      ]);

      const client = await joinMeeting(meeting.id);

      const ackPromise = new Promise<any>((resolve) => {
        client.emit('queue:next', { currentSpeakerEntryId: null }, resolve);
      });
      const response = await ackPromise;

      expect(response.ok).toBe(false);
      expect(response.error).toMatch(/only chairs or the current speaker/i);
    });

    it('allows the current speaker (non-chair) to advance via "I\'m done speaking"', async () => {
      const chair = { ghid: 99, ghUsername: 'chairperson', name: 'Chair', organisation: '' };
      const speaker = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
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

      expect(response.ok).toBe(true);
    });

    it('rejects non-chair non-speaker from advancing', async () => {
      const chair = { ghid: 99, ghUsername: 'chairperson', name: 'Chair', organisation: '' };
      const otherUser = { ghid: 50, ghUsername: 'someone', name: 'Someone', organisation: '' };
      const meeting = ctx.meetingManager.create([chair]);
      ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'Their topic', otherUser);
      // Advance to make otherUser the current speaker (not testuser)
      ctx.meetingManager.nextSpeaker(meeting.id);

      const client = await joinMeeting(meeting.id);

      const ackPromise = new Promise<any>((resolve) => {
        client.emit('queue:next', { currentSpeakerEntryId: meeting.current.speaker?.id ?? null }, resolve);
      });
      const response = await ackPromise;

      expect(response.ok).toBe(false);
      expect(response.error).toMatch(/only chairs or the current speaker/i);
    });

    it('accepts advancement after unrelated mutations (queue edit)', async () => {
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
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
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
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
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('meeting:updateChairs', { usernames: ['testuser', 'newchair'] });
      const state = await statePromise;

      expect(state.chairIds).toHaveLength(2);
      const chairUsernames = state.chairIds.map((id) => state.users[id].ghUsername);
      expect(chairUsernames).toContain('testuser');
      expect(chairUsernames).toContain('newchair');
    });

    it('rejects from non-chair', async () => {
      const meeting = ctx.meetingManager.create([
        {
          ghid: 99,
          ghUsername: 'chairperson',
          name: 'Chair',
          organisation: '',
        },
      ]);

      const client = await joinMeeting(meeting.id);

      const errorPromise = waitForEvent<string>(client, 'error');
      client.emit('meeting:updateChairs', { usernames: ['testuser'] });
      const error = await errorPromise;

      expect(error).toMatch(/only chairs/i);
    });

    it('rejects empty chair list', async () => {
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);

      const client = await joinMeeting(meeting.id);

      const errorPromise = waitForEvent<string>(client, 'error');
      client.emit('meeting:updateChairs', { usernames: [] });
      const error = await errorPromise;

      expect(error).toMatch(/at least one/i);
    });

    it('rejects when the acting chair removes themselves', async () => {
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);

      const client = await joinMeeting(meeting.id);

      const errorPromise = waitForEvent<string>(client, 'error');
      client.emit('meeting:updateChairs', { usernames: ['someone-else'] });
      const error = await errorPromise;

      expect(error).toMatch(/cannot remove yourself/i);
    });

    it('resolves known users from the meeting', async () => {
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);
      // Add a known user via the agenda
      ctx.meetingManager.addAgendaItem(meeting.id, 'Item', [
        {
          ghid: 42,
          ghUsername: 'knownuser',
          name: 'Known User',
          organisation: 'ACME',
        },
      ]);

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('meeting:updateChairs', { usernames: ['testuser', 'knownuser'] });
      const state = await statePromise;

      const knownKey = state.chairIds.find((id) => state.users[id].ghUsername === 'knownuser')!;
      expect(state.users[knownKey]?.name).toBe('Known User');
      expect(state.users[knownKey]?.organisation).toBe('ACME');
    });
  });

  describe('meeting:updateChairs (admin)', () => {
    it('allows an admin to edit chairs for a meeting they do not chair', async () => {
      // Set testuser as admin
      vi.stubEnv('ADMIN_USERNAMES', 'testuser');

      // Meeting where testuser is NOT a chair
      const meeting = ctx.meetingManager.create([
        {
          ghid: 99,
          ghUsername: 'chairperson',
          name: 'Chair',
          organisation: '',
        },
      ]);

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('meeting:updateChairs', { usernames: ['newchair'] });
      const state = await statePromise;

      expect(state.chairIds).toHaveLength(1);
      expect(state.users[state.chairIds[0]].ghUsername).toBe('newchair');

      vi.unstubAllEnvs();
    });

    it('allows an admin to remove themselves from the chair list', async () => {
      vi.stubEnv('ADMIN_USERNAMES', 'testuser');

      const meeting = ctx.meetingManager.create([
        {
          ghid: 1,
          ghUsername: 'testuser',
          name: 'Test User',
          organisation: '',
        },
      ]);

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('meeting:updateChairs', { usernames: ['someone-else'] });
      const state = await statePromise;

      expect(state.chairIds).toHaveLength(1);
      expect(state.users[state.chairIds[0]].ghUsername).toBe('someone-else');

      vi.unstubAllEnvs();
    });

    it('allows an admin to set an empty chair list', async () => {
      vi.stubEnv('ADMIN_USERNAMES', 'testuser');

      const meeting = ctx.meetingManager.create([
        {
          ghid: 1,
          ghUsername: 'testuser',
          name: 'Test User',
          organisation: '',
        },
      ]);

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('meeting:updateChairs', { usernames: [] });
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
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('poll:start', { options: samplePollOptions });
      const state = await statePromise;

      expect(state.poll).toBeDefined();
      expect(state.poll!.options).toHaveLength(2);
      expect(state.poll!.options[0].emoji).toBe('❤️');
      expect(state.poll!.options[0].label).toBe('Love');
      expect(state.poll!.reactions).toHaveLength(0);
    });

    it('rejects with fewer than 2 options', async () => {
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);

      const client = await joinMeeting(meeting.id);

      const errorPromise = waitForEvent<string>(client, 'error');
      client.emit('poll:start', { options: [{ emoji: '👍', label: 'Only one' }] });
      const error = await errorPromise;

      expect(error).toMatch(/at least 2/i);
    });

    it('rejects from non-chair', async () => {
      const meeting = ctx.meetingManager.create([
        {
          ghid: 99,
          ghUsername: 'chairperson',
          name: 'Chair',
          organisation: '',
        },
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
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.startPoll(meeting.id, samplePollOptions, asUserKey('testuser'), undefined, true);

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('poll:stop');
      const state = await statePromise;

      expect(state.poll).toBeUndefined();
    });
  });

  describe('poll:react', () => {
    it('adds a reaction and broadcasts', async () => {
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.startPoll(meeting.id, samplePollOptions, asUserKey('testuser'), undefined, true);
      const optionId = meeting.poll!.options[0].id;

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('poll:react', { optionId });
      const state = await statePromise;

      expect(state.poll!.reactions).toHaveLength(1);
      expect(state.poll!.reactions[0].optionId).toBe(optionId);
      expect(state.users[state.poll!.reactions[0].userId].ghUsername).toBe('testuser');
    });

    it('toggles off an existing reaction', async () => {
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.startPoll(meeting.id, samplePollOptions, asUserKey('testuser'), undefined, true);
      const optionId = meeting.poll!.options[0].id;

      const client = await joinMeeting(meeting.id);

      // Add
      let statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('poll:react', { optionId });
      await statePromise;

      // Toggle off
      statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('poll:react', { optionId });
      const state = await statePromise;

      expect(state.poll!.reactions).toHaveLength(0);
    });

    it('rejects when poll is not active', async () => {
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
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
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'First topic', [owner]);

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('meeting:nextAgendaItem', { currentAgendaItemId: meeting.current.agendaItemId ?? null }, () => {});
      const state = await statePromise;

      expect(state.agenda.find((i) => i.id === state.current.agendaItemId)?.name).toBe('First topic');
      const speaker = state.current.speaker!;
      expect(state.users[speaker.userId].ghUsername).toBe('testuser');
      expect(speaker.topic).toBe('Introducing: First topic');
      expect(speaker.source).toBe('agenda');
    });

    it('advances to the next agenda item', async () => {
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'First', [owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'Second', [owner]);

      const client = await joinMeeting(meeting.id);

      // Start meeting
      let statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('meeting:nextAgendaItem', { currentAgendaItemId: meeting.current.agendaItemId ?? null }, () => {});
      const state1 = await statePromise;

      // Advance to second — use the currentAgendaItemId from the state we just received
      statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('meeting:nextAgendaItem', { currentAgendaItemId: state1.current.agendaItemId ?? null }, () => {});
      const state2 = await statePromise;

      expect(state2.agenda.find((i) => i.id === state2.current.agendaItemId)?.name).toBe('Second');
    });

    it('rejects from non-chair via ack', async () => {
      const meeting = ctx.meetingManager.create([
        {
          ghid: 99,
          ghUsername: 'chairperson',
          name: 'Chair',
          organisation: '',
        },
      ]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'Item', [
        {
          ghid: 99,
          ghUsername: 'chairperson',
          name: 'Chair',
          organisation: '',
        },
      ]);

      const client = await joinMeeting(meeting.id);

      const ackPromise = new Promise<any>((resolve) => {
        client.emit('meeting:nextAgendaItem', { currentAgendaItemId: null }, resolve);
      });
      const response = await ackPromise;

      expect(response.ok).toBe(false);
      expect(response.error).toMatch(/only chairs/i);
    });

    it('returns error via ack when no more agenda items', async () => {
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
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

      // Try to advance past end
      ackPromise = new Promise<any>((resolve) => {
        client.emit(
          'meeting:nextAgendaItem',
          { currentAgendaItemId: currentMeeting.current.agendaItemId ?? null },
          resolve,
        );
      });
      const response = await ackPromise;

      expect(response.ok).toBe(false);
      expect(response.error).toMatch(/no more agenda items/i);
    });

    it('rejects conflicting advance when currentAgendaItemId does not match', async () => {
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'First', [owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'Second', [owner]);

      const client = await joinMeeting(meeting.id);

      // Start meeting (advances to first item, so currentAgendaItemId changes)
      let statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('meeting:nextAgendaItem', { currentAgendaItemId: null }, () => {});
      await statePromise;

      // Try to advance again with null (the pre-start value) — should be rejected
      // because another advancement already happened
      statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('meeting:nextAgendaItem', { currentAgendaItemId: null }, () => {});
      const state = await statePromise;

      // Should still be on the first item (rejected, but got current state back)
      expect(state.agenda.find((i) => i.id === state.current.agendaItemId)?.name).toBe('First');
    });

    it('accepts advancement after unrelated mutations (queue add)', async () => {
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'First', [owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'Second', [owner]);

      const client = await joinMeeting(meeting.id);

      // Start meeting
      let statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('meeting:nextAgendaItem', { currentAgendaItemId: null }, () => {});
      const state1 = await statePromise;

      // Make an unrelated mutation — add a queue entry (bumps version but
      // doesn't change the current agenda item)
      ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'Discussion', owner);

      // Advance with the precondition from state1 — should succeed because
      // the current agenda item hasn't changed
      statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('meeting:nextAgendaItem', { currentAgendaItemId: state1.current.agendaItemId ?? null }, () => {});
      const state2 = await statePromise;

      expect(state2.agenda.find((i) => i.id === state2.current.agendaItemId)?.name).toBe('Second');
    });

    it('rejects when another chair already advanced the agenda item', async () => {
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
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
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);
      // Seed an obviously-wrong duration so we can verify it was overwritten,
      // not merely left alone.
      ctx.meetingManager.addAgendaItem(meeting.id, 'First', [owner], 999);
      ctx.meetingManager.addAgendaItem(meeting.id, 'Second', [owner]);

      const client = await joinMeeting(meeting.id);

      // Start meeting (advance to First).
      let statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('meeting:nextAgendaItem', { currentAgendaItemId: meeting.current.agendaItemId ?? null }, () => {});
      const state1 = await statePromise;
      const firstId = state1.current.agendaItemId!;

      // Let a handful of ms elapse so the rounding-up behaviour is exercised
      // with a positive duration rather than a same-millisecond collision.
      await new Promise((r) => setTimeout(r, 20));

      // Advance to Second — this completes First.
      statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('meeting:nextAgendaItem', { currentAgendaItemId: firstId }, () => {});
      const state2 = await statePromise;

      const first = asItem(state2.agenda.find((i) => i.id === firstId));
      // Pin to the log's duration to prove the exact Math.ceil(ms / 60000) relationship.
      const finished = state2.log.find(
        (e): e is Extract<typeof e, { type: 'agenda-item-finished' }> =>
          e.type === 'agenda-item-finished' && e.itemName === 'First',
      )!;
      expect(finished.duration).toBeGreaterThan(0);
      expect(first.duration).toBe(Math.ceil(finished.duration / 60000));
      // And specifically: the old 999 value was clobbered.
      expect(first.duration).toBeLessThan(999);
    });

    it("sets a duration on completion even if the item didn't have one", async () => {
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);
      // No duration on First.
      ctx.meetingManager.addAgendaItem(meeting.id, 'First', [owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'Second', [owner]);

      const client = await joinMeeting(meeting.id);

      let statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('meeting:nextAgendaItem', { currentAgendaItemId: meeting.current.agendaItemId ?? null }, () => {});
      const state1 = await statePromise;
      const firstId = state1.current.agendaItemId!;
      expect(asItem(state1.agenda.find((i) => i.id === firstId)).duration).toBeUndefined();

      // Same reason as above — ensure a positive elapsed duration.
      await new Promise((r) => setTimeout(r, 20));

      statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('meeting:nextAgendaItem', { currentAgendaItemId: firstId }, () => {});
      const state2 = await statePromise;

      const first = asItem(state2.agenda.find((i) => i.id === firstId));
      expect(first.duration).toBeGreaterThanOrEqual(1);
      expect(Number.isInteger(first.duration)).toBe(true);
    });
  });

  it('client can switch meetings by joining a different one', async () => {
    const meeting1 = ctx.meetingManager.create([
      {
        ghid: 1,
        ghUsername: 'testuser',
        name: 'Test User',
        organisation: 'Test Org',
      },
    ]);
    const meeting2 = ctx.meetingManager.create([
      {
        ghid: 2,
        ghUsername: 'other',
        name: 'Other User',
        organisation: 'Other Org',
      },
    ]);

    const client = makeClient();
    await new Promise<void>((r) => client.on('connect', r));

    // Join meeting 1
    let statePromise = waitForEvent<MeetingState>(client, 'state');
    client.emit('join', meeting1.id);
    let state = await statePromise;
    expect(state.id).toBe(meeting1.id);

    // Switch to meeting 2
    statePromise = waitForEvent<MeetingState>(client, 'state');
    client.emit('join', meeting2.id);
    state = await statePromise;
    expect(state.id).toBe(meeting2.id);
  });

  // -- Meeting log tests --

  describe('meeting log', () => {
    const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };

    it('logs meeting-started and agenda-item-started on first agenda advancement', async () => {
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'First Item', [owner]);

      const client = await joinMeeting(meeting.id);
      const statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('meeting:nextAgendaItem', { currentAgendaItemId: meeting.current.agendaItemId ?? null }, () => {});
      const state = await statePromise;

      expect(state.log).toHaveLength(2);
      expect(state.log[0].type).toBe('meeting-started');
      expect(state.log[1].type).toBe('agenda-item-started');
      expect(state.log[1].type === 'agenda-item-started' && state.log[1].itemName).toBe('First Item');
    });

    it('logs agenda-item-finished when advancing to the next item', async () => {
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'First Item', [owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'Second Item', [owner]);

      const client = await joinMeeting(meeting.id);

      // Start meeting (advance to first item)
      let statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('meeting:nextAgendaItem', { currentAgendaItemId: meeting.current.agendaItemId ?? null }, () => {});
      let state = await statePromise;

      // Advance to second item
      statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('meeting:nextAgendaItem', { currentAgendaItemId: state.current.agendaItemId ?? null }, () => {});
      state = await statePromise;

      // Should have: meeting-started, item-started(First), topic-discussed (intro), item-finished(First), item-started(Second)
      const finished = state.log.find((e) => e.type === 'agenda-item-finished');
      expect(finished).toBeDefined();
      expect(finished!.type === 'agenda-item-finished' && finished!.itemName).toBe('First Item');
      expect(finished!.type === 'agenda-item-finished' && finished!.duration).toBeGreaterThanOrEqual(0);
      expect(finished!.type === 'agenda-item-finished' && finished!.participantIds).toHaveLength(1);

      const secondStarted = state.log.filter((e) => e.type === 'agenda-item-started');
      expect(secondStarted).toHaveLength(2);
    });

    it('groups speakers under topic-discussed entries', async () => {
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'Item', [owner]);

      const client = await joinMeeting(meeting.id);

      // Start meeting
      let statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('meeting:nextAgendaItem', { currentAgendaItemId: meeting.current.agendaItemId ?? null }, () => {});
      let state = await statePromise;

      // Add a new topic to the queue and advance
      statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('queue:add', { type: 'topic', topic: 'My topic' });
      state = await statePromise;

      statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('queue:next', { currentSpeakerEntryId: state.current.speaker?.id ?? null }, () => {});
      state = await statePromise;

      // The introductory topic group should be finalised in the log
      const topicEntries = state.log.filter((e) => e.type === 'topic-discussed');
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

      // Start meeting
      let statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('meeting:nextAgendaItem', { currentAgendaItemId: meeting.current.agendaItemId ?? null }, () => {});
      let state = await statePromise;

      // Add a reply and advance to it. current.topic is undefined at this
      // point (the agenda intro doesn't count as a queued topic), so the
      // precondition is explicitly null.
      statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('queue:add', { type: 'reply', topic: 'My reply', currentTopicSpeakerId: null });
      state = await statePromise;

      statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('queue:next', { currentSpeakerEntryId: state.current.speaker?.id ?? null }, () => {});
      state = await statePromise;

      // Reply should be in the same topic group as the intro (not finalised yet)
      expect(state.current.topicSpeakers).toHaveLength(2);
      expect(state.current.topicSpeakers[1].type).toBe('reply');
      expect(state.current.topicSpeakers[1].topic).toBe('My reply');
    });

    it('excludes point-of-order speakers from topic groups', async () => {
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'Item', [owner]);

      const client = await joinMeeting(meeting.id);

      // Start meeting
      let statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('meeting:nextAgendaItem', { currentAgendaItemId: meeting.current.agendaItemId ?? null }, () => {});
      let state = await statePromise;

      // Add a point-of-order and advance to it
      statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('queue:add', { type: 'point-of-order', topic: 'POO' });
      state = await statePromise;

      statePromise = waitForEvent<MeetingState>(client, 'state');
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
      let statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('poll:start', {
        options: [
          { emoji: '👍', label: 'Yes' },
          { emoji: '👎', label: 'No' },
        ],
      });
      let state = await statePromise;

      // React to an option
      statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('poll:react', { optionId: state.poll!.options[0].id });
      state = await statePromise;

      // Stop the poll
      statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('poll:stop');
      state = await statePromise;

      const pollEntry = state.log.find((e) => e.type === 'poll-ran');
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
      let statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('meeting:nextAgendaItem', { currentAgendaItemId: meeting.current.agendaItemId ?? null }, () => {});
      let state = await statePromise;

      // Add entries to the queue
      statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('queue:add', { type: 'topic', topic: 'Leftover topic' });
      state = await statePromise;

      // Advance to next agenda item (leaving the queue non-empty)
      statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('meeting:nextAgendaItem', { currentAgendaItemId: state.current.agendaItemId ?? null }, () => {});
      state = await statePromise;

      const finished = state.log.find((e) => e.type === 'agenda-item-finished');
      expect(finished).toBeDefined();
      if (finished?.type === 'agenda-item-finished') {
        expect(finished.remainingQueue).toBeDefined();
        expect(finished.remainingQueue).toContain('Leftover topic');
        expect(finished.remainingQueue).toContain('testuser');
      }
    });

    it('does not include remainingQueue when queue is empty at advancement', async () => {
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'First', [owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'Second', [owner]);

      const client = await joinMeeting(meeting.id);

      // Start meeting
      let statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('meeting:nextAgendaItem', { currentAgendaItemId: meeting.current.agendaItemId ?? null }, () => {});
      let state = await statePromise;

      // Advance to next item with empty queue
      statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('meeting:nextAgendaItem', { currentAgendaItemId: state.current.agendaItemId ?? null }, () => {});
      state = await statePromise;

      const finished = state.log.find((e) => e.type === 'agenda-item-finished');
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
      let statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit(
        'meeting:nextAgendaItem',
        { currentAgendaItemId: null, conclusion: 'ignored — nothing to conclude' },
        () => {},
      );
      let state = await statePromise;

      // Advance past First with a conclusion
      const firstId = state.current.agendaItemId!;
      statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('meeting:nextAgendaItem', { currentAgendaItemId: firstId, conclusion: '  Decided X.  ' }, () => {});
      state = await statePromise;

      // Conclusion is trimmed and stored on the agenda item
      const firstItem = state.agenda.find(
        (e): e is import('@tcq/shared').AgendaItem => e.kind === 'item' && e.id === firstId,
      );
      expect(firstItem?.conclusion).toBe('Decided X.');

      // Conclusion is embedded in the snapshot log entry
      const finished = state.log.find((e) => e.type === 'agenda-item-finished');
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
      let statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('meeting:nextAgendaItem', { currentAgendaItemId: null }, () => {});
      let state = await statePromise;

      const firstId = state.current.agendaItemId!;

      // Advance past First with an empty conclusion (chair cleared the textarea).
      statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('meeting:nextAgendaItem', { currentAgendaItemId: firstId, conclusion: '   ' }, () => {});
      state = await statePromise;

      const firstItem = state.agenda.find(
        (e): e is import('@tcq/shared').AgendaItem => e.kind === 'item' && e.id === firstId,
      );
      expect(firstItem?.conclusion).toBeUndefined();

      const finished = state.log.find((e) => e.type === 'agenda-item-finished');
      if (finished?.type === 'agenda-item-finished') {
        expect(finished.conclusion).toBeUndefined();
      }
    });
  });

  describe('queue:setClosed', () => {
    it('chair can close and open the queue', async () => {
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);

      const client = await joinMeeting(meeting.id);

      // Close the queue
      let statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('queue:setClosed', { closed: true });
      let state = await statePromise;
      expect(state.queue.closed).toBe(true);

      // Re-open the queue
      statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('queue:setClosed', { closed: false });
      state = await statePromise;
      expect(state.queue.closed).toBe(false);
    });

    it('rejects from non-chair', async () => {
      const meeting = ctx.meetingManager.create([
        { ghid: 99, ghUsername: 'chairperson', name: 'Chair', organisation: '' },
      ]);

      const client = await joinMeeting(meeting.id);

      const errorPromise = waitForEvent<string>(client, 'error');
      client.emit('queue:setClosed', { closed: true });
      const error = await errorPromise;

      expect(error).toMatch(/only chairs/i);
    });

    it('non-chair queue:add rejected when queue is closed', async () => {
      const meeting = ctx.meetingManager.create([
        { ghid: 99, ghUsername: 'chairperson', name: 'Chair', organisation: '' },
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
        { ghid: 99, ghUsername: 'chairperson', name: 'Chair', organisation: '' },
      ]);
      // Close the queue — the joining user (testuser, ghid: 1) is not a chair
      ctx.meetingManager.setQueueClosed(meeting.id, true);

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('queue:add', { type: 'point-of-order', topic: 'Point of order' });
      const state = await statePromise;

      expect(state.queue.orderedIds).toHaveLength(1);
      const entry = state.queue.entries[state.queue.orderedIds[0]];
      expect(entry.type).toBe('point-of-order');
      expect(entry.topic).toBe('Point of order');
    });

    it('non-chair queue:add still rejected for non-POO types when queue is closed', async () => {
      const meeting = ctx.meetingManager.create([
        { ghid: 99, ghUsername: 'chairperson', name: 'Chair', organisation: '' },
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
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);
      // Close the queue
      ctx.meetingManager.setQueueClosed(meeting.id, true);

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('queue:add', { type: 'topic', topic: 'Chair entry' });
      const state = await statePromise;

      expect(state.queue.orderedIds).toHaveLength(1);
      expect(state.queue.entries[state.queue.orderedIds[0]].topic).toBe('Chair entry');
    });

    it('meeting:nextAgendaItem reopens the queue', async () => {
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'Item 1', [owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'Item 2', [owner]);

      const client = await joinMeeting(meeting.id);

      // Start the meeting (advances to first agenda item)
      let statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('meeting:nextAgendaItem', { currentAgendaItemId: meeting.current.agendaItemId ?? null }, () => {});
      let state = await statePromise;
      expect(state.queue.closed).toBe(false);

      // Close the queue
      statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('queue:setClosed', { closed: true });
      state = await statePromise;
      expect(state.queue.closed).toBe(true);

      // Advance to next agenda item — should reopen queue
      statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('meeting:nextAgendaItem', { currentAgendaItemId: state.current.agendaItemId ?? null }, () => {});
      state = await statePromise;
      expect(state.queue.closed).toBe(false);
    });

    it('queue is closed by default before meeting starts', async () => {
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);

      await joinMeeting(meeting.id);
      const state = ctx.meetingManager.get(meeting.id)!;
      expect(state.queue.closed).toBe(true);
    });
  });
});
