// REST + Socket.IO helpers shared by every per-screenshot script.
//
// All helpers here are pure Node — no Playwright. They mirror the same
// protocol used by `scripts/seed-meeting.mjs`: create a meeting via the
// HTTP API, acquire session cookies through the dev user-switcher, and
// drive state mutations over WebSockets while keeping a local
// `MeetingState` in sync via `@tcq/shared`'s `applyDelta`.
//
// Keep the `DELTA_EVENTS` list and the emit shapes in sync with
// `packages/shared/src/messages.ts` — see CLAUDE.md's "Important Files"
// section for the rationale.

import { io } from 'socket.io-client';
import msgpackParser from 'socket.io-msgpack-parser';
import { applyDelta } from '@tcq/shared';

// Every typed delta this module's chair socket subscribes to. The chair
// socket auto-applies each arriving delta to its local `MeetingState`,
// regardless of whether the change originated from the chair's own
// emit or a throwaway socket somewhere else — this matches what the
// browser does and keeps the screenshot scripts simple.
const DELTA_EVENTS = [
  'chairs:updated',
  'agenda:added',
  'agenda:edited',
  'agenda:deleted',
  'agenda:reordered',
  'agenda:advanced',
  'agenda:prologueSet',
  'agenda:epilogueSet',
  'queue:added',
  'queue:edited',
  'queue:removed',
  'queue:reordered',
  'queue:closedChanged',
  'speaker:advanced',
  'poll:started',
  'poll:stopped',
  'poll:reacted',
];

/**
 * POST /api/dev/switch-user with the given username and return a single
 * `cookie:` request-header string built from the response's Set-Cookie
 * header(s). The session those cookies identify is the one the next
 * Socket.IO connection will pick up via the server's session middleware.
 */
export async function switchUserCookie(serverUrl, username) {
  const res = await fetch(`${serverUrl}/api/dev/switch-user`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username }),
  });
  if (!res.ok) {
    throw new Error(`switchUserCookie(${username}): ${res.status} ${await res.text()}`);
  }
  const cookies = res.headers.getSetCookie?.() ?? [];
  return cookies.map((c) => c.split(';')[0]).join('; ');
}

/**
 * Create a meeting with the given chairs and return its id. `chairs` is an
 * array of bare GitHub handles; each is wrapped in a provider-neutral
 * `{ handle }` UserSelection (resolved server-side) for the wire.
 */
