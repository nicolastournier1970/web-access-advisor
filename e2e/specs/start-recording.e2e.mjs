// Manual e2e: the start-recording journey through the real UI. Regression
// pin for the native-form-submit bug (setup form reloaded the page instead
// of starting; standalone [formControl] bindings attach no form directive,
// so (ngSubmit) never fired). Run with all three servers up:
//   npm run fixture:serve -- 4310
//   PLAYWRIGHT_HEADLESS=true node apps/api/dist/main.js
//   npm run dev -w apps/web
//   node e2e/specs/start-recording.e2e.mjs
// It fills the URL, picks a
// browser, clicks "Start recording", and asserts we LAND ON THE RECORD PAGE
// (no page reload) with a live recording, then stops it.
// Assumes: fixture on :4310, api on :3002 (headless), web on :4300.
import { chromium } from 'playwright';

const fail = (msg) => {
  console.error('FAIL:', msg);
  process.exit(1);
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
try {
  await page.goto('http://localhost:4300/', { waitUntil: 'networkidle', timeout: 60_000 });

  // Detect full page reloads: a navigation losing this marker means native submit.
  await page.evaluate(() => ((window /** @type {any} */).__waaNoReload = true));

  await page.fill('#setup-url', 'http://127.0.0.1:4310/index.html');
  // Pick the bundled Playwright Chromium card (always available, no profile).
  await page.getByText('Playwright Chromium').first().click();
  await page.getByRole('button', { name: /start recording/i }).click();

  // Route change to /sessions/:id/record without a document reload.
  await page.waitForURL(/\/sessions\/session_[a-z0-9_]+\/record/i, { timeout: 30_000 });
  const marker = await page.evaluate(() => (window /** @type {any} */).__waaNoReload === true);
  if (!marker) fail('page was RELOADED — native form submission still escaping');

  await page.getByText('Recording', { exact: false }).first().waitFor({ timeout: 15_000 });
  const sessionUrl = page.url();
  console.log('recording started, SPA-navigated to:', sessionUrl);

  // Stop and confirm we reach the analyze page.
  await page.getByRole('button', { name: /stop/i }).click();
  await page.waitForURL(/\/analyze/, { timeout: 30_000 });
  console.log('stopped, landed on:', page.url());
  console.log('PASS');
} catch (err) {
  fail(err?.message ?? String(err));
} finally {
  await browser.close();
}
