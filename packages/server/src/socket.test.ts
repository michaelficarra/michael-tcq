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

      expect(state.queuedSpeakers).toHaveLength(1);
      expect(state.queuedSpeakers[0].type).toBe('topic');
      expect(state.queuedSpeakers[0].topic).toBe('My topic');
      expect(state.queuedSpeakers[0].user.ghUsername).toBe('testuser');
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

      expect(state.queuedSpeakers[0].type).toBe('point-of-order');
      expect(state.queuedSpeakers[1].type).toBe('topic');
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
      const entryId = stateAfterAdd.queuedSpeakers[0].id;

      // Remove it
      statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('queue:remove', { id: entryId });
      const state = await statePromise;

      expect(state.queuedSpeakers).toHaveLength(0);
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

      expect(state.queuedSpeakers.map((e) => e.topic)).toEqual(['C', 'A', 'B']);
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

      expect(state.queuedSpeakers[0].id).toBe(t.id);
      expect(state.queuedSpeakers[0].type).toBe('question');
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
      expect(state.queuedSpeakers[0].id).toBe(b.id);
      expect(state.queuedSpeakers[1].id).toBe(a.id);
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

      expect(state.queuedSpeakers[0].topic).toBe('New topic');
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
      expect(ctx.meetingManager.get(meeting.id)!.queuedSpeakers[0].topic).toBe('Not yours');
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

      expect(state.queuedSpeakers[0].topic).toBe('Chair edited');
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

      expect(state.currentSpeaker?.topic).toBe('First');
      expect(state.queuedSpeakers).toHaveLength(1);
      expect(state.queuedSpeakers[0].topic).toBe('Second');
    });

    it('sets currentTopic when advancing a topic-type entry', async () => {
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.addQueueEntry(meeting.id, 'topic', 'New discussion', owner);

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('queue:next', { version: meeting.version }, () => {});
      const state = await statePromise;

      expect(state.currentTopic?.topic).toBe('New discussion');
    });

    it('clears the speaker when queue is empty', async () => {
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);
      // Set a current speaker and topic but leave queue empty
      meeting.currentSpeaker = {
        id: 'old-speaker', type: 'topic', topic: 'Done', user: owner,
      };
      meeting.currentTopic = {
        id: 'old-topic', type: 'topic', topic: 'Done', user: owner,
      };

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForEvent<MeetingState>(client, 'state');
      // Use the current meeting version (version was bumped by create + mutations)
      client.emit('queue:next', { version: meeting.version }, () => {});
      const state = await statePromise;

      expect(state.currentSpeaker).toBeUndefined();
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
      expect(ctx.meetingManager.get(meeting.id)!.queuedSpeakers).toHaveLength(1);
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

  // -- Temperature check events --

  /** Helper: sample temperature check options for tests. */
  const tempOptions = [
    { emoji: '❤️', label: 'Love' },
    { emoji: '👍', label: 'Like' },
  ];

  describe('temperature:start', () => {
    it('starts a temperature check with custom options and broadcasts', async () => {
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('temperature:start', { options: tempOptions });
      const state = await statePromise;

      expect(state.trackTemperature).toBe(true);
      expect(state.temperatureOptions).toHaveLength(2);
      expect(state.temperatureOptions[0].emoji).toBe('❤️');
      expect(state.temperatureOptions[0].label).toBe('Love');
      expect(state.reactions).toHaveLength(0);
    });

    it('rejects with fewer than 2 options', async () => {
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);

      const client = await joinMeeting(meeting.id);

      const errorPromise = waitForEvent<string>(client, 'error');
      client.emit('temperature:start', { options: [{ emoji: '👍', label: 'Only one' }] });
      const error = await errorPromise;

      expect(error).toMatch(/at least 2/i);
    });

    it('rejects from non-chair', async () => {
      const meeting = ctx.meetingManager.create([{
        ghid: 99, ghUsername: 'chairperson', name: 'Chair', organisation: '',
      }]);

      const client = await joinMeeting(meeting.id);

      const errorPromise = waitForEvent<string>(client, 'error');
      client.emit('temperature:start', { options: tempOptions });
      const error = await errorPromise;

      expect(error).toMatch(/only chairs/i);
    });
  });

  describe('temperature:stop', () => {
    it('stops a temperature check and clears reactions and options', async () => {
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.startTemperature(meeting.id, tempOptions);

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('temperature:stop');
      const state = await statePromise;

      expect(state.trackTemperature).toBe(false);
      expect(state.temperatureOptions).toHaveLength(0);
      expect(state.reactions).toHaveLength(0);
    });
  });

  describe('temperature:react', () => {
    it('adds a reaction and broadcasts', async () => {
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.startTemperature(meeting.id, tempOptions);
      const optionId = meeting.temperatureOptions[0].id;

      const client = await joinMeeting(meeting.id);

      const statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('temperature:react', { optionId });
      const state = await statePromise;

      expect(state.reactions).toHaveLength(1);
      expect(state.reactions[0].optionId).toBe(optionId);
      expect(state.reactions[0].user.ghUsername).toBe('testuser');
    });

    it('toggles off an existing reaction', async () => {
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);
      ctx.meetingManager.startTemperature(meeting.id, tempOptions);
      const optionId = meeting.temperatureOptions[0].id;

      const client = await joinMeeting(meeting.id);

      // Add
      let statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('temperature:react', { optionId });
      await statePromise;

      // Toggle off
      statePromise = waitForEvent<MeetingState>(client, 'state');
      client.emit('temperature:react', { optionId });
      const state = await statePromise;

      expect(state.reactions).toHaveLength(0);
    });

    it('rejects when temperature check is not active', async () => {
      const owner = { ghid: 1, ghUsername: 'testuser', name: 'Test User', organisation: 'Test Org' };
      const meeting = ctx.meetingManager.create([owner]);

      const client = await joinMeeting(meeting.id);

      const errorPromise = waitForEvent<string>(client, 'error');
      client.emit('temperature:react', { optionId: 'any' });
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

      expect(state.currentAgendaItem?.name).toBe('First topic');
      expect(state.currentSpeaker?.user.ghUsername).toBe('testuser');
      expect(state.currentSpeaker?.topic).toBe('Introducing: First topic');
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

      expect(state2.currentAgendaItem?.name).toBe('Second');
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
      expect(state.currentAgendaItem?.name).toBe('First');
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
