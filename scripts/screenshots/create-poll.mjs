#!/usr/bin/env node
// create-poll.png — the poll creation modal with the default 6 option
// rows visible. The chair opens the dialog by clicking the "Create
// Poll" button on the Queue tab.
//
// Captures the full viewport (no clip), with the dialog floating over
// the dimmed queue. Height ~900 fits all six default option rows plus
// the topic input and Start/Cancel buttons.

import { getUrls, runScreenshot } from './lib.mjs';
import { populate } from './seed.mjs';

const { serverUrl, clientUrl } = getUrls();

const { meetingId, chairSocket } = await populate(serverUrl, {
  chairs: ['bakkot'],
  agenda: [{ name: 'Iterator helpers for Stage 4', presenters: ['michaelficarra'], duration: 30 }],
  start: true,
});

try {
  await runScreenshot('create-poll', { viewport: { width: 800, height: 900 } }, async ({ page, switchUser }) => {
    await page.goto(`${clientUrl}/`);
    await switchUser('bakkot');
    await page.goto(`${clientUrl}/meeting/${encodeURIComponent(meetingId)}#queue`);
    await page.getByRole('button', { name: 'Create Poll' }).click();
    const dialog = page.getByRole('dialog', { name: 'Create poll' });
    await dialog.waitFor();
    // The dialog mounts lazily; wait for the option rows to render.
    await dialog.getByLabel('Option label').first().waitFor();
  });
} finally {
  await chairSocket.close();
}