export async function createMeeting(serverUrl, { chairs }) {
  const res = await fetch(`${serverUrl}/api/meetings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chairs: chairs.map((handle) => ({ handle })) }),
  });
  if (!res.ok) {
    throw new Error(`createMeeting: ${res.status} ${await res.text()}`);
  }
  return (await res.json()).id;
}

/**
 * Bail out early when the dev server isn't reachable. Mirrors the
 * health-check at the top of `scripts/seed-meeting.mjs` so individual
 * screenshot scripts can call this once on startup and produce a
 * useful error before the first real REST call fails.
 */
export async function assertServerRunning(serverUrl) {
  try {
    const res = await fetch(`${serverUrl}/api/health`);
    if (!res.ok) throw new Error(`status ${res.status}`);
  } catch (err) {
    throw new Error(`Server is not running at ${serverUrl}: ${err.message}. Start it with: npm run dev`);
  }
}

/**
 * Open a Socket.IO connection as the given user, await the initial
 * `state` snapshot, and subscribe to every delta in `DELTA_EVENTS`.
 *
 * The returned object exposes:
 *  - `socket`           — the raw Socket.IO client
 *  - `getState()`       — the latest local MeetingState
 *  - `waitFor(event)`   — resolves to the next delta of that name
 *  - `emit(event, payload)` — emit without waiting
 *  - `emitAndWait(event, payload, deltaEvent)` — emit and resolve to the
 *    updated state after the matching delta lands
 *  - `emitWithAckAndWait(event, payload, deltaEvent)` — same but for
 *    events that take an ack callback (`meeting:nextAgendaItem`, `queue:next`)
 *  - `close()`          — disconnect
 *
 * Every arriving delta is applied to the local state automatically,
 * regardless of whether the calling code is currently `await`ing one,
 * so passive observers (e.g. waiting on a throwaway socket's broadcast)
 * stay in sync.
 */
export async function openMeetingSocket(serverUrl, meetingId, username) {
  const cookie = await switchUserCookie(serverUrl, username);
  const socket = io(serverUrl, {
    transports: ['websocket'],
    extraHeaders: { cookie },
    parser: msgpackParser,
  });

  // Per-event pending-deltas queues and waiters. A waiter that arrives
  // before its delta is parked here until the matching delta lands.
  const pending = new Map(); // event -> array of deltas not yet consumed
  const waiters = new Map(); // event -> array of { resolve }
  function deliver(event, payload) {
    const queued = waiters.get(event);
    if (queued && queued.length) {
      queued.shift().resolve(payload);
      return;
    }
    if (!pending.has(event)) pending.set(event, []);
    pending.get(event).push(payload);
  }
  function waitFor(event) {
    const queue = pending.get(event);
    if (queue && queue.length) return Promise.resolve(queue.shift());
    return new Promise((resolve) => {
      if (!waiters.has(event)) waiters.set(event, []);
      waiters.get(event).push({ resolve });
    });
  }

  let state = null;
  socket.on('state', (snapshot) => {
    state = snapshot;
    deliver('state', snapshot);
  });
  for (const event of DELTA_EVENTS) {
    socket.on(event, (delta) => {
      if (state) state = applyDelta(state, { type: event, delta });
      deliver(event, delta);
    });
  }

  socket.on('error', (msg) => {
    // Surface server-side validation errors loudly — the alternative
    // is a hung waiter.
    console.error(`[${username}] server error: ${msg}`);
  });

  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  socket.emit('join', meetingId);
  await waitFor('state');

  function emit(event, payload) {
    socket.emit(event, payload);
  }

  async function emitAndWait(event, payload, deltaEvent) {
    socket.emit(event, payload);
    await waitFor(deltaEvent);
    return state;
  }

  async function emitWithAckAndWait(event, payload, deltaEvent) {
    const ackPromise = new Promise((resolve) => {
      socket.emit(event, payload, (response) => resolve(response));
    });
    // Both the ack and the broadcast delta arrive on success; only the
    // ack arrives on a rejection. Race the ack against the delta and
    // surface the ack's reason if it failed.
    const [ack] = await Promise.all([ackPromise, waitFor(deltaEvent)]);
    if (!ack?.ok) {
      throw new Error(`${event} rejected: ${ack?.reason ?? 'unknown'}`);
    }
    return state;
  }

  async function close() {
    socket.disconnect();
  }

  return {
    socket,
    getState: () => state,
    waitFor,
    emit,
    emitAndWait,
    emitWithAckAndWait,
    close,
  };
}

/**
 * Add a queue entry attributed to `username` via a throwaway Socket.IO
 * connection. Mirrors `seed-meeting.mjs`'s `addQueueEntryAsUser`.
 *
 * The chair socket's auto-apply machinery picks up the resulting
 * broadcast and updates its local state; we additionally `waitFor` it
 * here so the call resolves only after the chair has observed the new
 * entry, keeping subsequent reads of `chairSocket.getState()`
 * deterministic.
 */
export async function addQueueEntryAs(serverUrl, meetingId, chairSocket, username, payload) {
  const cookie = await switchUserCookie(serverUrl, username);
  const tmpSocket = io(serverUrl, {
    transports: ['websocket'],
    extraHeaders: { cookie },
    parser: msgpackParser,
  });
  await new Promise((resolve, reject) => {
    tmpSocket.once('connect', resolve);
    tmpSocket.once('connect_error', reject);
  });
  tmpSocket.emit('join', meetingId);
  await new Promise((resolve) => tmpSocket.once('state', resolve));

  // Race the broadcast against a server-side rejection on the throwaway
  // socket. Without this any validation failure (e.g. closed queue, or
  // a reply without the required currentTopicSpeakerId precondition)
  // would hang the chair's `waitFor('queue:added')` forever.
  const broadcast = chairSocket.waitFor('queue:added');
  const rejection = new Promise((_, reject) => {
    tmpSocket.once('error', (msg) => reject(new Error(`queue:add rejected for ${username}: ${msg}`)));
  });
  tmpSocket.emit('queue:add', payload);
  try {
    await Promise.race([broadcast, rejection]);
  } finally {
    setTimeout(() => tmpSocket.disconnect(), 100);
  }
}

/**
 * React to the active poll as `username`. Same throwaway-socket pattern
 * as `addQueueEntryAs`, but emits `poll:react` and waits for the
 * `poll:reacted` broadcast on the chair socket.
 */
export async function reactToPollAs(serverUrl, meetingId, chairSocket, username, optionId) {
  const cookie = await switchUserCookie(serverUrl, username);
  const tmpSocket = io(serverUrl, {
    transports: ['websocket'],
    extraHeaders: { cookie },
    parser: msgpackParser,
  });
  await new Promise((resolve, reject) => {
    tmpSocket.once('connect', resolve);
    tmpSocket.once('connect_error', reject);
  });
  tmpSocket.emit('join', meetingId);
  await new Promise((resolve) => tmpSocket.once('state', resolve));

  const broadcast = chairSocket.waitFor('poll:reacted');
  const rejection = new Promise((_, reject) => {
    tmpSocket.once('error', (msg) => reject(new Error(`poll:react rejected for ${username}: ${msg}`)));
  });
  tmpSocket.emit('poll:react', { optionId });
  try {
    await Promise.race([broadcast, rejection]);
  } finally {
    setTimeout(() => tmpSocket.disconnect(), 100);
  }
}

/**
 * High-level meeting builder. Composes the helpers above to produce a
 * meeting matching the given spec, then returns `{ meetingId, chairSocket }`
 * so the caller can drive any additional ad-hoc actions before screenshotting.
 *
 * The caller is responsible for `await chairSocket.close()` when done.
 *
 * Spec shape:
 *   {
 *     chairs: string[],
 *     primaryChair?: string,          // defaults to chairs[0]
 *     prologue?: string,
 *     epilogue?: string,
 *     agenda?: Array<{ name, presenters: string[], duration?: number }>,
 *     sessions?: Array<{ name, capacity, afterIndex?: number|null }>,
 *     // afterIndex = -1 puts the session at the very top; default
 *     // (omitted) places it after the last item.
 *     start?: boolean,                // advance into the first agenda item
 *     queue?: Array<{ as: string, topic?: string, type?: string }>,
 *     advancePastSpeakers?: number,   // pop N speakers off the queue head
 *     advancePastAgendaItems?: number,// advance past N agenda items (recording a conclusion each)
 *     runPoll?: {
 *       topic?: string, multiSelect?: boolean,
 *       options: Array<{ emoji, label }>,
 *       reactions?: Array<{ as: string, optionIndex: number }>,
 *       stop?: boolean,
 *     },
 *   }
 */
export async function populate(serverUrl, spec) {
  await assertServerRunning(serverUrl);

  const primaryChair = spec.primaryChair ?? spec.chairs[0];
  const meetingId = await createMeeting(serverUrl, { chairs: spec.chairs });
  const chairSocket = await openMeetingSocket(serverUrl, meetingId, primaryChair);

  if (spec.prologue) {
    await chairSocket.emitAndWait('agenda:setPrologue', { prologue: spec.prologue }, 'agenda:prologueSet');
  }
  if (spec.epilogue) {
    await chairSocket.emitAndWait('agenda:setEpilogue', { epilogue: spec.epilogue }, 'agenda:epilogueSet');
  }

  const itemIdsInOrder = [];
  if (spec.agenda) {
    for (const item of spec.agenda) {
      const payload = {
        name: item.name,
        // `item.presenters` is an array of bare GitHub handles; wrap each in
        // a provider-neutral `{ handle }` UserSelection for the wire.
        presenters: (item.presenters ?? []).map((handle) => ({ handle })),
      };
      if (item.duration != null) payload.duration = item.duration;
      const after = await chairSocket.emitAndWait('agenda:add', payload, 'agenda:added');
      itemIdsInOrder.push(after.agenda.at(-1).id);
    }
  }

  if (spec.sessions) {
    for (const session of spec.sessions) {
      let after = await chairSocket.emitAndWait(
        'session:add',
        { name: session.name, capacity: session.capacity },
        'agenda:added',
      );
      const newSessionId = after.agenda.at(-1).id;
      const afterIndex = session.afterIndex ?? itemIdsInOrder.length - 1;
      const afterId = afterIndex < 0 ? null : itemIdsInOrder[afterIndex];
      after = await chairSocket.emitAndWait('agenda:reorder', { id: newSessionId, afterId }, 'agenda:reordered');
    }
  }

  if (spec.start) {
    const state = chairSocket.getState();
    await chairSocket.emitWithAckAndWait(
      'meeting:nextAgendaItem',
      { currentAgendaItemId: state.current?.agendaItemId ?? null, conclusion: '' },
      'agenda:advanced',
    );
  }

  if (spec.queue) {
    for (const entry of spec.queue) {
      const payload = { type: entry.type ?? 'topic' };
      if (entry.topic) payload.topic = entry.topic;
      await addQueueEntryAs(serverUrl, meetingId, chairSocket, entry.as, payload);
    }
  }

  if (spec.advancePastSpeakers) {
    for (let i = 0; i < spec.advancePastSpeakers; i++) {
      const state = chairSocket.getState();
      await chairSocket.emitWithAckAndWait(
        'queue:next',
        { currentSpeakerEntryId: state.current?.speaker?.id ?? null },
        'speaker:advanced',
      );
    }
  }

  if (spec.advancePastAgendaItems) {
    for (let i = 0; i < spec.advancePastAgendaItems; i++) {
      const state = chairSocket.getState();
      await chairSocket.emitWithAckAndWait(
        'meeting:nextAgendaItem',
        {
          currentAgendaItemId: state.current?.agendaItemId ?? null,
          conclusion: `Concluded with general support.`,
        },
        'agenda:advanced',
      );
    }
  }

  if (spec.runPoll) {
    await chairSocket.emitAndWait(
      'poll:start',
      {
        topic: spec.runPoll.topic ?? '',
        multiSelect: spec.runPoll.multiSelect ?? true,
        options: spec.runPoll.options,
      },
      'poll:started',
    );

    if (spec.runPoll.reactions) {
      const state = chairSocket.getState();
      const optionIds = state.poll.options.map((o) => o.id);
      for (const r of spec.runPoll.reactions) {
        await reactToPollAs(serverUrl, meetingId, chairSocket, r.as, optionIds[r.optionIndex]);
      }
    }

    if (spec.runPoll.stop) {
      await chairSocket.emitAndWait('poll:stop', undefined, 'poll:stopped');
    }
  }

  return { meetingId, chairSocket };
}
