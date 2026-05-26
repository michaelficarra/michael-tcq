#!/usr/bin/env node
// agenda.png — the Agenda tab showing the chair list, a sequence of
// numbered agenda items with presenters and estimates, and drag
// handles. No sessions (those get their own shot).
//
// Captured from a participant's perspective: `admin` (the default
// mock user) is NOT a chair on this meeting, so the chair-only
// controls (per-row edit/delete, the New Agenda Item / New Session
// buttons, the editable chair list) don't render. Height ~530 fits
// the chair list and the seven agenda items snugly.

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
    { name: 'Pattern matching for Stage 2.7', presenters: ['hax'], duration: 45 },
    { name: 'Temporal Stage 4 readiness', presenters: ['ljharb'], duration: 30 },
    { name: 'Decimal for Stage 2', presenters: ['domenic'], duration: 30 },
    { name: 'Summary of decisions and action items', presenters: ['bakkot'], duration: 10 },
  ],
});

try {
  await runScreenshot('agenda', { viewport: { width: 800, height: 530 } }, async ({ page, switchUser }) => {
    await page.goto(`${clientUrl}/`);
    await switchUser('domenic');
    await page.goto(`${clientUrl}/meeting/${encodeURIComponent(meetingId)}#agenda`);
    const agendaPanel = page.getByRole('tabpanel', { name: 'Agenda' });
    await agendaPanel.waitFor();
    // Wait for the first item to appear in the rendered list.
    await agendaPanel.getByText('Opening, welcome, and roll call').waitFor();
  });
} finally {
  await chairSocket.close();
}
