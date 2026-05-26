#!/usr/bin/env node
// keyboard-shortcuts.png — the shortcuts dialog that appears when the
// user presses `?`. Captured inside a meeting page so all categories
// (Navigation, Queue, Speaker, etc.) are listed.
//
// Captures the full viewport (no clip), with the dialog floating over
// the dimmed queue tab — the surrounding chrome conveys that this is
// a modal overlay. Height ~800 fits the entire dialog comfortably.

import { getUrls, runScreenshot } from './lib.mjs';
import { populate } from './seed.mjs';

const { serverUrl, clientUrl } = getUrls();

const { meetingId, chairSocket } = await populate(serverUrl, {
  chairs: ['bakkot'],
  agenda: [{ name: 'Iterator helpers for Stage 4', presenters: ['michaelficarra'], duration: 30 }],
  start: true,
});

try {
  await runScreenshot('keyboard-shortcuts', { viewport: { width: 800, height: 800 } }, async ({ page, switchUser }) => {
    await page.goto(`${clientUrl}/`);
    await switchUser('bakkot');
    await page.goto(`${clientUrl}/meeting/${encodeURIComponent(meetingId)}#queue`);
    await page.getByRole('button', { name: /^(Next Agenda Item|Conclude meeting)$/ }).waitFor();
    await page.keyboard.press('?');
    await page.getByRole('dialog', { name: 'Keyboard shortcuts' }).waitFor();
  });
} finally {
  await chairSocket.close();
}
