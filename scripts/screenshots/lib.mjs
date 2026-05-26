// Playwright harness for per-screenshot scripts.
//
// `runScreenshot(name, options, scenario)` launches a headless Chromium
// browser at a fixed viewport, calls the supplied scenario with the
// page and ambient context, and writes the resulting PNG to
// `docs/screenshots/<name>.png`. Scenarios that need to manage their
// own screenshot timing (e.g. modal captures using a computed clip
// rect) can opt out of the automatic shot via `scenarioTakesShot: true`
// and call `page.screenshot({ path: outPath, clip })` themselves.
//
// URLs come from `TCQ_SERVER_URL` / `TCQ_CLIENT_URL` env vars; missing
// values default to a standard local dev server. The master script
// sets them when running per-screenshot scripts as child processes
// against an isolated server on ports 3002 / 5175.

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OUTPUT_DIR = resolve(REPO_ROOT, 'docs/screenshots');

export function getUrls() {
  return {
    serverUrl: process.env.TCQ_SERVER_URL ?? 'http://localhost:3000',
    clientUrl: process.env.TCQ_CLIENT_URL ?? 'http://localhost:5173',
  };
}

/**
 * Drive the dev user-switcher UI in the nav bar to set the current
 * mock-auth identity. Modelled after `e2e/helpers.ts`'s `switchUser` —
 * the form submission triggers a full page reload that re-authenticates
 * the page with the new session.
 *
 * The page must already be on a TCQ page that renders the nav (i.e.
 * has loaded `/` or a meeting URL first).
 */
export async function switchUser(page, username) {
  const nav = page.getByRole('navigation');
  const userMenu = nav.getByRole('combobox');
  // If the form isn't visible (mobile layout, or it auto-collapsed),
  // click the user button to expose it.
  if (!(await userMenu.isVisible())) {
    await nav.getByRole('button').filter({ hasText: /\w/ }).last().click();
  }
  await userMenu.fill(username);
  await userMenu.press('Enter');
  // The form submission triggers a full page reload; wait for the
  // combobox to disappear before continuing.
  await userMenu.waitFor({ state: 'hidden' });
}

/**
 * Run one screenshot scenario.
 *
 * Options:
 *  - viewport:           default { width: 800, height: 800 }
 *  - theme:              'dark' to set the dark-mode localStorage key
 *                        before first navigation (no animation race)
 *  - scenarioTakesShot:  true if the scenario calls page.screenshot itself
 *  - clip:               forwarded to page.screenshot (not used when
 *                        scenarioTakesShot is true)
 *
 * The scenario receives `{ page, context, browser, serverUrl, clientUrl,
 * outPath, switchUser, dryRun }`.
 *
 * When the `TCQ_SCREENSHOTS_DRY_RUN` env var is `1`, the runner skips
 * the final `page.screenshot` call so no PNG is written. Scenarios that
 * take their own screenshots can check the passed `dryRun` flag (or
 * pass `outPath` to `page.screenshot` unconditionally — it accepts the
 * same dry-run behaviour because we replace `outPath` with `null` in
 * dry-run mode). Use dry-run to validate seeding and rendering paths
 * from a test suite without committing changed images.
 */
export async function runScreenshot(name, options, scenario) {
  const dryRun = process.env.TCQ_SCREENSHOTS_DRY_RUN === '1';
  if (!dryRun) mkdirSync(OUTPUT_DIR, { recursive: true });
  const { serverUrl, clientUrl } = getUrls();
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 800, height: 800 },
    // Emulate prefers-reduced-motion so entry/exit animations (e.g. the modal
    // <dialog> fade/scale) settle instantly — otherwise a shot can land
    // mid-animation, capturing a half-faded dialog with no backdrop.
    reducedMotion: 'reduce',
  });
  try {
    if (options.theme) {
      await context.addInitScript((theme) => {
        // Setting the localStorage key before any page script runs
        // guarantees the dark class is applied on the first paint —
        // no flash of light-mode chrome to race the screenshot.
        try {
          localStorage.setItem('tcq-theme-preference', theme);
        } catch {
          // localStorage can throw in some sandboxed contexts; falling
          // back to light mode is acceptable for a screenshot.
        }
      }, options.theme);
    }
    const page = await context.newPage();
    const outPath = resolve(OUTPUT_DIR, `${name}.png`);
    await scenario({
      page,
      context,
      browser,
      serverUrl,
      clientUrl,
      // In dry-run mode the scenario still receives outPath (so it can
      // log it / use it in log lines) but is expected to honour the
      // dryRun flag and skip its own page.screenshot call.
      outPath,
      dryRun,
      switchUser: (...args) => switchUser(page, ...args),
    });
    if (!options.scenarioTakesShot && !dryRun) {
      await page.screenshot({ path: outPath, clip: options.clip });
    }
    console.log(`${dryRun ? '✓ (dry-run)' : '✓'} ${name}${dryRun ? '' : ` → ${outPath}`}`);
  } finally {
    await browser.close();
  }
}

/**
 * Compute a clip rectangle for `locator` suitable for passing to
 * `page.screenshot`. Adds an optional padding (default 0) around the
 * element's bounding box so the captured PNG has a little breathing
 * room around modals. Returns null if the element isn't visible.
 */
export async function clipFor(locator, padding = 0) {
  const box = await locator.boundingBox();
  if (!box) return null;
  return {
    x: Math.max(0, Math.floor(box.x - padding)),
    y: Math.max(0, Math.floor(box.y - padding)),
    width: Math.ceil(box.width + padding * 2),
    height: Math.ceil(box.height + padding * 2),
  };
}
