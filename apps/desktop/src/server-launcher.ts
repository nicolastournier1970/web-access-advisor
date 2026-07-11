/**
 * Fork the compiled API in an Electron utilityProcess (its own Node context,
 * isolated from the UI), inject writable paths + the system-browser channel, and
 * wait until it reports its ephemeral same-origin URL. Shutdown is an explicit
 * IPC message (not a signal) so the API's Nest shutdown hooks dispose Playwright
 * before exit — no orphaned browser windows.
 */
import { utilityProcess, type UtilityProcess } from 'electron';
import http from 'node:http';
import { resolvePaths } from './paths';

export interface ApiHandle {
  /** Same-origin base URL (http://127.0.0.1:<ephemeral>) the window loads. */
  url: string;
  /** Graceful stop: IPC 'shutdown' → Nest app.close() → child exit (kill fallback). */
  shutdown(): Promise<void>;
}

const HEALTH_TIMEOUT_MS = 30_000;
const SHUTDOWN_KILL_TIMEOUT_MS = 8_000;

/** Resolve the system-Chromium channel (Edge/Chrome) to drive; undefined = none. */
async function resolveChannel(): Promise<string | undefined> {
  try {
    const engine = (await import('@waa/core')) as { resolveSystemChannel?: () => Promise<string | undefined> };
    return (await engine.resolveSystemChannel?.()) ?? undefined;
  } catch {
    return undefined;
  }
}

export async function launchApi(): Promise<ApiHandle> {
  const paths = resolvePaths();
  const channel = await resolveChannel();

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WAA_STATIC_DIR: paths.staticDir,
    WAA_USERDATA_DIR: paths.userDataDir,
    SNAPSHOTS_DIR: paths.snapshotsDir,
    AUTH_DOMAINS_CONFIG: paths.authDomainsConfig,
    API_HOST: '127.0.0.1',
    ...(channel !== undefined ? { WAA_BROWSER_CHANNEL: channel } : {}),
  };

  const child = utilityProcess.fork(paths.apiEntry, [], { env, stdio: 'inherit' });

  const url = await waitForListening(child);
  await pollHealth(url);

  return {
    url,
    shutdown: () => shutdownChild(child),
  };
}

/** Resolve when the API posts { type: 'listening', url }, reject on early exit. */
function waitForListening(child: UtilityProcess): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('API did not report a listening URL in time.')), HEALTH_TIMEOUT_MS);
    child.on('message', (message: unknown) => {
      const msg = message as { type?: string; url?: string } | undefined;
      if (msg?.type === 'listening' && typeof msg.url === 'string') {
        clearTimeout(timer);
        resolve(msg.url);
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`API process exited before listening (code ${code}).`));
    });
  });
}

/** Poll GET /api/health until 200 or the deadline (readiness backstop). */
async function pollHealth(baseUrl: string): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  for (;;) {
    if (await getOk(`${baseUrl}/api/health`)) return;
    if (Date.now() > deadline) throw new Error('API health check never returned 200.');
    await delay(250);
  }
}

function getOk(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(2_000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function shutdownChild(child: UtilityProcess): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      resolve();
    };
    child.on('exit', finish);
    try {
      child.postMessage({ type: 'shutdown' });
    } catch {
      child.kill();
      finish();
      return;
    }
    setTimeout(() => {
      if (!done) {
        child.kill();
        finish();
      }
    }, SHUTDOWN_KILL_TIMEOUT_MS);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
