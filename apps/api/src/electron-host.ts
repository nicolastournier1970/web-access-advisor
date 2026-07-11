/**
 * API entry point for the packaged desktop app. The Electron main process forks
 * this (utilityProcess.fork) instead of main.ts, injecting writable paths and
 * WAA_STATIC_DIR via env. Differences from main.ts:
 *  - serves the built Angular SPA same-origin (configureStatic) so relative
 *    /api fetch + native SSE work with no base-URL seam;
 *  - binds an OS-assigned ephemeral port on 127.0.0.1 (no Windows Firewall
 *    prompt, no port collisions) and reports the real URL to the parent;
 *  - shuts down on an explicit IPC 'shutdown' message so Nest's shutdown hooks
 *    dispose Playwright (no orphaned browsers) before the process exits.
 *
 * `process.parentPort` is Electron's utility-process channel (absent from
 * @types/node); typed loosely and guarded so this file still compiles and runs
 * standalone.
 */
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { createApp, configureStatic } from './app.factory.js';

interface ParentPortLike {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
}

function parentPort(): ParentPortLike | undefined {
  return (process as unknown as { parentPort?: ParentPortLike }).parentPort;
}

async function bootstrap(): Promise<void> {
  const app = await createApp({ logger: ['error', 'warn'] });

  const staticDir = process.env['WAA_STATIC_DIR'];
  if (staticDir !== undefined && staticDir !== '') {
    configureStatic(app, staticDir);
  }

  const host = process.env['API_HOST'] ?? '127.0.0.1';
  // Port 0 → OS ephemeral (main.ts keeps API_PORT=3002 for dev); getUrl() then
  // reports the actual bound URL for the BrowserWindow to load.
  await app.listen(0, host);
  const url = await app.getUrl();

  const port = parentPort();
  port?.postMessage({ type: 'listening', url });
  // Plain stdout marker (survives any Nest logger level) so a launcher without
  // the parentPort channel can still discover the ephemeral URL.
  process.stdout.write(`WAA_LISTENING ${url}\n`);

  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    // app.close() fires enableShutdownHooks → SessionWorkerRegistry disposes
    // every live Playwright browser and the SSE channels complete.
    await app.close().catch(() => undefined);
    process.exit(0);
  };

  port?.on('message', (event) => {
    const type = (event?.data as { type?: string } | undefined)?.type;
    if (type === 'shutdown') void shutdown();
  });
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  new Logger('electron-host').log(`Web Access Advisor API (desktop) listening on ${url}`);
}

await bootstrap();
