#!/usr/bin/env bash
#
# Seed a meeting with sample data for development/demo purposes.
#
# Picks random TC39 members as chairs and agenda item presenters, selects
# a random subset of plausible agenda topics and queue items, creates
# a meeting, and populates it with agenda items and a speaker queue.
#
# Requires the server to be running on localhost:3000.
#
# Usage:
#   ./scripts/seed-meeting.sh
#

set -euo pipefail

SERVER="http://localhost:3000"

# Check that the server is running
if ! curl -sf "$SERVER/api/health" > /dev/null 2>&1; then
  echo "Error: server is not running at $SERVER" >&2
  echo "Start it with: npm run dev" >&2
  exit 1
fi

# TC39 org members (fetched from https://github.com/orgs/tc39/people)
MEMBERS=(
  AbhiPrasad akira-cn alessbell allenwb andreubotella andyfleming annevk
  anonrig antfu arv ashleygwilliams atikenny bakkot banterability bashor
  benjamn BethGriggs bmeck bnb boazsender boneskull Boshen brad-decker
  BridgeAR brittanydionigi bterlson CanadaHonk chicoxyzzy cncuckoo
  codebytere Constellation ctcpip DanielRosenwasser davethegr8
  davidsonfellipe dcrousso decompil3d devsnek dherman diervo disnet
  domenic domfarolino dusave dveditz eemeli eligrey ericf evenstensberg
  fabalbon fabiorocha federicobucchi fhinkel fniephaus gesa ghermeto
  gibfahn gibson042 gisenberg goyakin gramidt gregtatum gsathya hax
  hemanth himself65 hsivonen Huxpro iarna ilias-t indexzero isaacdurazo
  Jack-Works jackbsteinberg JakobJingleheimer jamiebuilds jasonwilliams
  jdalton jeffmo joesepi jorydotcom jridgewell JSMonk kamilogorek
  keithamus kentcdodds Kingwl kriskowal kylebk LeaVerou leeight
  legendecas leobalter lforst liminzhu linclark linusg littledan ljharb
  logaretm lucacasonato Lxxyx lyr408 maggiepint marco-ippolito
  mathiasbynens mattijs Me1000 mhofman michaelficarra micheleriva
  mikemurry mikesamuel milomg mpcsh muan MylesBorins nathanhammond
  necccc nicolo-ribaudo pd4d10 phryneas piscisaureus pouwerkerk
  rickbutton rkirsling romulocintra rossberg rricard rxaviers ryzokuken
  septs Sharktheone shvaikalesh slightlyoff smorimoto southpolesteve
  srl295 styfle sunfishcode surma Swatinem tantek tcare TimothyGu
  tomayac TomKopp tschneidereit UlisesGascon wangyaju welefen westeezy
  whymarrh willyelm XadillaX XGHeaven xtuc yorkie younies yuanyan
  YuriTu zbraniecki zeldajay zenparsing
)

# Pick N random unique members
pick_random() {
  local count=$1
  printf '%s\n' "${MEMBERS[@]}" | sort -R | head -n "$count"
}

# Pick a random integer between min and max (inclusive)
rand_range() {
  local min=$1 max=$2
  echo $(( RANDOM % (max - min + 1) + min ))
}

# We need up to 20 random people to play roles as chairs and presenters
RANDOM_MEMBERS=$(pick_random 20)
readarray -t PEOPLE <<< "$RANDOM_MEMBERS"

# Select 10-20 agenda items and 6-15 queue topics
AGENDA_COUNT=$(rand_range 10 20)
QUEUE_COUNT=$(rand_range 6 15)

echo "Seeding meeting with $AGENDA_COUNT agenda items and $QUEUE_COUNT queue topics"

# Create a meeting with real TC39 members as chairs.
MEETING_JSON=$(curl -sf -X POST "$SERVER/api/meetings" \
  -H 'Content-Type: application/json' \
  -d "{\"chairs\":[\"${PEOPLE[0]}\",\"${PEOPLE[1]}\",\"${PEOPLE[2]}\"]}")

