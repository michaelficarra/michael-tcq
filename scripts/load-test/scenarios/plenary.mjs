// Realistic-plenary scenario.
//
// Split into two halves so the multi-process driver can run the chair
// in the parent (one place, drives the meeting) while a fleet of worker
// processes each owns a slice of participants.
//
//   startChairBehavior(chair, opts, metrics)
//     Probe, speaker advance, agenda advance, poll start/stop.
//
//   startParticipantBehavior(p, opts, metrics)
//     Per-client: queue add cadence, autonomous poll react (once per
//     poll, gated on local state), periodic disconnect/reconnect.
//
// Both return `{ stop }` and use the same `recurring`/`schedule`
// machinery — duplicated rather than factored to keep each half
// readable on its own.

import { PROBE_PREFIX } from '../virtualClient.mjs';

const MIN = 60_000;
const SEC = 1000;

// Cadences here are deliberately faster than a real TC39 plenary
// (where the chair advances the speaker every few minutes and the
// agenda every half-hour). A 60-second or 10-minute stage would never
// exercise those code paths at real-meeting timing — so the load test
// trades fidelity for coverage. The shape (chair drives flow,
// participants react) is what matters; the absolute frequencies are
// scaled down so each stage actually exercises advance, poll, and
// queue-pop paths multiple times.
const DEFAULTS = {
  // Per-participant queue cadence — kept relatively slow so the queue
  // doesn't run away, but fast enough that the chair has someone to
  // advance to most of the time.
  queueAddIntervalMs: [10 * SEC, 30 * SEC],
  // Chair cadence — load-test scaled (real plenary: 2–4 min / 20–40 min).
  speakerAdvanceIntervalMs: [15 * SEC, 45 * SEC],
  agendaAdvanceIntervalMs: [90 * SEC, 180 * SEC],
  pollStartIntervalMs: [60 * SEC, 120 * SEC],
  pollDurationMs: [3 * SEC, 8 * SEC],
  // Participant poll-react polling cadence — how often each participant
  // checks local state for an active poll. Only emits once per poll
  // (keyed on `poll.startTime`).
  pollReactCheckIntervalMs: [500, 2000],
  // Connection churn
  bounceIntervalMs: [3 * MIN, 7 * MIN],
  // Latency probe
  probeIntervalMs: 10 * SEC,
};

const TOPIC_POOL = [
  'Question about edge cases in the proposed semantics',
  'Concern about web compatibility with the new API',
  'Implementation experience report from our engine',
  'Suggestion to align naming with existing precedent',
  'Spec text clarification needed for step 7',
  'Interaction with the explicit resource management proposal',
  'Performance data from the prototype implementation',
  'Whether this should advance independently of the companion proposal',
];

function jitter([lo, hi]) {
  return lo + Math.floor(Math.random() * (hi - lo));
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// --- Chair behaviour ------------------------------------------------------

export function startChairBehavior(chair, opts, metrics) {
  const cfg = { ...DEFAULTS, ...opts };
  const { schedule, recurring, stop } = makeTimerScope(metrics, 'plenary-chair');

  // Latency probe
  let probeCounter = 0;
  recurring(async () => {
    probeCounter++;
    const topic = `${PROBE_PREFIX}${probeCounter}-${Date.now()}`;
    chair.emit('queue:add', { type: 'topic', topic });
    schedule(() => {
      const state = chair.getState();
      const entryId = state?.queue?.orderedIds?.find((id) => state.queue.entries[id]?.topic === topic);
      if (entryId) chair.emit('queue:remove', { id: entryId });
    }, 2 * SEC);
  }, [cfg.probeIntervalMs, cfg.probeIntervalMs + 1]);

  recurring(async () => {
    const state = chair.getState();
    chair.emit('queue:next', { currentSpeakerEntryId: state?.current?.speakerEntryId ?? null }, () => {});
  }, cfg.speakerAdvanceIntervalMs);

  recurring(async () => {
    const state = chair.getState();
    const currentItemId = state?.current?.agendaItemId ?? null;
    // If we're sitting on the last real item, advancing would either
    // be rejected or leave the meeting at the end of the agenda. Add
    // a fresh item first so the advance always has somewhere to land.
    // Both emits go over the same socket so the server processes them
    // in order — append, then advance.
    const items = (state?.agenda ?? []).filter((e) => e.kind !== 'session');
    const currentIdx = items.findIndex((i) => i.id === currentItemId);
    if (currentIdx === items.length - 1) {
      chair.emit('agenda:add', {
        name: `Auto-added item ${Date.now().toString(36)}`,
        presenterUsernames: [],
        duration: 5,
      });
    }
    chair.emit('meeting:nextAgendaItem', { currentAgendaItemId: currentItemId, conclusion: 'Moving on.' }, () => {});
  }, cfg.agendaAdvanceIntervalMs);

  // Poll storm — chair just emits start/stop. Participants react
  // autonomously in their own behaviour loops when they see the poll
  // in their local state, so the chair doesn't need to enumerate them.
  recurring(async () => {
    chair.emit('poll:start', {
      topic: 'Sentiment check',
      multiSelect: true,
      options: [
        { emoji: '👍', label: 'Positive' },
        { emoji: '👀', label: 'Following' },
        { emoji: '❓', label: 'Confused' },
        { emoji: '😕', label: 'Unconvinced' },
      ],
    });
    schedule(() => chair.emit('poll:stop'), jitter(cfg.pollDurationMs) + 1000);
  }, cfg.pollStartIntervalMs);

  return { stop };
}

// --- Participant behaviour (one per client) -------------------------------

export function startParticipantBehavior(p, opts, metrics) {
  const cfg = { ...DEFAULTS, ...opts };
  const { recurring, stop } = makeTimerScope(metrics, 'plenary-participant');

  recurring(async () => {
    p.emit('queue:add', { type: 'topic', topic: pickRandom(TOPIC_POOL) });
  }, cfg.queueAddIntervalMs);

  // React once per poll. `poll.startTime` is a stable per-poll key
  // (see ActivePoll in @tcq/shared/types.ts) — when the chair stops
  // and starts a new poll, startTime changes and we react again.
  let lastReactedKey = null;
  recurring(async () => {
    const poll = p.getState()?.poll;
    if (!poll || poll.options.length === 0) {
      lastReactedKey = null;
      return;
    }
    if (poll.startTime === lastReactedKey) return;
    const opt = pickRandom(poll.options);
    p.emit('poll:react', { optionId: opt.id });
    lastReactedKey = poll.startTime;
  }, cfg.pollReactCheckIntervalMs);

  recurring(() => p.bounce(), cfg.bounceIntervalMs);

  return { stop };
}

// --- Shared timer scope (recurring + schedule with a single stop) ---------

function makeTimerScope(metrics, scopeLabel) {
  const timers = new Set();
  let stopped = false;

  function schedule(fn, delay) {
    if (stopped) return null;
    const handle = setTimeout(async () => {
      timers.delete(handle);
      if (stopped) return;
      try {
        await fn();
      } catch (err) {
        metrics.write('scenario_error', { scope: scopeLabel, message: String(err?.message ?? err) });
      }
    }, delay);
    timers.add(handle);
    return handle;
  }

  function recurring(fn, intervalRange) {
    const tick = () => {
      schedule(async () => {
        await fn();
        if (!stopped) tick();
      }, jitter(intervalRange));
    };
    tick();
  }

  function stop() {
    stopped = true;
    for (const handle of timers) clearTimeout(handle);
    timers.clear();
  }

  return { schedule, recurring, stop };
}
