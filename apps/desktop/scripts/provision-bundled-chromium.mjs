/**
 * Download Playwright's Chromium into apps/desktop/playwright-browsers/ so the
 * mac/linux installers can bundle a browser (unlike Windows 11, those platforms
 * have no guaranteed system Edge/Chrome). electron-builder ships this folder as
 * a resource on mac/linux; at runtime the shell points PLAYWRIGHT_BROWSERS_PATH
 * at it when no system browser is found.
 *
 * Run this BEFORE packaging for mac/linux (the mac/linux dist scripts do). The
 * Windows installer does not need it and does not bundle browsers.
 *
 * Run from apps/desktop:  node scripts/provision-bundled-chromium.mjs
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(here, '..', 'playwright-browsers');

console.log(`Downloading Playwright Chromium into ${target} …`);
const result = spawnSync('npx', ['playwright', 'install', 'chromium'], {
  stdio: 'inherit',
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: target },
  shell: process.platform === 'win32', // npx needs a shell on Windows
});

if (result.status !== 0) {
  console.error('Chromium provisioning failed.');
  process.exit(result.status ?? 1);
}
console.log('Bundled Chromium ready.');
