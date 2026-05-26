#!/usr/bin/env node
// active-poll.png — an active poll with reactions tallied across the
// six default options. The poll is started via socket protocol, then
// throwaway sockets attributed to several TC39 members each emit a
// `poll:react` so the counts are non-zero.
//
// Captures the full viewport (no clip), so the dialog appears
// centred over the dimmed queue. Height ~700 — the active-poll
// panel is short (a single row of reaction buttons).

import { getUrls, runScreenshot } from './lib.mjs';
import { populate } from './seed.mjs';

const { serverUrl, clientUrl } = getUrls();

const { meetingId, chairSocket } = await populate(serverUrl, {
  chairs: ['bakkot'],
  agenda: [{ name: 'Iterator helpers for Stage 4', presenters: ['michaelficarra'], duration: 30 }],
  start: true,
  runPoll: {
    topic: 'Should iterator helpers advance to Stage 4?',
    multiSelect: false,
    // Match the six defaults from PollSetup so the screenshot looks
    // like what a chair would produce with no customisation.
    options: [
      { emoji: '💖', label: 'Strong Positive' },
      { emoji: '👍', label: 'Positive' },
      { emoji: '👀', label: 'Following' },
      { emoji: '🤔', label: 'Confused' },
      { emoji: '😐', label: 'Indifferent' },
      { emoji: '👎', label: 'Unconvinced' },
    ],
    // Spread reactions so the bar weights look natural — heavier on
    // positive, a few followers, one confused.
    reactions: [
      { as: 'bakkot', optionIndex: 0 },
      { as: 'ljharb', optionIndex: 0 },
      { as: 'michaelficarra', optionIndex: 0 },
      { as: 'domenic', optionIndex: 1 },
      { as: 'rkirsling', optionIndex: 1 },
      { as: 'hax', optionIndex: 1 },
      { as: 'jridgewell', optionIndex: 1 },
      { as: 'nicolo-ribaudo', optionIndex: 2 },
      { as: 'shvaikalesh', optionIndex: 2 },
      { as: 'legendecas', optionIndex: 3 },
    ],
  },
});

try {
  await runScreenshot('active-poll', { viewport: { width: 800, height: 700 } }, async ({ page, switchUser }) => {
    await page.goto(`${clientUrl}/`);
    await switchUser('bakkot');
    await page.goto(`${clientUrl}/meeting/${encodeURIComponent(meetingId)}#queue`);
    // Bumped from Playwright's default 30s: under spawn-mode load the
    // active-poll state can take a moment longer to land than usual.
    await page.getByRole('dialog', { name: 'Active poll' }).waitFor({ timeout: 60_000 });
  });
} finally {
  await chairSocket.close();
}
