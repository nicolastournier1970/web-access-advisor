/**
 * Hot-reload Electron dev launcher (cross-platform, no cross-env needed).
 * Spawns Electron with WAA_DEV_URL set so the window loads the Angular dev
 * server instead of a built bundle — UI changes hot-reload inside the real
 * Electron chrome.
 *
 * Prereq: run `npm run dev` at the repo root first (starts the API on :3002 and
 * the Angular dev server on :4300, which proxies /api to the API).
 *
 * Usage (from apps/desktop):  node scripts/dev.mjs [url]
 * Default url: http://localhost:4300 (the app's ng-serve port).
 */
import electronPath from 'electron';
import { spawn } from 'node:child_process';

const url = process.argv[2] ?? process.env.WAA_DEV_URL ?? 'http://localhost:4300';

const child = spawn(electronPath, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, WAA_DEV_URL: url },
});

child.on('exit', (code) => process.exit(code ?? 0));
child.on('error', (error) => {
  console.error('Failed to launch Electron:', error.message);
  process.exit(1);
});
