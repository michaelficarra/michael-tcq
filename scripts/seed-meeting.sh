#!/usr/bin/env bash
#
# Seed a meeting with sample data for development/demo purposes.
#
# Picks random TC39 members as chairs and agenda item owners, selects
# a random subset of plausible agenda topics and queue items, creates
# a meeting, starts it, and advances to the fourth agenda item with
# a populated speaker queue.
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

# We need up to 20 random owners for agenda items
RANDOM_MEMBERS=$(pick_random 20)
readarray -t OWNERS <<< "$RANDOM_MEMBERS"

# Select 10-20 agenda items and 6-15 queue topics
AGENDA_COUNT=$(rand_range 10 20)
QUEUE_COUNT=$(rand_range 6 15)

echo "Seeding meeting with $AGENDA_COUNT agenda items and $QUEUE_COUNT queue topics"

# Create a meeting. In mock auth mode, the current user is "testuser",
# so we include it as a chair alongside the others so the script has
# permission to manage the meeting.
MEETING_JSON=$(curl -sf -X POST "$SERVER/api/meetings" \
  -H 'Content-Type: application/json' \
  -d "{\"chairs\":[\"testuser\",\"${OWNERS[0]}\",\"${OWNERS[1]}\"]}")

MEETING_ID=$(echo "$MEETING_JSON" | node -e "
  let d = '';
  process.stdin.on('data', c => d += c);
  process.stdin.on('end', () => console.log(JSON.parse(d).id));
")

echo "Created meeting: $MEETING_ID (chairs: testuser, ${OWNERS[0]}, ${OWNERS[1]})"

# Pass owners as a JSON array via environment variable
OWNERS_JSON=$(printf '%s\n' "${OWNERS[@]}" | node -e "
  let d = '';
  process.stdin.on('data', c => d += c);
  process.stdin.on('end', () => console.log(JSON.stringify(d.trim().split('\n'))));
")

# Connect via Socket.IO and set up the meeting content.
# Uses a sequential queue of actions, waiting for a state broadcast
# after each one before proceeding to the next.
OWNERS_JSON="$OWNERS_JSON" AGENDA_COUNT="$AGENDA_COUNT" QUEUE_COUNT="$QUEUE_COUNT" node -e "
const { io } = require('socket.io-client');
const socket = io('$SERVER', { transports: ['websocket'] });

// Owners selected from TC39 membership (passed via env var)
const owners = JSON.parse(process.env.OWNERS_JSON);
const agendaCount = parseInt(process.env.AGENDA_COUNT, 10);
const queueCount = parseInt(process.env.QUEUE_COUNT, 10);

// --- Pool of plausible agenda topics ---
const agendaPool = [
  { name: 'Opening, welcome, and roll call', timebox: 5 },
  { name: 'Review of previous meeting minutes', timebox: 10 },
  { name: 'Report from the Ecma Secretariat', timebox: 15 },
  { name: 'Iterator helpers for Stage 4', timebox: 30 },
  { name: 'Pattern matching update (Stage 2)', timebox: 30 },
  { name: 'Temporal API normative changes', timebox: 20 },
  { name: 'Async context for Stage 2.7', timebox: 30 },
  { name: 'Explicit resource management update', timebox: 15 },
  { name: 'Decimal for Stage 2', timebox: 20 },
  { name: 'Source phase imports status update', timebox: 15 },
  { name: 'Joint iteration for Stage 2', timebox: 20 },
  { name: 'Signals proposal discussion', timebox: 30 },
  { name: 'Module harmony: deferred imports update', timebox: 20 },
  { name: 'Intl.MessageFormat for Stage 2', timebox: 15 },
  { name: 'Array grouping follow-up', timebox: 15 },
  { name: 'Promise.withResolvers for Stage 4', timebox: 10 },
  { name: 'Set methods normative update', timebox: 15 },
  { name: 'Atomics.pause proposal', timebox: 20 },
  { name: 'RegExp modifiers for Stage 4', timebox: 15 },
  { name: 'Float16Array for Stage 3', timebox: 20 },
  { name: 'Structs and shared memory update', timebox: 30 },
  { name: 'Error.isError for Stage 3', timebox: 15 },
  { name: 'Symbol predicates proposal', timebox: 20 },
  { name: 'Math.sum for Stage 2', timebox: 15 },
  { name: 'Extractors proposal overview', timebox: 25 },
  { name: 'Pipeline operator update', timebox: 30 },
  { name: 'Record and Tuple status update', timebox: 20 },
  { name: 'Import attributes for Stage 4', timebox: 15 },
  { name: 'Async iterator helpers for Stage 2', timebox: 20 },
  { name: 'ShadowRealm for Stage 3', timebox: 25 },
  { name: 'Decorator metadata update', timebox: 15 },
  { name: 'String.dedent for Stage 2', timebox: 20 },
  { name: 'Type annotations proposal discussion', timebox: 30 },
  { name: 'Throw expressions for Stage 2', timebox: 15 },
  { name: 'Do expressions update', timebox: 20 },
  { name: 'Policy and process topics', timebox: 15 },
  { name: 'TC39 code of conduct review', timebox: 10 },
  { name: 'Test262 status update', timebox: 10 },
  { name: 'ECMA-402 (Intl) status update', timebox: 15 },
  { name: 'Process document updates and closing', timebox: null },
];

// --- Pool of plausible queue items ---
const queuePool = [
  { type: 'topic', topic: 'Performance implications of lazy evaluation in the spec' },
  { type: 'topic', topic: 'Naming concerns: web compat risk with common method names' },
  { type: 'topic', topic: 'Should .reduce() be included in this proposal or split out?' },
  { type: 'topic', topic: 'Prior art from Rust and Python iterator adaptors' },
  { type: 'topic', topic: 'Interaction with the iterator protocol and Symbol.iterator' },
  { type: 'topic', topic: 'Memory overhead of chained lazy iterators' },
  { type: 'topic', topic: 'Should we require a new built-in for this?' },
  { type: 'topic', topic: 'Comparison with lodash/underscore equivalents' },
  { type: 'topic', topic: 'Error handling semantics when the source throws' },
  { type: 'topic', topic: 'We should consider making this a syntax feature instead' },
  { type: 'topic', topic: 'Polyfill ecosystem and migration path' },
  { type: 'topic', topic: 'Implications for minifiers and bundlers' },
  { type: 'question', topic: 'How does this interact with async iterators?' },
  { type: 'question', topic: 'What is the V8 implementation status?' },
  { type: 'question', topic: 'Are there any open spec editorial issues?' },
  { type: 'question', topic: 'Has this been reviewed by the editors?' },
  { type: 'question', topic: 'How does this affect backwards compatibility?' },
  { type: 'question', topic: 'What is the test262 coverage for this proposal?' },
  { type: 'question', topic: 'Is there engine interest from all major vendors?' },
  { type: 'question', topic: 'What is the timeline for shipping behind a flag?' },
  { type: 'question', topic: 'Are there any concerns from the W3C TAG review?' },
  { type: 'question', topic: 'Is there a formal proof of the semantics?' },
  { type: 'reply', topic: 'Agree, but we should benchmark before advancing' },
  { type: 'reply', topic: 'SpiderMonkey had similar concerns, sharing our data' },
  { type: 'reply', topic: 'This matches what we observed in our implementation' },
  { type: 'reply', topic: 'Disagree, the current approach is sufficient' },
  { type: 'reply', topic: 'We tried this internally and found edge cases' },
  { type: 'reply', topic: 'The committee discussed this at the last meeting' },
  { type: 'reply', topic: 'I think we need more real-world usage data first' },
  { type: 'reply', topic: 'Our team has been using a polyfill with no issues' },
  { type: 'point-of-order', topic: 'We need to timebox this discussion' },
  { type: 'point-of-order', topic: 'Can we table this until tomorrow?' },
  { type: 'point-of-order', topic: 'We should take a poll on this' },
  { type: 'point-of-order', topic: 'The presenter should share their screen' },
  { type: 'point-of-order', topic: 'Let the current speaker finish please' },
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
const selectedQueue = shuffle([...queuePool]).slice(0, queueCount);

// Ensure we have at least one topic-type entry so we can add replies
// after advancing (replies require a current topic).
const hasTopicEntry = selectedQueue.some(q => q.type === 'topic');
if (!hasTopicEntry) {
  // Replace the last entry with a topic
  selectedQueue[selectedQueue.length - 1] = {
    type: 'topic',
    topic: 'General discussion on this proposal',
  };
}

// Split queue into items that can be added before advancing (non-reply)
// and replies that need a current topic to exist first.
const preAdvanceQueue = selectedQueue.filter(q => q.type !== 'reply');
const replies = selectedQueue.filter(q => q.type === 'reply');

// Build the action sequence
const actions = [];

// Add agenda items (each with a random owner)
selectedAgenda.forEach((item, i) => {
  actions.push(() => socket.emit('agenda:add', {
    name: item.name,
    ownerUsername: owners[i % owners.length],
    timebox: item.timebox,
  }));
});

// Start the meeting and advance to the 4th item (or last if fewer)
const advanceCount = Math.min(4, selectedAgenda.length);
for (let i = 0; i < advanceCount; i++) {
  actions.push((state) =>
    socket.emit('meeting:nextAgendaItem', { version: state.version }, () => {})
  );
}

// Assign a random owner to each queue entry
const allQueueItems = [...preAdvanceQueue, ...replies];
allQueueItems.forEach((item) => {
  // Pick a random TC39 member as the author of this queue entry
  item.author = owners[Math.floor(Math.random() * owners.length)];
});

// Add non-reply queue entries (as different users)
preAdvanceQueue.forEach((item) => {
  actions.push(() => addQueueEntryAsUser(item.author, item));
});

// Advance to the first speaker so there is a current topic
actions.push((state) =>
  socket.emit('queue:next', { version: state.version }, () => {})
);

// Now add replies (require a current topic, as different users)
replies.forEach((item) => {
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
      tmpSocket.emit('queue:add', { type: item.type, topic: item.topic });
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
    const currentItem = state.agenda.find(a => a.id === state.currentAgendaItemId);
    console.log('  Current item:     ' + (currentItem?.name ?? 'none'));
    const currentSpeaker = state.currentSpeakerId ? state.queueEntries[state.currentSpeakerId] : undefined;
    console.log('  Current speaker:  ' + (currentSpeaker?.topic ?? 'none'));
    console.log('  Queue entries:    ' + state.queuedSpeakerIds.length);
    console.log('');
    state.queuedSpeakerIds.forEach((id, i) => {
      const e = state.queueEntries[id];
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