MEETING_ID=$(echo "$MEETING_JSON" | node -e "
  let d = '';
  process.stdin.on('data', c => d += c);
  process.stdin.on('end', () => console.log(JSON.parse(d).id));
")

echo "Created meeting: $MEETING_ID (chairs: ${PEOPLE[0]}, ${PEOPLE[1]}, ${PEOPLE[2]})"

# Switch to a chair so the main socket has permission to manage the meeting.
CHAIR_COOKIE=$(curl -sf -X POST "$SERVER/api/dev/switch-user" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"${PEOPLE[0]}\"}" \
  -D - -o /dev/null | grep -i '^set-cookie:' | head -1 | sed 's/^[Ss]et-[Cc]ookie: //;s/;.*//')

echo "Switched to chair: ${PEOPLE[0]}"

# Pass the people pool as a JSON array via environment variable
PEOPLE_JSON=$(printf '%s\n' "${PEOPLE[@]}" | node -e "
  let d = '';
  process.stdin.on('data', c => d += c);
  process.stdin.on('end', () => console.log(JSON.stringify(d.trim().split('\n'))));
")

# Connect via Socket.IO and set up the meeting content.
# Uses a sequential queue of actions, waiting for a state broadcast
# after each one before proceeding to the next.
PEOPLE_JSON="$PEOPLE_JSON" AGENDA_COUNT="$AGENDA_COUNT" QUEUE_COUNT="$QUEUE_COUNT" CHAIR_COOKIE="$CHAIR_COOKIE" node -e "
const { io } = require('socket.io-client');
const socket = io('$SERVER', {
  transports: ['websocket'],
  extraHeaders: { cookie: process.env.CHAIR_COOKIE },
});

// People selected from TC39 membership (passed via env var); used as both
// chairs (first few) and as the pool of potential presenters / queue authors.
const people = JSON.parse(process.env.PEOPLE_JSON);
const agendaCount = parseInt(process.env.AGENDA_COUNT, 10);
const queueCount = parseInt(process.env.QUEUE_COUNT, 10);

// --- Pool of plausible agenda topics ---
const agendaPool = [
  // Administrative / procedural
  { name: 'Opening, welcome, and roll call', timebox: 5 },
  { name: 'Review and adoption of previous meeting minutes', timebox: 10 },
  { name: 'Report from the Ecma Secretariat', timebox: 15 },
  { name: 'Report from the ECMA-262 editors', timebox: 15 },
  { name: 'Report from the ECMA-402 editors', timebox: 15 },
  { name: 'Report from the ECMA-404 editors', timebox: 5 },
  { name: 'Updates from the CoC committee', timebox: 10 },
  { name: 'TC39 chair group update', timebox: 10 },
  { name: 'TC39 delegate travel policy discussion', timebox: 15 },
  { name: 'Meeting schedule and host selection for 2027', timebox: 10 },
  { name: 'TC39 website redesign proposal', timebox: 15 },
  { name: 'Normative: editorial conventions for spec algorithms', timebox: 20 },
  { name: 'Process document: clarify Stage 2.7 requirements', timebox: 15 },
  { name: 'Liaison report: W3C TAG review outcomes', timebox: 10 },
  { name: 'Liaison report: IETF coordination on structured headers', timebox: 10 },

  // Stage advancement proposals
  { name: 'Iterator helpers for Stage 4', timebox: 30 },
  { name: 'Pattern matching for Stage 2.7', timebox: 45 },
  { name: 'Temporal API: normative changes and Stage 4 readiness', timebox: 30 },
  { name: 'Async context for Stage 3', timebox: 30 },
  { name: 'Explicit resource management: Stage 4 criteria review', timebox: 20 },
  { name: 'Decimal for Stage 2', timebox: 30 },
  { name: 'Joint iteration for Stage 2.7', timebox: 20 },
  { name: 'Signals for Stage 1', timebox: 30 },
  { name: 'Promise.withResolvers for Stage 4', timebox: 15 },
  { name: 'Set methods: Stage 4 normative fix', timebox: 15 },
  { name: 'RegExp modifiers for Stage 4', timebox: 15 },
  { name: 'Float16Array for Stage 3', timebox: 20 },
  { name: 'Error.isError for Stage 3', timebox: 15 },
  { name: 'Import attributes for Stage 4', timebox: 15 },
  { name: 'ShadowRealm: Stage 3 update and open questions', timebox: 30 },
  { name: 'Throw expressions for Stage 2', timebox: 20 },
  { name: 'Extractors for Stage 2', timebox: 30 },
  { name: 'Math.sum for Stage 2.7', timebox: 15 },
  { name: 'Symbol predicates for Stage 3', timebox: 20 },
  { name: 'Intl.MessageFormat for Stage 2', timebox: 20 },
  { name: 'String.dedent for Stage 2.7', timebox: 20 },
  { name: 'Structs for Stage 2', timebox: 45 },

  // Status updates and discussions
  { name: 'Source phase imports: implementer feedback summary', timebox: 15 },
  { name: 'Module harmony: deferred imports status update', timebox: 20 },
  { name: 'Array grouping: web compatibility follow-up', timebox: 15 },
  { name: 'Atomics.pause: implementation experience report', timebox: 15 },
  { name: 'Pipeline operator: syntax alternatives discussion', timebox: 30 },
  { name: 'Record and Tuple: progress on engine prototyping', timebox: 20 },
  { name: 'Async iterator helpers: design space overview', timebox: 20 },
  { name: 'Decorator metadata: interop with class fields', timebox: 20 },
  { name: 'Type annotations: parser feedback from engines', timebox: 30 },
  { name: 'Do expressions: interaction with completion reform', timebox: 20 },
  { name: 'Shared structs: memory model considerations', timebox: 30 },
  { name: 'WeakRef FinalizationRegistry: normative edge-case fix', timebox: 15 },
  { name: 'Realm-scoped globals: motivation and use cases', timebox: 20 },
  { name: 'Immutable ArrayBuffer: design constraints', timebox: 20 },
  { name: 'Iterator sequencing: composability with helpers', timebox: 15 },
  { name: 'Micro-waits: userland scheduling primitives', timebox: 25 },
  { name: 'Restricting subclassing of built-ins', timebox: 20 },
  { name: 'Discard bindings (_ pattern) for Stage 2', timebox: 20 },
  { name: 'ArrayBuffer transfer: normative corner case', timebox: 10 },
  { name: 'Uint8Array Base64 and hex: Stage 3 update', timebox: 15 },

  // Closing
  { name: 'Test262 status update', timebox: 10 },
  { name: 'Summary of decisions and action items', timebox: 10 },
  { name: 'Process document updates and closing', timebox: null },
];

// --- Pool of plausible queue items (all new topics) ---
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

// Shuffle an array in place (Fisher-Yates)
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Select random subsets
const selectedAgenda = shuffle([...agendaPool]).slice(0, agendaCount);
const selectedQueue = shuffle([...queuePool]).slice(0, queueCount).map(topic => ({ topic }));

// Build the action sequence
const actions = [];

// Pick N distinct random presenters from the people pool.
function pickPresenters(n) {
  const shuffled = shuffle([...people]);
  return shuffled.slice(0, n);
}

// Add agenda items. Most items have one presenter; some have two or three
// to exercise the multi-presenter data model.
selectedAgenda.forEach((item) => {
  const r = Math.random();
  const presenterCount = r < 0.1 ? 3 : r < 0.3 ? 2 : 1;
  actions.push(() => socket.emit('agenda:add', {
    name: item.name,
    presenterUsernames: pickPresenters(presenterCount),
    timebox: item.timebox,
  }));
});

// Start the meeting (advance to the first agenda item)
actions.push((state) =>
  socket.emit('meeting:nextAgendaItem', { currentAgendaItemId: state.currentAgendaItemId ?? null }, () => {})
);

// Assign a random author to each queue entry and add them as that user
selectedQueue.forEach((item) => {
  item.author = people[Math.floor(Math.random() * people.length)];
  actions.push(() => addQueueEntryAsUser(item.author, item));
});

/**
 * Add a queue entry as a specific user by:
 * 1. Calling POST /api/dev/switch-user to get a session cookie
 * 2. Creating a temporary Socket.IO connection with that cookie
 * 3. Joining the meeting and emitting queue:add
 * 4. Waiting for the state broadcast and disconnecting
 *
 * The main socket receives the state broadcast, which advances
 * the action queue.
 */
function addQueueEntryAsUser(username, item) {
  // Switch user via the dev endpoint and capture the session cookie
  fetch('$SERVER/api/dev/switch-user', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username }),
  }).then((res) => {
    // Extract the set-cookie header for the session
    const setCookie = res.headers.getSetCookie?.() ?? [];
    const cookieStr = setCookie.map(c => c.split(';')[0]).join('; ');

    // Create a temporary socket as this user
    const tmpSocket = io('$SERVER', {
      transports: ['websocket'],
      extraHeaders: { cookie: cookieStr },
    });

    tmpSocket.on('connect', () => {
      tmpSocket.emit('join', '$MEETING_ID');
    });

    // Wait for initial state, then add the entry and disconnect
    tmpSocket.once('state', () => {
      tmpSocket.emit('queue:add', { type: 'topic', topic: item.topic });
      // Give it a moment to process, then disconnect
      setTimeout(() => tmpSocket.disconnect(), 100);
    });

    tmpSocket.on('error', (msg) => {
      console.error('Error as ' + username + ': ' + msg);
      tmpSocket.disconnect();
    });
  });
}

// --- Execute actions sequentially ---

let actionIndex = 0;

socket.on('connect', () => {
  socket.emit('join', '$MEETING_ID');
});

socket.on('error', (msg) => {
  console.error('Server error: ' + msg);
  process.exit(1);
});

socket.on('state', (state) => {
  if (actionIndex < actions.length) {
    const action = actions[actionIndex++];
    action(state);
  } else {
    // All actions done — print summary
    console.log('');
    console.log('Meeting seeded successfully!');
    console.log('');
    console.log('  Agenda items:     ' + state.agenda.length);
    console.log('  Queue entries:    ' + state.queue.orderedIds.length);
    console.log('');
    state.queue.orderedIds.forEach((id, i) => {
      const e = state.queue.entries[id];
      const u = state.users[e.userId];
      console.log('    ' + (i + 1) + '. [' + e.type + '] ' + e.topic
        + ' (' + (u?.name ?? e.userId) + ')');
    });
    console.log('');
    console.log('  URL: http://localhost:5173/meeting/$MEETING_ID');
    console.log('');
    socket.disconnect();
    process.exit(0);
  }
});

setTimeout(() => {
  console.error('Timed out waiting for server responses');
  process.exit(1);
}, 30000);
"
