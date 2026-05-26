#!/usr/bin/env node
// queue-chair.png — the Queue tab from a chair's perspective. Shows
// the current agenda item header, the speaker queue with chair
// controls (Next Speaker, drag handles, etc.), and a populated queue
// with priority-ordered entries.
//
// Viewed as `bakkot`, who is a chair on this meeting — switching off
// the default `admin` mock user so the nav avatar shows a real
// identity. Height ~800 fits the agenda header, the speaking section,
// the speaker-controls toolbar, and the populated speaker queue.

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
    { as: 'rkirsling', topic: 'Benchmark data from our engine prototype shows a 15% regression' },
    { as: 'hax', topic: 'Web platform tests are failing on the new method', type: 'point-of-order' },
  ],
});

try {
  await runScreenshot('queue-chair', { viewport: { width: 800, height: 800 } }, async ({ page, switchUser }) => {
    await page.goto(`${clientUrl}/`);
    await switchUser('bakkot');
    await page.goto(`${clientUrl}/meeting/${encodeURIComponent(meetingId)}#queue`);
    // Wait for a chair-only control to render — confirms the page has
    // resolved as a chair before we screenshot.
    await page.getByRole('button', { name: /^(Next Agenda Item|Conclude meeting)$/ }).waitFor();
  });
} finally {
  await chairSocket.close();
}
