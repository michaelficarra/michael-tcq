import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import session from 'express-session';
import { createServer, type Server as HttpServer } from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import type { MeetingState, ClientToServerEvents, ServerToClientEvents } from '@tcq/shared';
import type { MeetingStore } from './store.js';
import { MeetingManager } from './meetings.js';
import { mockAuth } from './mockAuth.js';
import { registerSocketHandlers } from './socket.js';

// --- Helpers ---

/** A no-op in-memory store for tests. */
class InMemoryStore implements MeetingStore {
  private data = new Map<string, MeetingState>();
  async save(meeting: MeetingState) { this.data.set(meeting.id, structuredClone(meeting)); }
  async load(meetingId: string) { return this.data.get(meetingId) ?? null; }
  async loadAll() { return [...this.data.values()]; }
  async remove(meetingId: string) { this.data.delete(meetingId); }
}

/** Typed client socket matching our event interfaces (reversed: client receives ServerToClient). */
type TypedClientSocket = ClientSocket<ServerToClientEvents, ClientToServerEvents>;

interface TestContext {
  httpServer: HttpServer;
  io: SocketIOServer<ClientToServerEvents, ServerToClientEvents>;
  meetingManager: MeetingManager;
  baseUrl: string;
}

/** Spin up a test server with Express session + Socket.IO + mock auth. */
function createTestServer(): TestContext {
  const app = express();
  const httpServer = createServer(app);

  const sessionMiddleware = session({
    secret: 'test-secret',
    resave: false,
    saveUninitialized: false,
  });

  app.use(sessionMiddleware);
  app.use(mockAuth);

  const meetingManager = new MeetingManager(new InMemoryStore());

  const io = new SocketIOServer<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    cors: { origin: '*', credentials: true },
  });

  // Share session with Socket.IO (same as production setup)
  io.engine.use(sessionMiddleware);
  io.engine.use(mockAuth);

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
    const meeting = ctx.meetingManager.create([{
      ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org',
    }]);

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
    expect(state.chairs).toHaveLength(1);
    expect(state.chairs[0].ghUsername).toBe('testuser');
    expect(state.agenda).toEqual([]);
    expect(state.queuedSpeakers).toEqual([]);
  });

  it('two clients in the same meeting both receive state', async () => {
    const meeting = ctx.meetingManager.create([{
      ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org',
    }]);

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

  describe('agenda:add', () => {
    it('adds an agenda item and broadcasts updated state', async () => {
      // Mock user (ghid: 1, ghUsername: testuser) is a chair
      const meeting = ctx.meetingManager.create([{
        ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org',
      }]);

      const client = await joinMeeting(meeting.id);

      // Listen for the state update after adding
      const statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('agenda:add', { name: 'First item', ownerUsername: 'testuser', timebox: 15 });
      const state = await statePromise;

      expect(state.agenda).toHaveLength(1);
      expect(state.agenda[0].name).toBe('First item');
      expect(state.agenda[0].owner.ghUsername).toBe('testuser');
      expect(state.agenda[0].timebox).toBe(15);
    });

    it('broadcasts to all clients in the meeting', async () => {
      const meeting = ctx.meetingManager.create([{
        ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org',
      }]);

      const client1 = await joinMeeting(meeting.id);
      const client2 = await joinMeeting(meeting.id);

      // Client 2 waits for the broadcast
      const state2Promise = waitForEvent<MeetingState>(client2, 'state');
      client1.emit('agenda:add', { name: 'Broadcast test', ownerUsername: 'testuser' });
      const state2 = await state2Promise;

      expect(state2.agenda).toHaveLength(1);
      expect(state2.agenda[0].name).toBe('Broadcast test');
    });

    it('rejects add from non-chair', async () => {
      // Create meeting where chair is someone else (ghid: 99)
      const meeting = ctx.meetingManager.create([{
        ghid: 99, ghUsername: 'chairperson', name: 'Chair', organisation: '',
      }]);

      const client = await joinMeeting(meeting.id);

      // Listen for error
      const errorPromise = waitForEvent<string>(client, 'error');
      client.emit('agenda:add', { name: 'Should fail', ownerUsername: 'testuser' });
      const error = await errorPromise;

      expect(error).toMatch(/only chairs/i);
      // Agenda should still be empty
      expect(ctx.meetingManager.get(meeting.id)!.agenda).toHaveLength(0);
    });
  });

  describe('agenda:delete', () => {
    it('deletes an agenda item and broadcasts updated state', async () => {
      const meeting = ctx.meetingManager.create([{
        ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org',
      }]);
      const item = ctx.meetingManager.addAgendaItem(meeting.id, 'To delete', {
        ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org',
      })!;

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('agenda:delete', { id: item.id });
      const state = await statePromise;

      expect(state.agenda).toHaveLength(0);
    });
  });

  describe('agenda:reorder', () => {
    it('reorders agenda items and broadcasts updated state', async () => {
      const meeting = ctx.meetingManager.create([{
        ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org',
      }]);
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      ctx.meetingManager.addAgendaItem(meeting.id, 'A', owner);
      ctx.meetingManager.addAgendaItem(meeting.id, 'B', owner);
      const itemC = ctx.meetingManager.addAgendaItem(meeting.id, 'C', owner)!;

      const client = await joinMeeting(meeting.id);

      // Move C to the beginning (afterId: null)
      const statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('agenda:reorder', { id: itemC.id, afterId: null });
      const state = await statePromise;

      expect(state.agenda.map((i) => i.name)).toEqual(['C', 'A', 'B']);
    });
  });

  it('client can switch meetings by joining a different one', async () => {
    const meeting1 = ctx.meetingManager.create([{
      ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org',
    }]);
    const meeting2 = ctx.meetingManager.create([{
      ghid: 2, ghUsername: 'other', name: 'Other User', organisation: 'Other Org',
    }]);

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
});
