#!/usr/bin/env node
// queue-participant.png — the Queue tab from a participant's
// perspective. Chair controls (Next Speaker, agenda advance) are
// hidden; the speaker-controls toolbar shows the participant's own
// queue-entry buttons.
//
// Viewed as `domenic`, a regular participant (not in chairs) who has
// their own queue entry — the teal "own entry" left border is the
// visible distinguishing detail vs. the chair view. Height ~640 to
// fit the agenda header, the speaker controls, and the four queue
// entries.

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
    { as: 'hax', topic: 'Coordination with the HTML spec for integration points' },
    { as: 'rkirsling', topic: 'Benchmark data from our engine prototype shows a 15% regression' },
    { as: 'domenic', topic: 'I would like to see test262 tests before we advance' },
    {
      as: 'shvaikalesh',
      topic: 'Should the static method live on the constructor or a namespace?',
      type: 'question',
    },
  ],
});

try {
  await runScreenshot('queue-participant', { viewport: { width: 800, height: 640 } }, async ({ page, switchUser }) => {
    await page.goto(`${clientUrl}/`);
    await switchUser('domenic');
    await page.goto(`${clientUrl}/meeting/${encodeURIComponent(meetingId)}#queue`);
    // Wait for the speaker-controls toolbar — visible to all participants.
    await page.getByRole('group', { name: 'Queue entry types' }).waitFor();
  });
} finally {
  await chairSocket.close();
}
