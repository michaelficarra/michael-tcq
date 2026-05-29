// Adversarial stress scenario.
//
// Same chair/participant split as plenary.mjs:
//
//   startChairBehavior(chair, opts, metrics)
//     Probe, agenda reorder churn, poll cycle (start, then periodic
//     stop+restart so poll:stop is exercised under load too).
//
//   startParticipantBehavior(p, opts, metrics)
//     Per-client: continuous queue churn (add → edit → remove) with a
//     globally-unique nonce per emit, continuous poll react flipping.

import { PROBE_PREFIX } from '../virtualClient.mjs';

const SEC = 1000;

const DEFAULTS = {
  queueChurnIntervalMs: [1000, 3000],
  agendaReorderIntervalMs: [2000, 5000],
  // Aggressive chair advancement — exercises queue:next and
  // meeting:nextAgendaItem under load. The fixture has 30 agenda
  // items, which a tight cadence can exhaust mid-run; that's
  // expected, the chair simply no-ops once it's at the last item.
  speakerAdvanceIntervalMs: [3 * SEC, 8 * SEC],
  agendaAdvanceIntervalMs: [20 * SEC, 60 * SEC],
  pollReactIntervalMs: [1000, 3000],
  pollCycleIntervalMs: [30 * SEC, 60 * SEC],
  probeIntervalMs: 5 * SEC,
};

const POLL_OPTIONS = [
  { emoji: '👍', label: 'Yes' },
  { emoji: '👎', label: 'No' },
  { emoji: '❓', label: 'Unsure' },
  { emoji: '🤷', label: 'Pass' },
];

const TOPIC_POOL = [
  'stress: spec text concern',
  'stress: implementation question',
  'stress: naming alignment',
  'stress: edge case in step 5',
  'stress: prior art comparison',
  'stress: performance regression',
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
  const { schedule, recurring, stop: stopTimers } = makeTimerScope(metrics, 'stress-chair');

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
    const items = (state?.agenda ?? []).filter((e) => e.kind !== 'session');
    if (items.length < 2) return;
    const moving = pickRandom(items);
    const target = pickRandom(items.filter((i) => i.id !== moving.id));
    chair.emit('agenda:reorder', { id: moving.id, afterId: target.id });
  }, cfg.agendaReorderIntervalMs);

  // Speaker advancement — pops queue head when one exists, no-ops on
  // empty queue. Stress-scenario participants churn entries fast (~500ms
  // lifetime), so most queue:next emits will see an empty queue; that's
  // fine, we still want to exercise the codepath.
  recurring(async () => {
    const state = chair.getState();
    chair.emit('queue:next', { currentSpeakerEntryId: state?.current?.speakerEntryId ?? null }, () => {});
  }, cfg.speakerAdvanceIntervalMs);

  // Agenda advancement — exercises meeting:nextAgendaItem, including
  // the conclusion-write path and the queue-clear-on-advance path.
  // If we'd run off the end of the agenda, append a fresh item first
  // so advancement always has somewhere to land. Both emits go over
  // the same socket so the server processes them in order.
  recurring(async () => {
    const state = chair.getState();
    const currentItemId = state?.current?.agendaItemId ?? null;
    const items = (state?.agenda ?? []).filter((e) => e.kind !== 'session');
    const currentIdx = items.findIndex((i) => i.id === currentItemId);
    if (currentIdx === items.length - 1) {
      chair.emit('agenda:add', {
        name: `Auto-added item ${Date.now().toString(36)}`,
        presenters: [],
        duration: 5,
      });
    }
    chair.emit(
      'meeting:nextAgendaItem',
      { currentAgendaItemId: currentItemId, conclusion: 'Stress: advancing.' },
      () => {},
    );
  }, cfg.agendaAdvanceIntervalMs);

  // Keep a poll running, but periodically close and reopen it so
  // poll:stop and poll:start are exercised under load too.
  chair.emit('poll:start', { topic: 'Stress poll', multiSelect: true, options: POLL_OPTIONS });
  recurring(async () => {
    chair.emit('poll:stop');
    schedule(() => {
      chair.emit('poll:start', { topic: 'Stress poll', multiSelect: true, options: POLL_OPTIONS });
    }, 200);
  }, cfg.pollCycleIntervalMs);

  return {
    stop() {
      stopTimers();
      try {
        chair.emit('poll:stop');
      } catch {
        // Chair may already be disconnected — fine.
      }
    },
  };
}

// --- Participant behaviour (one per client) -------------------------------

export function startParticipantBehavior(p, opts, metrics) {
  const cfg = { ...DEFAULTS, ...opts };
  const { schedule, recurring, stop } = makeTimerScope(metrics, 'stress-participant');

  // Queue churn — add → edit → remove. Each emit gets a globally-unique
  // nonce embedded in the topic so the edit/remove lookup unambiguously
  // finds *this client's* entry across stage transitions and across
  // workers (Date.now() + 30 bits of randomness — collision-free in
  // practice).
  recurring(async () => {
    const nonce = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`;
    const topic = `${pickRandom(TOPIC_POOL)} #${nonce}`;
    p.emit('queue:add', { type: 'topic', topic });
    schedule(() => {
      const state = p.getState();
      const suffix = `#${nonce}`;
      const ownEntryId = state?.queue?.orderedIds?.find((id) => state.queue.entries[id]?.topic?.endsWith(suffix));
      if (ownEntryId) {
        p.emit('queue:edit', { id: ownEntryId, topic: topic + ' (edited)' });
        schedule(() => p.emit('queue:remove', { id: ownEntryId }), 200);
      }
    }, 300);
  }, cfg.queueChurnIntervalMs);

  // Continuous poll react flipping. Uses local state to read the
  // current poll's options; if the poll is between cycles (the chair
  // is restarting it), this just no-ops for that tick.
  recurring(async () => {
    const poll = p.getState()?.poll;
    if (!poll || poll.options.length === 0) return;
    const opt = pickRandom(poll.options);
    p.emit('poll:react', { optionId: opt.id });
  }, cfg.pollReactIntervalMs);

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
