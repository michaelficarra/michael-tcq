#!/usr/bin/env node
// sessions.png — the Agenda tab with sessions interleaved among the
// items. Each session header shows capacity / used / remaining; the
// second session is deliberately overfilled to exercise the overflow
// indicator.
//
// Captured from a participant's perspective: `admin` (the default
// mock user) is NOT a chair on this meeting, so the chair-only
// per-row edit/delete controls don't render. The capacity / used /
// remaining / overflow annotations are visible to everyone.
//
// Sessions are added (server appends to end) and then reordered into
// position via agenda:reorder. `afterIndex` is an index into the
// `agenda` array above; -1 places the session at position 0.
// Height ~660 fits the chair list, two sessions, and their items
// (including the overflow tail) snugly.

import { getUrls, runScreenshot } from './lib.mjs';
import { populate } from './seed.mjs';

const { serverUrl, clientUrl } = getUrls();

const { meetingId, chairSocket } = await populate(serverUrl, {
  chairs: ['bakkot', 'ljharb', 'michaelficarra'],
  primaryChair: 'bakkot',
  agenda: [
    { name: 'Opening, welcome, and roll call', presenters: ['bakkot'], duration: 5 },
    { name: 'Report from the ECMA-262 editors', presenters: ['michaelficarra'], duration: 15 },
    { name: 'Iterator helpers for Stage 4', presenters: ['bakkot'], duration: 30 },
    // Second session starts here.
    { name: 'Pattern matching for Stage 2.7', presenters: ['hax'], duration: 45 },
    { name: 'Temporal Stage 4 readiness', presenters: ['ljharb'], duration: 60 },
    { name: 'Decimal for Stage 2', presenters: ['domenic'], duration: 45 },
    { name: 'Structs for Stage 2', presenters: ['rkirsling'], duration: 45 },
  ],
  // Session 1 covers items 0..2 (50 mins, fits within 90).
  // Session 2 covers items 3..6 (195 mins, exceeds 120 — overflow tail of 75m).
  sessions: [
    { name: 'Day 1 — Morning Session', capacity: 90, afterIndex: -1 },
    { name: 'Day 1 — Afternoon Session', capacity: 120, afterIndex: 2 },
  ],
});

try {
  await runScreenshot('sessions', { viewport: { width: 800, height: 660 } }, async ({ page, switchUser }) => {
    await page.goto(`${clientUrl}/`);
    await switchUser('domenic');
    await page.goto(`${clientUrl}/meeting/${encodeURIComponent(meetingId)}#agenda`);
    await page.getByRole('tabpanel', { name: 'Agenda' }).waitFor();
    // Wait for the second session header — its presence confirms the
    // reorder steps have all been applied and the panel has rendered.
    await page.getByText('Day 1 — Afternoon Session').waitFor();
  });
} finally {
  await chairSocket.close();
}
