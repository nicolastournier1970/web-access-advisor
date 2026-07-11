/**
 * Resolve which system-installed Chromium-family browser to drive via
 * Playwright's `channel`, so the packaged app can ship WITHOUT the ~300MB
 * bundled-browser download. Probes well-known executable locations in order
 * Edge → Chrome and returns the matching channel, or undefined when neither is
 * present (the caller then falls back to the bundled Chromium, or surfaces an
 * actionable "install Edge or Chrome" message).
 *
 * Like browsers/detect.ts, every filesystem check is bounded and this never
 * throws or hangs — the result is cached for the process after the first probe.
 */
import { access } from 'node:fs/promises';
import type { ChromiumChannel } from '@waa/shared';

/** Injectable seams so the resolver is deterministic in tests. */
export interface SystemEngineDeps {
  platform?: NodeJS.Platform;
  /** Existence check for an executable (default fs.access). */
  pathExists?: (p: string) => Promise<boolean>;
  /** Extra env for path expansion (default process.env). */
  env?: NodeJS.ProcessEnv;
}

interface ChannelCandidate {
  channel: ChromiumChannel;
  paths: readonly string[];
}

/** Well-known install locations per platform, in preference order (Edge first). */
function candidatesFor(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): ChannelCandidate[] {
  if (platform === 'win32') {
    const programFiles = env['ProgramFiles'] ?? 'C:\\Program Files';
    const programFilesX86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const localAppData = env['LOCALAPPDATA'] ?? '';
    return [
      {
        channel: 'msedge',
        paths: [
          `${programFilesX86}\\Microsoft\\Edge\\Application\\msedge.exe`,
          `${programFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
        ],
      },
      {
        channel: 'chrome',
        paths: [
          `${programFiles}\\Google\\Chrome\\Application\\chrome.exe`,
          `${programFilesX86}\\Google\\Chrome\\Application\\chrome.exe`,
          ...(localAppData ? [`${localAppData}\\Google\\Chrome\\Application\\chrome.exe`] : []),
        ],
      },
    ];
  }
  if (platform === 'darwin') {
    return [
      { channel: 'msedge', paths: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'] },
      { channel: 'chrome', paths: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'] },
    ];
  }
  // linux + others
  return [
    { channel: 'msedge', paths: ['/usr/bin/microsoft-edge', '/opt/microsoft/msedge/msedge'] },
    { channel: 'chrome', paths: ['/usr/bin/google-chrome', '/opt/google/chrome/chrome'] },
  ];
}

async function defaultPathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

let cached: ChromiumChannel | null | undefined;

/**
 * The channel of the first system Chromium found (Edge preferred over Chrome),
 * or undefined when neither is installed. Cached after the first call; pass
 * `deps` (which bypasses the cache) in tests.
 */
export async function resolveSystemChannel(
  deps: SystemEngineDeps = {},
): Promise<ChromiumChannel | undefined> {
  const injected = deps.platform !== undefined || deps.pathExists !== undefined || deps.env !== undefined;
  if (!injected && cached !== undefined) return cached ?? undefined;

  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const pathExists = deps.pathExists ?? defaultPathExists;

  let result: ChromiumChannel | undefined;
  for (const candidate of candidatesFor(platform, env)) {
    const checks = await Promise.all(candidate.paths.map((p) => pathExists(p).catch(() => false)));
    if (checks.some(Boolean)) {
      result = candidate.channel;
      break;
    }
  }

  if (!injected) cached = result ?? null;
  return result;
}

/** Test-only: reset the process cache. */
export function resetSystemChannelCache(): void {
  cached = undefined;
}
