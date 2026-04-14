import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
    expect(state.chairIds).toHaveLength(1);
    expect(state.users[state.chairIds[0]].ghUsername).toBe('testuser');
    expect(state.agenda).toEqual([]);
    expect(state.queuedSpeakerIds).toEqual([]);
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
      expect(state.users[state.agenda[0].ownerId].ghUsername).toBe('testuser');
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

  describe('agenda:edit', () => {
    it('edits an agenda item and broadcasts updated state', async () => {
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);
      const item = ctx.meetingManager.addAgendaItem(meeting.id, 'Old name', owner)!;

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('agenda:edit', { id: item.id, name: 'New name' });
      const state = await statePromise;

      expect(state.agenda[0].name).toBe('New name');
    });

    it('rejects edit from non-chair', async () => {
      // Meeting where chair is someone else (ghid: 99)
      const meeting = ctx.meetingManager.create([{
        ghid: 99, ghUsername: 'chairperson', name: 'Chair', organisation: '',
      }]);
      const item = ctx.meetingManager.addAgendaItem(meeting.id, 'Item', {
        ghid: 99, ghUsername: 'chairperson', name: 'Chair', organisation: '',
      })!;

      const client = await joinMeeting(meeting.id);

      const errorPromise = waitForEvent<string>(client, 'error');
      client.emit('agenda:edit', { id: item.id, name: 'Hacked' });
      const error = await errorPromise;

      expect(error).toMatch(/only chairs/i);
      // Item should be unchanged
      expect(ctx.meetingManager.get(meeting.id)!.agenda[0].name).toBe('Item');
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

      expect(state.queuedSpeakerIds).toHaveLength(1);
      const entry = state.queueEntries[state.queuedSpeakerIds[0]];
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

      expect(state.queueEntries[state.queuedSpeakerIds[0]].type).toBe('point-of-order');
      expect(state.queueEntries[state.queuedSpeakerIds[1]].type).toBe('topic');
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

      expect(state.queuedSpeakerIds).toHaveLength(1);
      const entry = state.queueEntries[state.queuedSpeakerIds[0]];
      expect(state.users[entry.userId].ghUsername).toBe('alice');
      expect(entry.topic).toBe('Their topic');
    });

    it('resolves known users from the meeting when using asUsername', async () => {
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);
      // Add an agenda item owned by a known user with a full profile
      ctx.meetingManager.addAgendaItem(meeting.id, 'Item', {
        ghid: 42, ghUsername: 'knownuser', name: 'Known User', organisation: 'ACME',
      });

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('queue:add', { type: 'topic', topic: 'Test', asUsername: 'knownuser' });
      const state = await statePromise;

      // Should use the full profile, not a placeholder
      const entry = state.queueEntries[state.queuedSpeakerIds[0]];
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

      const entry = state.queueEntries[state.queuedSpeakerIds[0]];
      expect(state.users[entry.userId].ghUsername).toBe('unknownperson');
      expect(state.users[entry.userId].name).toBe('unknownperson');
    });

    it('rejects asUsername from non-chair', async () => {
      // Meeting where chair is someone else
      const meeting = ctx.meetingManager.create([{
        ghid: 99, ghUsername: 'chairperson', name: 'Chair', organisation: '',
      }]);

      const client = await joinMeeting(meeting.id);

      const errorPromise = waitForEvent<string>(client, 'error');
      client.emit('queue:add', { type: 'topic', topic: 'Hacked', asUsername: 'victim' });
      const error = await errorPromise;

      expect(error).toMatch(/only chairs/i);
      // No entry should have been added
      expect(ctx.meetingManager.get(meeting.id)!.queuedSpeakerIds).toHaveLength(0);
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
      const entryId = stateAfterAdd.queuedSpeakerIds[0];

      // Remove it
      statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('queue:remove', { id: entryId });
      const state = await statePromise;

      expect(state.queuedSpeakerIds).toHaveLength(0);
    });

    it('rejects removal of another user\'s entry by non-chair', async () => {
      // Meeting where chair is someone else
      const meeting = ctx.meetingManager.create([{
        ghid: 99, ghUsername: 'chairperson', name: 'Chair', organisation: '',
      }]);
      // Add an entry by a different user
      const entry = ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'Not yours', {
        ghid: 99, ghUsername: 'chairperson', name: 'Chair', organisation: '',
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

      expect(state.queuedSpeakerIds.map((id) => state.queueEntries[id].topic)).toEqual(['C', 'A', 'B']);
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

      expect(state.queuedSpeakerIds[0]).toBe(t.id);
      expect(state.queueEntries[state.queuedSpeakerIds[0]].type).toBe('question');
    });

    it('rejects non-owner non-chair from reordering', async () => {
      const meeting = ctx.meetingManager.create([{
        ghid: 99, ghUsername: 'chairperson', name: 'Chair', organisation: '',
      }]);
      // Entry owned by the chair, not the mock test user
      const entry = ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'A', {
        ghid: 99, ghUsername: 'chairperson', name: 'Chair', organisation: '',
      })!;

      const client = await joinMeeting(meeting.id);

      const errorPromise = waitForEvent<string>(client, 'error');
      client.emit('queue:reorder', { id: entry.id, afterId: null });
      const error = await errorPromise;

      expect(error).toMatch(/your own/i);
    });

    it('allows owner to move their entry down but not up', async () => {
      // Meeting where testuser is NOT a chair
      const meeting = ctx.meetingManager.create([{
        ghid: 99, ghUsername: 'chairperson', name: 'Chair', organisation: '',
      }]);
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const a = ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'A', owner)!;
      const b = ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'B', {
        ghid: 99, ghUsername: 'chairperson', name: 'Chair', organisation: '',
      })!;

      const client = await joinMeeting(meeting.id);

      // Moving own entry (A) after B (down) should succeed
      const statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('queue:reorder', { id: a.id, afterId: b.id });
      const state = await statePromise;
      expect(state.queuedSpeakerIds[0]).toBe(b.id);
      expect(state.queuedSpeakerIds[1]).toBe(a.id);
    });

    it('rejects owner moving their entry up', async () => {
      // Meeting where testuser is NOT a chair
      const meeting = ctx.meetingManager.create([{
        ghid: 99, ghUsername: 'chairperson', name: 'Chair', organisation: '',
      }]);
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'A', {
        ghid: 99, ghUsername: 'chairperson', name: 'Chair', organisation: '',
      });
      const b = ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'B', owner)!;

      const client = await joinMeeting(meeting.id);

      // Moving own entry (B) to the beginning (up) should be rejected
      const errorPromise = waitForEvent<string>(client, 'error');
      client.emit('queue:reorder', { id: b.id, afterId: null });
      const error = await errorPromise;

      expect(error).toMatch(/later position/i);
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

      expect(state.queueEntries[state.queuedSpeakerIds[0]].topic).toBe('New topic');
    });

    it('rejects edit from non-owner non-chair', async () => {
      // Meeting where chair is someone else (ghid: 99)
      const meeting = ctx.meetingManager.create([{
        ghid: 99, ghUsername: 'chairperson', name: 'Chair', organisation: '',
      }]);
      // Queue entry created by the chair, not the mock test user
      const entry = ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'Not yours', {
        ghid: 99, ghUsername: 'chairperson', name: 'Chair', organisation: '',
      })!;

      const client = await joinMeeting(meeting.id);

      const errorPromise = waitForEvent<string>(client, 'error');
      client.emit('queue:edit', { id: entry.id, topic: 'Hacked' });
      const error = await errorPromise;

      expect(error).toMatch(/your own/i);
      // Entry should be unchanged
      expect(ctx.meetingManager.get(meeting.id)!.queueEntries[ctx.meetingManager.get(meeting.id)!.queuedSpeakerIds[0]].topic).toBe('Not yours');
    });

    it('allows chair to edit any entry', async () => {
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);
      // Entry created by someone else
      const entry = ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'Other topic', {
        ghid: 99, ghUsername: 'other', name: 'Other', organisation: '',
      })!;

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('queue:edit', { id: entry.id, topic: 'Chair edited' });
      const state = await statePromise;

      expect(state.queueEntries[state.queuedSpeakerIds[0]].topic).toBe('Chair edited');
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
      client.emit('queue:next', { version: meeting.version }, () => {});
      const state = await statePromise;

      expect(state.queueEntries[state.currentSpeakerId!]?.topic).toBe('First');
      expect(state.queuedSpeakerIds).toHaveLength(1);
      expect(state.queueEntries[state.queuedSpeakerIds[0]].topic).toBe('Second');
    });

    it('sets currentTopic when advancing a topic-type entry', async () => {
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'New discussion', owner);

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('queue:next', { version: meeting.version }, () => {});
      const state = await statePromise;

      expect(state.queueEntries[state.currentTopicId!]?.topic).toBe('New discussion');
    });

    it('clears the speaker when queue is empty', async () => {
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);
      // Set a current speaker and topic but leave queue empty
      const ownerKey = 'testuser';
      meeting.queueEntries['old-speaker'] = {
        id: 'old-speaker', type: 'topic', topic: 'Done', userId: ownerKey,
      };
      meeting.currentSpeakerId = 'old-speaker';
      meeting.queueEntries['old-topic'] = {
        id: 'old-topic', type: 'topic', topic: 'Done', userId: ownerKey,
      };
      meeting.currentTopicId = 'old-topic';

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForEvent<MeetingState>(client, 'state');
      // Use the current meeting version (version was bumped by create + mutations)
      client.emit('queue:next', { version: meeting.version }, () => {});
      const state = await statePromise;

      expect(state.currentSpeakerId).toBeUndefined();
    });

    it('rejects stale version via ack with current version', async () => {
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'Only entry', owner);

      const client = await joinMeeting(meeting.id);

      // Send queue:next with a stale version (0 instead of current)
      const ackPromise = new Promise<any>((resolve) => {
        client.emit('queue:next', { version: 0 }, resolve);
      });
      const response = await ackPromise;

      expect(response.ok).toBe(false);
      expect(response.version).toBe(meeting.version);

      // Queue should not have advanced
      expect(ctx.meetingManager.get(meeting.id)!.queuedSpeakerIds).toHaveLength(1);
    });

    it('returns ok: true via ack on success', async () => {
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'Entry', owner);

      const client = await joinMeeting(meeting.id);

      const ackPromise = new Promise<any>((resolve) => {
        client.emit('queue:next', { version: meeting.version }, resolve);
      });
      const response = await ackPromise;

      expect(response.ok).toBe(true);
    });

    it('rejects from non-chair via ack', async () => {
      const meeting = ctx.meetingManager.create([{
        ghid: 99, ghUsername: 'chairperson', name: 'Chair', organisation: '',
      }]);

      const client = await joinMeeting(meeting.id);

      const ackPromise = new Promise<any>((resolve) => {
        client.emit('queue:next', { version: 0 }, resolve);
      });
      const response = await ackPromise;

      expect(response.ok).toBe(false);
      expect(response.error).toMatch(/only chairs/i);
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
      const chairUsernames = state.chairIds.map(id => state.users[id].ghUsername);
      expect(chairUsernames).toContain('testuser');
      expect(chairUsernames).toContain('newchair');
    });

    it('rejects from non-chair', async () => {
      const meeting = ctx.meetingManager.create([{
        ghid: 99, ghUsername: 'chairperson', name: 'Chair', organisation: '',
      }]);

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
      ctx.meetingManager.addAgendaItem(meeting.id, 'Item', {
        ghid: 42, ghUsername: 'knownuser', name: 'Known User', organisation: 'ACME',
      });

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('meeting:updateChairs', { usernames: ['testuser', 'knownuser'] });
      const state = await statePromise;

      const knownKey = state.chairIds.find(id => state.users[id].ghUsername === 'knownuser')!;
      expect(state.users[knownKey]?.name).toBe('Known User');
      expect(state.users[knownKey]?.organisation).toBe('ACME');
    });
  });

  describe('meeting:updateChairs (admin)', () => {
    it('allows an admin to edit chairs for a meeting they do not chair', async () => {
      // Set testuser as admin
      vi.stubEnv('ADMIN_USERNAMES', 'testuser');

      // Meeting where testuser is NOT a chair
      const meeting = ctx.meetingManager.create([{
        ghid: 99, ghUsername: 'chairperson', name: 'Chair', organisation: '',
      }]);

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

      const meeting = ctx.meetingManager.create([{
        ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: '',
      }]);

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

      const meeting = ctx.meetingManager.create([{
        ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: '',
      }]);

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

      expect(state.trackPoll).toBe(true);
      expect(state.pollOptions).toHaveLength(2);
      expect(state.pollOptions[0].emoji).toBe('❤️');
      expect(state.pollOptions[0].label).toBe('Love');
      expect(state.reactions).toHaveLength(0);
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
      const meeting = ctx.meetingManager.create([{
        ghid: 99, ghUsername: 'chairperson', name: 'Chair', organisation: '',
      }]);

      const client = await joinMeeting(meeting.id);

      const errorPromise = waitForEvent<string>(client, 'error');
      client.emit('poll:start', { options: samplePollOptions });
      const error = await errorPromise;

      expect(error).toMatch(/only chairs/i);
    });
  });

  describe('poll:stop', () => {
    it('stops a poll and clears reactions and options', async () => {
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.startPoll(meeting.id, samplePollOptions);

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('poll:stop');
      const state = await statePromise;

      expect(state.trackPoll).toBe(false);
      expect(state.pollOptions).toHaveLength(0);
      expect(state.reactions).toHaveLength(0);
    });
  });

  describe('poll:react', () => {
    it('adds a reaction and broadcasts', async () => {
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.startPoll(meeting.id, samplePollOptions);
      const optionId = meeting.pollOptions[0].id;

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('poll:react', { optionId });
      const state = await statePromise;

      expect(state.reactions).toHaveLength(1);
      expect(state.reactions[0].optionId).toBe(optionId);
      expect(state.users[state.reactions[0].userId].ghUsername).toBe('testuser');
    });

    it('toggles off an existing reaction', async () => {
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.startPoll(meeting.id, samplePollOptions);
      const optionId = meeting.pollOptions[0].id;

      const client = await joinMeeting(meeting.id);

      // Add
      let statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('poll:react', { optionId });
      await statePromise;

      // Toggle off
      statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('poll:react', { optionId });
      const state = await statePromise;

      expect(state.reactions).toHaveLength(0);
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
      ctx.meetingManager.addAgendaItem(meeting.id, 'First topic', owner);

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('meeting:nextAgendaItem', { version: meeting.version }, () => {});
      const state = await statePromise;

      expect(state.agenda.find((i) => i.id === state.currentAgendaItemId)?.name).toBe('First topic');
      const currentEntry = state.queueEntries[state.currentSpeakerId!];
      expect(state.users[currentEntry.userId].ghUsername).toBe('testuser');
      expect(currentEntry.topic).toBe('Introducing: First topic');
    });

    it('advances to the next agenda item', async () => {
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'First', owner);
      ctx.meetingManager.addAgendaItem(meeting.id, 'Second', owner);

      const client = await joinMeeting(meeting.id);

      // Start meeting
      let statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('meeting:nextAgendaItem', { version: meeting.version }, () => {});
      const state1 = await statePromise;

      // Advance to second — use the version from the state we just received
      statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('meeting:nextAgendaItem', { version: state1.version }, () => {});
      const state2 = await statePromise;

      expect(state2.agenda.find((i) => i.id === state2.currentAgendaItemId)?.name).toBe('Second');
    });

    it('rejects from non-chair via ack', async () => {
      const meeting = ctx.meetingManager.create([{
        ghid: 99, ghUsername: 'chairperson', name: 'Chair', organisation: '',
      }]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'Item', {
        ghid: 99, ghUsername: 'chairperson', name: 'Chair', organisation: '',
      });

      const client = await joinMeeting(meeting.id);

      const ackPromise = new Promise<any>((resolve) => {
        client.emit('meeting:nextAgendaItem', { version: meeting.version }, resolve);
      });
      const response = await ackPromise;

      expect(response.ok).toBe(false);
      expect(response.error).toMatch(/only chairs/i);
    });

    it('returns error via ack when no more agenda items', async () => {
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'Only item', owner);

      const client = await joinMeeting(meeting.id);

      // Start (first item)
      let ackPromise = new Promise<any>((resolve) => {
        client.emit('meeting:nextAgendaItem', { version: meeting.version }, resolve);
      });
      const startResponse = await ackPromise;
      expect(startResponse.ok).toBe(true);

      // Wait for the state broadcast so we have the new version
      await new Promise((r) => setTimeout(r, 50));
      const currentMeeting = ctx.meetingManager.get(meeting.id)!;

      // Try to advance past end
      ackPromise = new Promise<any>((resolve) => {
        client.emit('meeting:nextAgendaItem', { version: currentMeeting.version }, resolve);
      });
      const response = await ackPromise;

      expect(response.ok).toBe(false);
      expect(response.error).toMatch(/no more agenda items/i);
    });

    it('rejects stale version (prevents double-advancement)', async () => {
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'First', owner);
      ctx.meetingManager.addAgendaItem(meeting.id, 'Second', owner);

      const client = await joinMeeting(meeting.id);
      const staleVersion = meeting.version;

      // Start meeting (advances version)
      let statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('meeting:nextAgendaItem', { version: staleVersion }, () => {});
      await statePromise;

      // Try to advance again with the stale version — should be rejected
      statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('meeting:nextAgendaItem', { version: staleVersion }, () => {});
      const state = await statePromise;

      // Should still be on the first item (rejected, but got current state back)
      expect(state.agenda.find((i) => i.id === state.currentAgendaItemId)?.name).toBe('First');
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

  // -- Meeting log tests --

  describe('meeting log', () => {
    const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };

    it('logs meeting-started and agenda-item-started on first agenda advancement', async () => {
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'First Item', owner);

      const client = await joinMeeting(meeting.id);
      const statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('meeting:nextAgendaItem', { version: meeting.version }, () => {});
      const state = await statePromise;

      expect(state.log).toHaveLength(2);
      expect(state.log[0].type).toBe('meeting-started');
      expect(state.log[1].type).toBe('agenda-item-started');
      expect(state.log[1].type === 'agenda-item-started' && state.log[1].itemName).toBe('First Item');
    });

    it('logs agenda-item-finished when advancing to the next item', async () => {
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'First Item', owner);
      ctx.meetingManager.addAgendaItem(meeting.id, 'Second Item', owner);

      const client = await joinMeeting(meeting.id);

      // Start meeting (advance to first item)
      let statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('meeting:nextAgendaItem', { version: meeting.version }, () => {});
      let state = await statePromise;

      // Advance to second item
      statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('meeting:nextAgendaItem', { version: state.version }, () => {});
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
      ctx.meetingManager.addAgendaItem(meeting.id, 'Item', owner);

      const client = await joinMeeting(meeting.id);

      // Start meeting
      let statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('meeting:nextAgendaItem', { version: meeting.version }, () => {});
      let state = await statePromise;

      // Add a new topic to the queue and advance
      statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('queue:add', { type: 'topic', topic: 'My topic' });
      state = await statePromise;

      statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('queue:next', { version: state.version }, () => {});
      state = await statePromise;

      // The introductory topic group should be finalised in the log
      const topicEntries = state.log.filter((e) => e.type === 'topic-discussed');
      expect(topicEntries).toHaveLength(1);
      expect(topicEntries[0].type === 'topic-discussed' && topicEntries[0].speakers).toHaveLength(1);

      // The new topic should be in currentTopicSpeakers (not yet finalised)
      expect(state.currentTopicSpeakers).toHaveLength(1);
      expect(state.currentTopicSpeakers[0].topic).toBe('My topic');
    });

    it('nests replies under the current topic group', async () => {
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'Item', owner);

      const client = await joinMeeting(meeting.id);

      // Start meeting
      let statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('meeting:nextAgendaItem', { version: meeting.version }, () => {});
      let state = await statePromise;

      // Add a reply and advance to it
      statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('queue:add', { type: 'reply', topic: 'My reply' });
      state = await statePromise;

      statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('queue:next', { version: state.version }, () => {});
      state = await statePromise;

      // Reply should be in the same topic group as the intro (not finalised yet)
      expect(state.currentTopicSpeakers).toHaveLength(2);
      expect(state.currentTopicSpeakers[1].type).toBe('reply');
      expect(state.currentTopicSpeakers[1].topic).toBe('My reply');
    });

    it('excludes point-of-order speakers from topic groups', async () => {
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.addAgendaItem(meeting.id, 'Item', owner);

      const client = await joinMeeting(meeting.id);

      // Start meeting
      let statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('meeting:nextAgendaItem', { version: meeting.version }, () => {});
      let state = await statePromise;

      // Add a point-of-order and advance to it
      statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('queue:add', { type: 'point-of-order', topic: 'POO' });
      state = await statePromise;

      statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('queue:next', { version: state.version }, () => {});
      state = await statePromise;

      // Point-of-order should NOT be in the current topic speakers
      expect(state.currentTopicSpeakers).toHaveLength(1);
      expect(state.currentTopicSpeakers[0].topic).toContain('Introducing');
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
      client.emit('poll:react', { optionId: state.pollOptions[0].id });
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
      ctx.meetingManager.addAgendaItem(meeting.id, 'First', owner);
      ctx.meetingManager.addAgendaItem(meeting.id, 'Second', owner);

      const client = await joinMeeting(meeting.id);

      // Start meeting
      let statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('meeting:nextAgendaItem', { version: meeting.version }, () => {});
      let state = await statePromise;

      // Add entries to the queue
      statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('queue:add', { type: 'topic', topic: 'Leftover topic' });
      state = await statePromise;

      // Advance to next agenda item (leaving the queue non-empty)
      statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('meeting:nextAgendaItem', { version: state.version }, () => {});
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
      ctx.meetingManager.addAgendaItem(meeting.id, 'First', owner);
      ctx.meetingManager.addAgendaItem(meeting.id, 'Second', owner);

      const client = await joinMeeting(meeting.id);

      // Start meeting
      let statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('meeting:nextAgendaItem', { version: meeting.version }, () => {});
      let state = await statePromise;

      // Advance to next item with empty queue
      statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('meeting:nextAgendaItem', { version: state.version }, () => {});
      state = await statePromise;

      const finished = state.log.find((e) => e.type === 'agenda-item-finished');
      expect(finished).toBeDefined();
      if (finished?.type === 'agenda-item-finished') {
        expect(finished.remainingQueue).toBeUndefined();
      }
    });
  });
});
