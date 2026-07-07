/**
 * Installed-browser and profile detection, ported from the legacy
 * recordingService (server/recordingService.ts) but table-driven and fully
 * injectable so unit tests never touch the filesystem or launch a browser.
 *
 * Design constraints:
 *  - Every filesystem check is wrapped in a timeout (default 5s) that degrades
 *    to "not available" — detection NEVER throws and never hangs the caller.
 *  - Every known browser for the platform is returned (with `available: false`
 *    when its profile is missing), and a synthetic "Playwright Chromium" entry
 *    (clean bundled browser, no profile) is always appended so the UI always
 *    has at least one launchable option.
 *  - The legacy raw-SQLite cookie inspection was deliberately dropped.
 */
import { access, readdir } from 'node:fs/promises';
import { homedir as nodeHomedir } from 'node:os';
import path from 'node:path';
import type { BrowserOption, BrowserType, ProfileProbeResponse } from '@waa/shared';

/** Default per-check timeout before a probe degrades to "not available". */
const DEFAULT_CHECK_TIMEOUT_MS = 5_000;

/** Playwright persistent-context launch timeout used by the default prober. */
const PROBE_LAUNCH_TIMEOUT_MS = 15_000;

/**
 * Injectable environment for {@link detectBrowsers}. Every member is optional;
 * omitted members fall back to real Node implementations (`process.platform`,
 * `os.homedir`, `fs.access`, `fs.readdir`). Tests supply fakes so detection is
 * deterministic and never touches the host filesystem.
 */
export interface DetectDeps {
  /** Platform whose profile-location table to use (default `process.platform`). */
  platform?: NodeJS.Platform;
  /** Home directory resolver (default `os.homedir`). */
  homedir?: () => string;
  /** Existence check for a profile directory (default `fs.access`-based). */
  pathExists?: (p: string) => Promise<boolean>;
  /** Directory listing used to pick a Firefox profile (default `fs.readdir`). */
  listDir?: (p: string) => Promise<string[]>;
  /**
   * Per-check timeout in milliseconds; a check that has not settled by then is
   * treated as "not available" (default 5000). Injectable for fast tests.
   */
  timeoutMs?: number;
}

/** How a table entry resolves its profile path. */
type ProfileKind = 'profile-dir' | 'firefox-profiles-root';

/** One well-known profile location, relative to the user's home directory. */
interface ProfileLocation {
  readonly type: BrowserType;
  readonly name: string;
  readonly kind: ProfileKind;
  readonly segments: readonly string[];
}

/**
 * Well-known default-profile locations per platform. `profile-dir` entries are
 * used as-is when the directory exists; `firefox-profiles-root` entries are
 * listed and the `*.default-release` profile (else the first entry) is picked.
 */
const PROFILE_LOCATIONS: Partial<Record<NodeJS.Platform, readonly ProfileLocation[]>> = {
  win32: [
    {
      type: 'chromium',
      name: 'Microsoft Edge',
      kind: 'profile-dir',
      segments: ['AppData', 'Local', 'Microsoft', 'Edge', 'User Data', 'Default'],
    },
    {
      type: 'chromium',
      name: 'Google Chrome',
      kind: 'profile-dir',
      segments: ['AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Default'],
    },
    {
      type: 'firefox',
      name: 'Firefox',
      kind: 'firefox-profiles-root',
      segments: ['AppData', 'Roaming', 'Mozilla', 'Firefox', 'Profiles'],
    },
  ],
  darwin: [
    {
      type: 'chromium',
      name: 'Microsoft Edge',
      kind: 'profile-dir',
      segments: ['Library', 'Application Support', 'Microsoft Edge', 'Default'],
    },
    {
      type: 'chromium',
      name: 'Google Chrome',
      kind: 'profile-dir',
      segments: ['Library', 'Application Support', 'Google', 'Chrome', 'Default'],
    },
    {
      type: 'firefox',
      name: 'Firefox',
      kind: 'firefox-profiles-root',
      segments: ['Library', 'Application Support', 'Firefox', 'Profiles'],
    },
  ],
  linux: [
    {
      type: 'chromium',
      name: 'Microsoft Edge',
      kind: 'profile-dir',
      segments: ['.config', 'microsoft-edge', 'Default'],
    },
    {
      type: 'chromium',
      name: 'Google Chrome',
      kind: 'profile-dir',
      segments: ['.config', 'google-chrome', 'Default'],
    },
    {
      type: 'firefox',
      name: 'Firefox',
      kind: 'firefox-profiles-root',
      segments: ['.mozilla', 'firefox'],
    },
  ],
};

/**
 * Race `work` against a timer; if the timer wins or `work` rejects, resolve
 * with `fallback`. Never rejects, and always clears the timer so a fast result
 * does not keep the event loop alive for the full timeout.
 */
