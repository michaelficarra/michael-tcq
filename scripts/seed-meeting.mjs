#!/usr/bin/env node
//
// Seed a meeting with sample data for development/demo purposes.
//
// Picks random TC39 members as chairs and agenda item presenters, selects
// a random subset of plausible agenda topics and queue items, creates
// a meeting, and populates it with agenda items, sessions, and a speaker
// queue.
//
// The action queue advances on every state-mutating broadcast: the
// initial `state` snapshot at join time, plus every typed delta event
// produced by the mutations this script triggers. A local copy of
// `MeetingState` is kept in sync via `@tcq/shared`'s `applyDelta` so each
// action can read the just-updated state (e.g. to find the id of the
// session it just added).
//
// Requires the server to be running on localhost:3000.
//
// Usage:
//   node scripts/seed-meeting.mjs

import { io } from 'socket.io-client';
import msgpackParser from 'socket.io-msgpack-parser';
import { applyDelta } from '@tcq/shared';

const SERVER = 'http://localhost:3000';

// --- Health check ---------------------------------------------------------

try {
  const res = await fetch(`${SERVER}/api/health`);
  if (!res.ok) throw new Error(`status ${res.status}`);
} catch {
  console.error(`Error: server is not running at ${SERVER}`);
  console.error('Start it with: npm run dev');
  process.exit(1);
}

// --- Member pool ----------------------------------------------------------

// TC39 org members (fetched from https://github.com/orgs/tc39/people).
// Distinct from `DEV_USERS` in @tcq/shared: this script only needs login
// strings, and keeping its own list avoids coupling demo data to the
// public-membership snapshot used elsewhere.
const MEMBERS = [
  'AbhiPrasad',
  'akira-cn',
  'alessbell',
  'allenwb',
  'andreubotella',
  'andyfleming',
  'annevk',
  'anonrig',
  'antfu',
  'arv',
  'ashleygwilliams',
  'atikenny',
  'bakkot',
  'banterability',
  'bashor',
  'benjamn',
  'BethGriggs',
  'bmeck',
  'bnb',
  'boazsender',
  'boneskull',
  'Boshen',
  'brad-decker',
  'BridgeAR',
  'brittanydionigi',
  'bterlson',
  'CanadaHonk',
  'chicoxyzzy',
  'cncuckoo',
  'codebytere',
  'Constellation',
  'ctcpip',
  'DanielRosenwasser',
  'davethegr8',
  'davidsonfellipe',
  'dcrousso',
  'decompil3d',
  'devsnek',
  'dherman',
  'diervo',
  'disnet',
  'domenic',
  'domfarolino',
  'dusave',
  'dveditz',
  'eemeli',
  'eligrey',
  'ericf',
  'evenstensberg',
  'fabalbon',
  'fabiorocha',
  'federicobucchi',
  'fhinkel',
  'fniephaus',
  'gesa',
  'ghermeto',
  'gibfahn',
  'gibson042',
  'gisenberg',
  'goyakin',
  'gramidt',
  'gregtatum',
  'gsathya',
  'hax',
  'hemanth',
  'himself65',
  'hsivonen',
  'Huxpro',
  'iarna',
  'ilias-t',
  'indexzero',
  'isaacdurazo',
  'Jack-Works',
  'jackbsteinberg',
  'JakobJingleheimer',
  'jamiebuilds',
  'jasonwilliams',
  'jdalton',
  'jeffmo',
  'joesepi',
  'jorydotcom',
  'jridgewell',
  'JSMonk',
  'kamilogorek',
  'keithamus',
  'kentcdodds',
  'Kingwl',
  'kriskowal',
  'kylebk',
  'LeaVerou',
  'leeight',
  'legendecas',
  'leobalter',
  'lforst',
  'liminzhu',
  'linclark',
  'linusg',
  'littledan',
  'ljharb',
  'logaretm',
  'lucacasonato',
  'Lxxyx',
  'lyr408',
  'maggiepint',
  'marco-ippolito',
  'mathiasbynens',
  'mattijs',
  'Me1000',
  'mhofman',
  'michaelficarra',
  'micheleriva',
  'mikemurry',
  'mikesamuel',
  'milomg',
  'mpcsh',
  'muan',
  'MylesBorins',
  'nathanhammond',
  'necccc',
  'nicolo-ribaudo',
  'pd4d10',
  'phryneas',
  'piscisaureus',
  'pouwerkerk',
  'rickbutton',
  'rkirsling',
  'romulocintra',
  'rossberg',
  'rricard',
  'rxaviers',
  'ryzokuken',
  'septs',
  'Sharktheone',
  'shvaikalesh',
  'slightlyoff',
  'smorimoto',
  'southpolesteve',
  'srl295',
  'styfle',
  'sunfishcode',
  'surma',
  'Swatinem',
  'tantek',
  'tcare',
  'TimothyGu',
  'tomayac',
  'TomKopp',
  'tschneidereit',
  'UlisesGascon',
  'wangyaju',
  'welefen',
  'westeezy',
  'whymarrh',
  'willyelm',
  'XadillaX',
  'XGHeaven',
  'xtuc',
  'yorkie',
  'younies',
  'yuanyan',
  'YuriTu',
  'zbraniecki',
  'zeldajay',
  'zenparsing',
];

