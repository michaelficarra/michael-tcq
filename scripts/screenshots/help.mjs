#!/usr/bin/env node
// help.png — the Help tab showing the participant/chair guidance.
// Viewed as `bakkot`, who is the meeting's chair, so the additional
// "For Chairs" sections render (HelpPanel passes
// `showChairHelp={useIsChair()}` on the meeting page).
//
// Height ~900 — enough to show the top of the participant section
// and the start of the chair section.

import { getUrls, runScreenshot } from './lib.mjs';
import { populate } from './seed.mjs';

const { serverUrl, clientUrl } = getUrls();

const { meetingId, chairSocket } = await populate(serverUrl, {
  chairs: ['bakkot'],
  agenda: [{ name: 'Iterator helpers for Stage 4', presenters: ['michaelficarra'], duration: 30 }],
});

try {
  await runScreenshot('help', { viewport: { width: 800, height: 900 } }, async ({ page, switchUser }) => {
    await page.goto(`${clientUrl}/`);
    await switchUser('bakkot');
    await page.goto(`${clientUrl}/meeting/${encodeURIComponent(meetingId)}#help`);
    await page.getByRole('tabpanel', { name: 'Help' }).waitFor();
    await page.getByRole('heading', { name: 'How to Use TCQ' }).waitFor();
  });
} finally {
  await chairSocket.close();
}