async function withTimeout<T>(work: Promise<T>, fallback: T, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), timeoutMs);
  });
  try {
    return await Promise.race([work.catch(() => fallback), expiry]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** `fs.access`-based existence check that maps failure to `false`. */
async function defaultPathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pick the Firefox profile to use from a profiles root: prefer an entry whose
 * name contains `.default-release`, else the first entry. Returns undefined
 * when the root is missing, unreadable, empty, or the listing timed out.
 */
async function resolveFirefoxProfile(
  root: string,
  listDir: (p: string) => Promise<string[]>,
  join: (...parts: string[]) => string,
  timeoutMs: number,
): Promise<string | undefined> {
  const entries = await withTimeout(listDir(root), [] as string[], timeoutMs);
  if (entries.length === 0) return undefined;
  const chosen = entries.find((entry) => entry.includes('.default-release')) ?? entries[0]!;
  return join(root, chosen);
}

/**
 * Detect installed browsers and their default profile directories on this
 * machine. Every known browser for the platform is reported — `available:
 * false` (and no `profilePath`) when its profile is missing or the check timed
 * out — plus a final "Playwright Chromium" entry (bundled clean browser,
 * `profileSupported: false`) that is always offered. Filesystem checks run
 * concurrently, each bounded by `deps.timeoutMs`; this function never throws.
 */
export async function detectBrowsers(deps: DetectDeps = {}): Promise<BrowserOption[]> {
  const platform = deps.platform ?? process.platform;
  const home = (deps.homedir ?? nodeHomedir)();
  const pathExists = deps.pathExists ?? defaultPathExists;
  const listDir = deps.listDir ?? readdir;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  // Join with the separator of the *target* platform so fake-platform tests
  // behave identically regardless of the host OS.
  const join = platform === 'win32' ? path.win32.join : path.posix.join;

  const locations = PROFILE_LOCATIONS[platform] ?? [];
  const browsers: BrowserOption[] = await Promise.all(
    locations.map(async (location): Promise<BrowserOption> => {
      const base = join(home, ...location.segments);
      const profilePath =
        location.kind === 'firefox-profiles-root'
          ? await resolveFirefoxProfile(base, listDir, join, timeoutMs)
          : (await withTimeout(pathExists(base), false, timeoutMs))
            ? base
            : undefined;
      return {
        type: location.type,
        name: location.name,
        available: profilePath !== undefined,
        ...(profilePath !== undefined ? { profilePath } : {}),
        profileSupported: profilePath !== undefined && location.type !== 'webkit',
      };
    }),
  );

  // Always offer the bundled clean browser — no profile, always launchable.
  browsers.push({
    type: 'chromium',
    name: 'Playwright Chromium',
    available: true,
    profileSupported: false,
  });

  return browsers;
}

/** Options for {@link probeProfile}. */
export interface ProbeProfileOptions {
  browserType: BrowserType;
  /** Absolute profile directory to attempt a persistent-context launch with. */
  profilePath: string;
  /** Passed to the default Playwright launcher (default true). */
  headless?: boolean;
  /**
   * Replaces the default Playwright `launchPersistentContext` attempt; tests
   * inject fakes here so no browser is ever launched. Whatever it resolves
   * with is closed immediately.
   */
  launcher?: (profilePath: string) => Promise<{ close(): Promise<void> }>;
}

/**
 * Default prober: launch a persistent context on the profile with the matching
 * Playwright browser. `playwright` is imported lazily so merely loading this
 * module (e.g. in tests) never pulls in the browser driver.
 */
async function launchWithPlaywright(
  browserType: BrowserType,
  profilePath: string,
  headless: boolean,
): Promise<{ close(): Promise<void> }> {
  const playwright = await import('playwright');
  const engine =
    browserType === 'firefox'
      ? playwright.firefox
      : browserType === 'webkit'
        ? playwright.webkit
        : playwright.chromium;
  return engine.launchPersistentContext(profilePath, {
    headless,
    timeout: PROBE_LAUNCH_TIMEOUT_MS,
  });
}

/**
 * Check whether a detected profile can actually be launched (a profile can
 * exist yet be locked by a running browser). Launches (via the injectable
 * launcher), closes immediately, and maps failures onto the shared
 * ProfileProbeStatus: lock errors (EBUSY / ProcessSingleton / "in use") →
 * 'locked', missing-path errors (ENOENT / "no such file" / "not exist") →
 * 'no_profile', anything else → 'error'. Never throws.
 */
export async function probeProfile(opts: ProbeProfileOptions): Promise<ProfileProbeResponse> {
  const launcher =
    opts.launcher ??
    ((profilePath: string) =>
      launchWithPlaywright(opts.browserType, profilePath, opts.headless ?? true));

  try {
    const handle = await launcher(opts.profilePath);
    await handle.close();
    return {
      status: 'usable',
      message: 'Profile launched successfully and can be used for recording.',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/EBUSY|ProcessSingleton|in use/i.test(message)) {
      return {
        status: 'locked',
        message:
          'The browser profile is locked by a running browser. Close all of its windows and try again.',
      };
    }
    if (/ENOENT|no such file|not exist/i.test(message)) {
      return {
        status: 'no_profile',
        message: 'No browser profile was found at the expected location.',
      };
    }
    return { status: 'error', message: `Profile probe failed: ${message}` };
  }
}
