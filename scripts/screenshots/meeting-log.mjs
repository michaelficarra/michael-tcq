#!/usr/bin/env node
// meeting-log.png — the Log tab showing a chronological timeline of
// meeting events. To produce varied content we:
//   - start the meeting
//   - add a few queue entries and advance through one as speaker
//   - run a poll, then stop it (so the stopped result is in the log)
//   - advance past one agenda item with a conclusion
//
// Height ~650 fits all seven log entries plus the ongoing topic
// group at the top, with minimal empty space below.

import { getUrls, runScreenshot } from './lib.mjs';
import { populate } from './seed.mjs';

const { serverUrl, clientUrl } = getUrls();

const { meetingId, chairSocket } = await populate(serverUrl, {
  chairs: ['bakkot', 'ljharb', 'michaelficarra'],
  primaryChair: 'bakkot',
  agenda: [
    {
      name: 'Iterator helpers for Stage 4',
      presenters: ['michaelficarra'],
      duration: 30,
    },
    {
      name: 'Pattern matching for Stage 2.7',
      presenters: ['hax'],
      duration: 45,
    },
  ],
  start: true,
  queue: [
    { as: 'bakkot', topic: 'Memory overhead of deeply chained lazy iterators' },
    { as: 'ljharb', topic: 'Web compatibility risk with the proposed method names' },
    { as: 'domenic', topic: 'Coordination with the HTML spec for integration points' },
  ],
  // One speaker spoken, then a poll, then advance past the item.
  advancePastSpeakers: 1,
  runPoll: {
    topic: 'Should iterator helpers advance to Stage 4?',
    multiSelect: false,
    options: [
      { emoji: '💖', label: 'Strong Positive' },
      { emoji: '👍', label: 'Positive' },
      { emoji: '👀', label: 'Following' },
      { emoji: '🤔', label: 'Confused' },
      { emoji: '😐', label: 'Indifferent' },
      { emoji: '👎', label: 'Unconvinced' },
    ],
    reactions: [
      { as: 'bakkot', optionIndex: 0 },
      { as: 'ljharb', optionIndex: 1 },
      { as: 'michaelficarra', optionIndex: 0 },
      { as: 'domenic', optionIndex: 1 },
      { as: 'hax', optionIndex: 2 },
    ],
    stop: true,
  },
  advancePastAgendaItems: 1,
});

try {
  await runScreenshot('meeting-log', { viewport: { width: 800, height: 650 } }, async ({ page, switchUser }) => {
    await page.goto(`${clientUrl}/`);
    await switchUser('bakkot');
    await page.goto(`${clientUrl}/meeting/${encodeURIComponent(meetingId)}#log`);
    await page.getByRole('tabpanel', { name: 'Log' }).waitFor();
    // The Export button only renders when the log has at least one
    // entry — waiting on it confirms the log fetch via
    // /api/meetings/:id/log has completed.
    await page.getByRole('button', { name: 'Export' }).waitFor({ timeout: 10_000 });
  });
} finally {
  await chairSocket.close();
}