// Fisher-Yates shuffle in place
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function randRange(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// We need up to 20 random people to play roles as chairs and presenters.
const PEOPLE = shuffle([...MEMBERS]).slice(0, 20);

const agendaCount = randRange(15, 30);
const sessionCount = randRange(2, 6);
const queueCount = randRange(6, 15);

console.log(
  `Seeding meeting with ${agendaCount} agenda items, ${sessionCount} sessions, ` + `and ${queueCount} queue topics`,
);

// --- REST setup -----------------------------------------------------------

// Create the meeting with three real TC39 members as chairs.
const createRes = await fetch(`${SERVER}/api/meetings`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ chairs: [PEOPLE[0], PEOPLE[1], PEOPLE[2]] }),
});
if (!createRes.ok) {
  console.error(`Error creating meeting: ${createRes.status} ${await createRes.text()}`);
  process.exit(1);
}
const meetingId = (await createRes.json()).id;
console.log(`Created meeting: ${meetingId} (chairs: ${PEOPLE[0]}, ${PEOPLE[1]}, ${PEOPLE[2]})`);

// Switch to a chair so the main socket has permission to manage the meeting.
const chairCookie = await switchUserCookie(PEOPLE[0]);
console.log(`Switched to chair: ${PEOPLE[0]}`);

/**
 * POST /api/dev/switch-user with the given username and return a single
 * `cookie:` request-header string built from the response's Set-Cookie
 * header(s). The session those cookies identify is the one the next
 * Socket.IO connection will pick up via `io.engine.use(sessionMiddleware)`.
 */
