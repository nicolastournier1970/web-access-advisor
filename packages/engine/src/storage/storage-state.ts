/**
 * Playwright storageState.json metadata + behavioural validation.
 *
 * Ported from the legacy server/recordingService.ts (getStorageStateStatus /
 * validateStorageState). Hard rule: cookie/localStorage VALUES are
 * credentials-equivalent and are never logged, returned, or embedded in
 * error messages — only expiry metadata leaves this module.
 */
import { readFile } from 'node:fs/promises';

/** Shallow file/expiry check result (metadata only, never cookie values). */
export interface StorageStateStatus {
  /** File exists and parses as JSON. */
  present: boolean;
  /** Null when no cookie carries an expiry (session-only cookies) or file missing. */
  expired: boolean | null;
  /** ISO timestamp of the earliest cookie expiry, or null when none recorded. */
  earliestExpiry: string | null;
  /** Human-readable summary safe to surface in UIs/logs. */
  message: string;
}

/**
 * Inspect a storageState.json without launching a browser: does the file
 * exist, and has its earliest cookie expiry passed? Cookie `expires` is epoch
 * seconds; -1, 0 or absent means a session cookie and contributes no expiry.
 * A missing/unreadable file yields `present: false` rather than a throw.
 */
export async function getStorageStateStatus(storageStatePath: string): Promise<StorageStateStatus> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(storageStatePath, 'utf8'));
  } catch {
    return {
      present: false,
      expired: null,
      earliestExpiry: null,
      message: 'Storage state missing or unreadable',
    };
  }

  const cookies =
    typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { cookies?: unknown }).cookies)
      ? ((parsed as { cookies: unknown[] }).cookies as Array<{ expires?: unknown }>)
      : [];

  const expiries = cookies
    .map((c) => (typeof c.expires === 'number' && c.expires > 0 ? c.expires : null))
    .filter((e): e is number => e !== null);

  if (expiries.length === 0) {
    return {
      present: true,
      expired: null,
      earliestExpiry: null,
      message: 'Storage state present but no cookie expiry found (session-only cookies)',
    };
  }

  const earliest = Math.min(...expiries);
  const expired = earliest * 1000 < Date.now();
  return {
    present: true,
    expired,
    earliestExpiry: new Date(earliest * 1000).toISOString(),
    message: expired ? 'Storage state appears expired' : 'Storage state valid',
  };
}

/**
 * Minimal structural slice of a Playwright Browser used by
 * {@link validateStorageState}. Exists solely so tests can inject a fake and
 * exercise the probe logic without launching a real browser; the real
 * `chromium.launch()` result satisfies it.
 */
export interface ProbeBrowser {
  newContext(options: { storageState: string }): Promise<{
    newPage(): Promise<{
      goto(url: string, options?: { waitUntil?: 'domcontentloaded'; timeout?: number }): Promise<unknown>;
      waitForSelector(selector: string, options?: { timeout?: number }): Promise<unknown>;
      url(): string;
    }>;
    close(): Promise<void>;
  }>;
  close(): Promise<void>;
}

/** Options for {@link validateStorageState}. */
export interface ValidateStorageStateOptions {
  /** Path to storageState.json; checked for existence before any launch. */
  storageStatePath: string;
  /** URL to navigate to with the stored login applied. */
  probeUrl: string;
  /** Optional logged-in-only selector that must appear for `ok: true`. */
  successSelector?: string;
  /** Overall budget in ms (default 10 000; navigation capped at 30 000). */
  timeoutMs?: number;
  /** Defaults to true — validation probes should never pop a window. */
  headless?: boolean;
  /**
   * When provided, the landed URL is tested after navigation (and selector
   * wait); returning true fails validation with reason 'landed-on-auth-page'
   * — i.e. the saved login no longer covers the probe origin.
   */
  isAuthUrl?: (url: string) => boolean;
  /** Test seam: replaces `chromium.launch`. Production callers omit it. */
  launchBrowser?: (options: { headless: boolean }) => Promise<ProbeBrowser>;
}

/** Outcome of a behavioural storage-state probe (never contains cookie data). */
export interface ValidateStorageStateResult {
  ok: boolean;
  elapsedMs: number;
  /** Failure cause: 'storage-state-missing', 'landed-on-auth-page', or a probe error message. */
  reason?: string;
}

/**
 * Behavioural probe of a saved login: launch chromium, create a context from
 * the storageState file, navigate to `probeUrl` (domcontentloaded, bounded
 * timeout), optionally wait for `successSelector`, and — when `isAuthUrl` is
 * supplied — fail with 'landed-on-auth-page' if the landed URL matches an
 * auth page. A missing/unreadable storageState file fails fast without any
 * browser launch. The browser is always closed, including on errors.
 */
export async function validateStorageState(
  opts: ValidateStorageStateOptions,
): Promise<ValidateStorageStateResult> {
  const start = Date.now();
  const timeoutMs = opts.timeoutMs ?? 10_000;

  // Fast pre-flight: no browser when the file is missing or unreadable.
  try {
    JSON.parse(await readFile(opts.storageStatePath, 'utf8'));
  } catch {
    return { ok: false, elapsedMs: Date.now() - start, reason: 'storage-state-missing' };
  }

  const launch =
    opts.launchBrowser ??
    (async (options: { headless: boolean }): Promise<ProbeBrowser> => {
      // Lazy import keeps playwright out of the module graph for callers that
      // only ever hit the pre-flight failure path (and for unit tests).
      const { chromium } = await import('playwright');
      return chromium.launch(options);
    });

  let browser: ProbeBrowser | undefined;
  try {
    browser = await launch({ headless: opts.headless ?? true });
    const context = await browser.newContext({ storageState: opts.storageStatePath });
    const page = await context.newPage();

    await page.goto(opts.probeUrl, {
      waitUntil: 'domcontentloaded',
      timeout: Math.min(timeoutMs, 30_000),
    });

    if (opts.successSelector) {
      await page.waitForSelector(opts.successSelector, {
        timeout: Math.min(Math.max(1_000, Math.floor(timeoutMs / 3)), timeoutMs),
      });
    }

    if (opts.isAuthUrl?.(page.url())) {
      return { ok: false, elapsedMs: Date.now() - start, reason: 'landed-on-auth-page' };
    }

    return { ok: true, elapsedMs: Date.now() - start };
  } catch (error) {
    return {
      ok: false,
      elapsedMs: Date.now() - start,
      reason: error instanceof Error && error.message ? error.message : 'probe-failed',
    };
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        // Best-effort cleanup; a close failure must not mask the probe result.
      }
    }
  }
}
