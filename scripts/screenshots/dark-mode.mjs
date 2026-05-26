#!/usr/bin/env node
// dark-mode.png — the same chair-side Queue tab as queue-chair.png,
// but with the dark theme forced via the `tcq-theme-preference`
// localStorage key. Demonstrates the full dark palette.
//
// The theme is set via an addInitScript before the first navigation
// so the dark class is applied on the very first paint — no flash of
// light mode to race against. Height ~620 fits the agenda header,
// speaker controls, and the queue snugly.

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
    {
      as: 'michaelficarra',
      topic: 'Spec text uses « » notation inconsistently here',
      type: 'question',
    },
    { as: 'domenic', topic: 'Coordination with the HTML spec for integration points' },
  ],
});

try {
  await runScreenshot(
    'dark-mode',
    {
      viewport: { width: 800, height: 620 },
      theme: 'dark',
    },
    async ({ page, switchUser }) => {
      await page.goto(`${clientUrl}/`);
      await switchUser('bakkot');
      await page.goto(`${clientUrl}/meeting/${encodeURIComponent(meetingId)}#queue`);
      await page.getByRole('button', { name: /^(Next Agenda Item|Conclude meeting)$/ }).waitFor();
    },
  );
} finally {
  await chairSocket.close();
}