async function switchUserCookie(username) {
  const res = await fetch(`${SERVER}/api/dev/switch-user`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username }),
  });
  if (!res.ok) {
    console.error(`Error switching to ${username}: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const cookies = res.headers.getSetCookie?.() ?? [];
  return cookies.map((c) => c.split(';')[0]).join('; ');
}

// --- Pool of plausible agenda topics --------------------------------------

const agendaPool = [
  // Administrative / procedural
  { name: 'Opening, welcome, and roll call', duration: 5 },
  { name: 'Review and adoption of previous meeting minutes', duration: 10 },
  { name: 'Report from the Ecma Secretariat', duration: 15 },
  { name: 'Report from the ECMA-262 editors', duration: 15 },
  { name: 'Report from the ECMA-402 editors', duration: 15 },
  { name: 'Report from the ECMA-404 editors', duration: 5 },
  { name: 'Updates from the CoC committee', duration: 10 },
  { name: 'TC39 chair group update', duration: 10 },
  { name: 'TC39 delegate travel policy discussion', duration: 15 },
  { name: 'Meeting schedule and host selection for 2027', duration: 10 },
  { name: 'TC39 website redesign proposal', duration: 15 },
  { name: 'Normative: editorial conventions for spec algorithms', duration: 20 },
  { name: 'Process document: clarify Stage 2.7 requirements', duration: 15 },
  { name: 'Liaison report: W3C TAG review outcomes', duration: 10 },
  { name: 'Liaison report: IETF coordination on structured headers', duration: 10 },

  // Stage advancement proposals
  { name: 'Iterator helpers for Stage 4', duration: 30 },
  { name: 'Pattern matching for Stage 2.7', duration: 45 },
  { name: 'Temporal API: normative changes and Stage 4 readiness', duration: 30 },
  { name: 'Async context for Stage 3', duration: 30 },
  { name: 'Explicit resource management: Stage 4 criteria review', duration: 20 },
  { name: 'Decimal for Stage 2', duration: 30 },
  { name: 'Joint iteration for Stage 2.7', duration: 20 },
  { name: 'Signals for Stage 1', duration: 30 },
  { name: 'Promise.withResolvers for Stage 4', duration: 15 },
  { name: 'Set methods: Stage 4 normative fix', duration: 15 },
  { name: 'RegExp modifiers for Stage 4', duration: 15 },
  { name: 'Float16Array for Stage 3', duration: 20 },
  { name: 'Error.isError for Stage 3', duration: 15 },
  { name: 'Import attributes for Stage 4', duration: 15 },
  { name: 'ShadowRealm: Stage 3 update and open questions', duration: 30 },
  { name: 'Throw expressions for Stage 2', duration: 20 },
  { name: 'Extractors for Stage 2', duration: 30 },
  { name: 'Math.sum for Stage 2.7', duration: 15 },
  { name: 'Symbol predicates for Stage 3', duration: 20 },
  { name: 'Intl.MessageFormat for Stage 2', duration: 20 },
  { name: 'String.dedent for Stage 2.7', duration: 20 },
  { name: 'Structs for Stage 2', duration: 45 },

  // Status updates and discussions
  { name: 'Source phase imports: implementer feedback summary', duration: 15 },
  { name: 'Module harmony: deferred imports status update', duration: 20 },
  { name: 'Array grouping: web compatibility follow-up', duration: 15 },
  { name: 'Atomics.pause: implementation experience report', duration: 15 },
  { name: 'Pipeline operator: syntax alternatives discussion', duration: 30 },
  { name: 'Record and Tuple: progress on engine prototyping', duration: 20 },
  { name: 'Async iterator helpers: design space overview', duration: 20 },
  { name: 'Decorator metadata: interop with class fields', duration: 20 },
  { name: 'Type annotations: parser feedback from engines', duration: 30 },
  { name: 'Do expressions: interaction with completion reform', duration: 20 },
  { name: 'Shared structs: memory model considerations', duration: 30 },
  { name: 'WeakRef FinalizationRegistry: normative edge-case fix', duration: 15 },
  { name: 'Realm-scoped globals: motivation and use cases', duration: 20 },
  { name: 'Immutable ArrayBuffer: design constraints', duration: 20 },
  { name: 'Iterator sequencing: composability with helpers', duration: 15 },
  { name: 'Micro-waits: userland scheduling primitives', duration: 25 },
  { name: 'Restricting subclassing of built-ins', duration: 20 },
  { name: 'Discard bindings (_ pattern) for Stage 2', duration: 20 },
  { name: 'ArrayBuffer transfer: normative corner case', duration: 10 },
  { name: 'Uint8Array Base64 and hex: Stage 3 update', duration: 15 },

  // Closing
  { name: 'Test262 status update', duration: 10 },
  { name: 'Summary of decisions and action items', duration: 10 },
  { name: 'Process document updates and closing' },
];

// --- Pool of plausible queue items (all new topics) -----------------------

const queuePool = [
  // Performance and implementation
  'Performance implications of lazy evaluation in the spec',
  'Memory overhead of deeply chained lazy iterators',
  'Effect on startup performance in resource-constrained environments',
  'JIT compilation challenges with the proposed semantics',
  'Benchmark data from our engine prototype showing a 15% regression',
  'Garbage collection pressure from short-lived wrapper objects',
  'Whether engines can optimise this into a fast path',
  'Impact on streaming and back-pressure in server-side runtimes',

  // Naming and API design
  'Web compatibility risk with the proposed method names',
  'Potential for confusion with similarly named existing APIs',
  'Whether the proposed toString representation is adequate',
  'The naming convention is inconsistent with Intl and Temporal',
  'Should the static method live on the constructor or a namespace?',
  'Whether we should use a verb or noun form for the method name',

  // Scope and splitting
  'Should .reduce() be included or split into a follow-on?',
  'Feasibility of shipping this without the companion proposal',
  'This proposal is trying to do too much — can we subset it?',
  'Whether the error-handling portion should be a separate proposal',
  'Can the sync and async variants advance independently?',

  // Prior art and ecosystem
  'Prior art from Rust iterators and Python generators',
  'Comparison with lodash/Ramda equivalents and migration path',
  'Polyfillability concerns for older engines',
  'How this affects existing TypeScript type definitions',
  'Feedback from the Node.js TSC on the runtime implications',
  'Survey results from the TC39 outreach group on developer expectations',
  'Deno and Bun have both expressed interest in early implementation',

  // Spec text and semantics
  'Spec text uses « » notation inconsistently here',
  'Error handling semantics when the underlying iterator throws',
  'Cross-realm identity of the new built-in objects',
  'The abrupt completion handling in step 7 looks wrong',
  'Whether we need a normative optional annex for legacy behaviour',
  'The spec should clarify behaviour when the argument is a revoked Proxy',
  'Interaction between this and the override mistake in Object.prototype',

  // Cross-cutting concerns with other proposals
  'Overlap with the async context proposal — should we coordinate?',
  'Whether the syntax form could coexist with the API form',
  'Alignment with the proposed module loading changes',
  'Interaction with the iterator protocol and Symbol.iterator',
  'How this composes with explicit resource management',
  'Potential conflict with the pattern matching proposal',
  'Whether signals should be aware of this new observable state',

  // Developer experience and tooling
  'Developer ergonomics: feedback from framework authors',
  'Impact on bundler tree-shaking and dead-code elimination',
  'How source maps will represent the new syntax',
  'Linter and formatter implications for the new grammar productions',
  'DevTools debugging experience for chained operations',

  // Security and platform integration
  'Security considerations for the proposed API surface',
  'How this interacts with content security policies in browsers',
  'Coordination with the HTML spec for integration points',
  'Implications for Trusted Types and sanitisation APIs',
  'Whether this creates a new side channel in SharedArrayBuffer contexts',

  // Process and strategy
  'Observable divergence between engines during Stage 3',
  'Concern about spec complexity relative to developer benefit',
  'Backwards compatibility story for engines that ship early',
  'We should gather more real-world usage data before advancing',
  'Whether a symbol-based protocol would be more extensible',
  'The champions group should coordinate with WHATWG on this',
  'I would like to see test262 tests before we agree to advance',
  'Can the champion present updated slides at the next meeting?',
];

// --- Pool of plausible session headers ------------------------------------
// Sessions are display-only blocks that group a contiguous run of agenda
// items by capacity (minutes). TC39 plenaries typically run morning +
// afternoon blocks of 3-4 hours over multiple days; we slice the first N
// in order so the day labels stay sequential.
const sessionPool = [
  { name: 'Day 1 — Morning Session', capacity: 210 },
  { name: 'Day 1 — Afternoon Session', capacity: 210 },
  { name: 'Day 2 — Morning Session', capacity: 210 },
  { name: 'Day 2 — Afternoon Session', capacity: 210 },
  { name: 'Day 3 — Morning Session', capacity: 180 },
  { name: 'Day 3 — Afternoon Session', capacity: 180 },
];

// Select random subsets. Sessions are NOT shuffled — keeping their pool
// order preserves the Day 1/2/3 sequencing.
const selectedAgenda = shuffle([...agendaPool]).slice(0, agendaCount);
const selectedSessions = sessionPool.slice(0, sessionCount);
const selectedQueue = shuffle([...queuePool])
  .slice(0, queueCount)
  .map((topic) => ({ topic }));

// --- Action queue ---------------------------------------------------------

// Each action is `(state) => void`. The queue advances every time a
// state-mutating event arrives (initial `state` snapshot, or any of the
// delta events listed in DELTA_EVENTS below). We keep a local copy of
// `MeetingState` in sync so each action can read whatever the previous
// one produced.
const actions = [];

function pickPresenters(n) {
  return shuffle([...PEOPLE]).slice(0, n);
}

// Prologue + epilogue: seed both so the agenda tab has non-empty
// example block-markdown content in dev mode. The strings exercise a
// representative chunk of the allowlist (headings, lists, inline
// links, raw `<details>`/`<summary>`).
actions.push(() =>
  socket.emit('agenda:setPrologue', {
    prologue:
      '# Welcome\n\nA few notes before we start:\n\n- Please mute when not speaking.\n- Add yourself to the queue rather than interrupting.\n- Use **point of order** for procedural objections.',
  }),
);
actions.push(() =>
  socket.emit('agenda:setEpilogue', {
    epilogue:
      '<details><summary>Post-meeting reminders</summary>\n\n- File issues for anything we deferred.\n- Action items go in the meeting notes.\n\n</details>',
  }),
);

// Add agenda items. Most have one presenter; some have two or three to
// exercise the multi-presenter data model.
selectedAgenda.forEach((item) => {
  const r = Math.random();
  const presenterCount = r < 0.1 ? 3 : r < 0.3 ? 2 : 1;
  // The add schema accepts a positive integer or an omitted field for
  // 'no estimate' — it rejects null. Build the payload conditionally so
  // pool entries without a curated duration just don't carry the key.
  const payload = {
    name: item.name,
    presenterUsernames: pickPresenters(presenterCount),
  };
  if (item.duration != null) payload.duration = item.duration;
  actions.push(() => socket.emit('agenda:add', payload));
});

// Sessions: snapshot evenly-spaced insertion targets on the first add
// (when state.agenda is exactly the agenda items, no sessions yet), then
// session:add each one and reorder it into its target slot. The server
// appends new sessions to the end, and applyDelta('agenda:added') does
// the same locally — so each just-added session is at `agenda.at(-1)`.
let sessionTargets = null;
selectedSessions.forEach((session, k) => {
  actions.push((state) => {
    if (sessionTargets === null) {
      const itemIds = state.agenda.filter((e) => e.kind !== 'session').map((e) => e.id);
      const N = itemIds.length;
      const K = selectedSessions.length;
      sessionTargets = selectedSessions.map((_, i) => {
        const idx = Math.floor((i * N) / K);
        return idx === 0 ? null : itemIds[idx - 1];
      });
    }
    socket.emit('session:add', { name: session.name, capacity: session.capacity });
  });
  actions.push((state) => {
    const newSessionId = state.agenda.at(-1).id;
    socket.emit('agenda:reorder', { id: newSessionId, afterId: sessionTargets[k] });
  });
});

// Start the meeting. The schema requires currentAgendaItemId; null means
// "starting from cold", which is the only case we ever hit here. The
// server skips session headers, so this lands on the first real item.
actions.push((state) =>
  socket.emit('meeting:nextAgendaItem', { currentAgendaItemId: state.current?.agendaItemId ?? null }, () => {}),
);

// Queue: each entry is added by a randomly-chosen author via a temp
// socket. The chair socket receives the resulting `queue:added` delta
// from the room broadcast and that's what advances the action queue.
selectedQueue.forEach((item) => {
  item.author = PEOPLE[Math.floor(Math.random() * PEOPLE.length)];
  actions.push(() => addQueueEntryAsUser(item.author, item));
});

/**
 * Add a queue entry as a specific user by:
 * 1. POST /api/dev/switch-user to get a fresh session cookie for that user.
 * 2. Open a temp Socket.IO connection with that cookie.
 * 3. Join the meeting; on the first state, emit queue:add and disconnect
 *    after a short grace period so the server's broadcast goes out.
 *
 * The chair socket (separate connection) receives queue:added from the
 * room broadcast — that's what advances the main action queue.
 */
async function addQueueEntryAsUser(username, item) {
  const cookie = await switchUserCookie(username);
  const tmpSocket = io(SERVER, {
    transports: ['websocket'],
    extraHeaders: { cookie },
    parser: msgpackParser,
  });
  tmpSocket.on('connect', () => {
    tmpSocket.emit('join', meetingId);
  });
  tmpSocket.once('state', () => {
    tmpSocket.emit('queue:add', { type: 'topic', topic: item.topic });
    setTimeout(() => tmpSocket.disconnect(), 100);
  });
  tmpSocket.on('error', (msg) => {
    console.error(`Error as ${username}: ${msg}`);
    tmpSocket.disconnect();
  });
}

// --- Main socket: connect, join, drive the queue --------------------------

const socket = io(SERVER, {
  transports: ['websocket'],
  extraHeaders: { cookie: chairCookie },
  parser: msgpackParser,
});

// Local state, kept in sync with the server via applyDelta.
let meetingState = null;
let actionIndex = 0;

socket.on('connect', () => {
  socket.emit('join', meetingId);
});

socket.on('error', (msg) => {
  console.error(`Server error: ${msg}`);
  process.exit(1);
});

socket.on('state', (state) => {
  meetingState = state;
  step();
});

// Every typed delta this script can elicit. Listing them explicitly (vs
// catching every event the server defines) keeps the script's
// expectations narrow — an unrelated delta arriving here would be a sign
// the protocol or another client has changed in a way we should review.
const DELTA_EVENTS = [
  'agenda:added',
  'agenda:reordered',
  'agenda:advanced',
  'agenda:prologueSet',
  'agenda:epilogueSet',
  'queue:added',
];
for (const event of DELTA_EVENTS) {
  socket.on(event, (delta) => {
    if (meetingState) {
      meetingState = applyDelta(meetingState, { type: event, delta });
    }
    step();
  });
}

function step() {
  if (actionIndex < actions.length) {
    const action = actions[actionIndex++];
    action(meetingState);
    return;
  }
  // All actions complete — print summary, disconnect, exit.
  console.log('');
  console.log('Meeting seeded successfully!');
  console.log('');
  const itemEntries = meetingState.agenda.filter((e) => e.kind !== 'session');
  const sessionEntries = meetingState.agenda.filter((e) => e.kind === 'session');
  console.log(`  Agenda items:     ${itemEntries.length}`);
  console.log(`  Sessions:         ${sessionEntries.length}`);
  console.log(`  Queue entries:    ${meetingState.queue.orderedIds.length}`);
  console.log('');
  meetingState.queue.orderedIds.forEach((id, i) => {
    const e = meetingState.queue.entries[id];
    const u = meetingState.users[e.userId];
    console.log(`    ${i + 1}. [${e.type}] ${e.topic} (${u?.name ?? e.userId})`);
  });
  console.log('');
  console.log(`  URL: http://localhost:5173/meeting/${meetingId}`);
  console.log('');
  socket.disconnect();
  process.exit(0);
}

setTimeout(() => {
  console.error('Timed out waiting for server responses');
  process.exit(1);
}, 30000);
