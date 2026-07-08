/**
 * Per-step page capture: snapshot.html + axe_results.json + axe_context.json
 * (+ optional screenshot.png) inside the session's step_NNN directory.
 * Rewrite of the legacy `captureSnapshot` / `validatePageReadiness` /
 * `capture*WithRetry` helpers (packages/core/src/analyzer.ts).
 *
 * SECURITY FIX vs. legacy: the legacy analyzer wrote raw `page.content()` to
 * disk, persisting whatever the user had typed (passwords, emails, search
 * queries) in value attributes. Here the HTML passes through
 * {@link scrubSensitiveValues} BEFORE the bytes touch disk — only the
 * scrubbed document is ever written or kept in memory.
 *
 * Structurally typed against {@link SnapshotPage} so unit tests can run the
 * full pipeline with a fake page and an injected axe runner (no browser).
 * `evaluate` takes a SCRIPT STRING because this package compiles without DOM
 * lib types; Playwright evaluates the string in page context.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from 'playwright';
import type { SessionPaths } from '../storage/session-files.js';
import type { PageState } from './dom-change-detector.js';
import { scrubSensitiveValues } from './html-scrub.js';

/** Attempts for the HTML / axe-context capture loops (legacy value). */
const CAPTURE_ATTEMPTS = 3;
/** Pause between capture attempts; tests inject ~1ms via retryDelayMs. */
const DEFAULT_RETRY_DELAY_MS = 500;
/** Written when page.content() never yields a plausible document. */
const FALLBACK_HTML =
  '<html><head><title>HTML Capture Failed</title></head><body><p>Failed to capture HTML content</p></body></html>';

/** Single-evaluate observation feeding {@link PageState} (DomChangeDetector). */
const PAGE_STATE_SCRIPT = `({
  url: window.location.href,
  title: document.title || '',
  elementCount: document.querySelectorAll('*').length,
  bodyHtml: document.body ? document.body.innerHTML : '',
})`;

/** Single-evaluate axe context capture (url/title/elementCount). */
const AXE_CONTEXT_SCRIPT = `({
  elementCount: document.querySelectorAll('*').length,
  title: document.title || 'Untitled',
  url: window.location.href,
})`;

/**
 * Structural slice of a Playwright Page used by the snapshotter. A real
 * `Page` satisfies it; fakes implement content/evaluate/screenshot only.
 * NOTE: the DEFAULT axe runner casts this back to a real `Page` for
 * AxeBuilder — pass `axeRunner` explicitly whenever `page` is a fake.
 */
export interface SnapshotPage {
  content(): Promise<string>;
  evaluate(script: string): Promise<unknown>;
  screenshot(options: { path: string; fullPage: boolean }): Promise<unknown>;
}

/** Contents of step_NNN/axe_context.json (legacy shape, unchanged). */
export interface AxeContext {
  include: string[][];
  exclude: string[][];
  elementCount: number;
  title: string;
  url: string;
}

/** In-memory result of one step capture; file paths are absolute. */
export interface SnapshotRecord {
  step: number;
  url: string;
  title: string;
  elementCount: number;
  /** Exactly what was written to snapshot.html (credential-scrubbed). */
  scrubbedHtml: string;
  /** axe violations only; the full axe output lives in axe_results.json. */
  axeViolations: unknown[];
  files: {
    html: string;
    axeResults: string;
    axeContext: string;
    /** Absent when screenshots were disabled or the capture failed. */
    screenshot?: string;
  };
}

/** Options for {@link captureSnapshot}. */
export interface CaptureSnapshotOptions {
  page: SnapshotPage;
  /** Step number; names the step_NNN directory via `paths`. */
  step: number;
  paths: SessionPaths;
  captureScreenshot: boolean;
  /**
   * Injectable axe scan. Default runs `new AxeBuilder({ page }).analyze()`
   * and therefore REQUIRES a real Playwright Page — one whose BrowserContext
   * was created explicitly via browser.newContext(): AxeBuilder.finishRun
   * opens a helper page in the same context, which Playwright forbids on the
   * ephemeral context of browser.newPage(). The full returned object is
   * written to axe_results.json; only `violations` stays in memory.
   */
  axeRunner?: (page: SnapshotPage) => Promise<{ violations: unknown[] }>;
  /** Delay between capture retry attempts (default 500; tests use ~1). */
  retryDelayMs?: number;
}

/**
 * Observe the page in ONE evaluate call (url, title, element count, body
 * HTML) for DomChangeDetector diffing. Malformed evaluate results normalize
 * to safe defaults; evaluate failures (page closed, navigation race)
 * propagate to the caller.
 */
export async function capturePageState(page: SnapshotPage): Promise<PageState> {
  const raw = (await page.evaluate(PAGE_STATE_SCRIPT)) as Record<string, unknown> | null | undefined;
  return {
    url: typeof raw?.url === 'string' ? raw.url : '',
    title: typeof raw?.title === 'string' ? raw.title : '',
    elementCount: typeof raw?.elementCount === 'number' ? raw.elementCount : 0,
    bodyHtml: typeof raw?.bodyHtml === 'string' ? raw.bodyHtml : '',
  };
}

/**
 * Capture one step: create step_NNN/, write the SCRUBBED snapshot.html
 * (retried up to 3×; a document is plausible when it is >100 chars and
 * contains '<body'), run axe (full output → axe_results.json; a failed scan
 * writes `{ violations: [], error }` so the file always exists), write the
 * validated axe_context.json (retried until the url is neither empty nor
 * 'about:blank' and elements exist — port of validatePageReadiness; falls
 * back to url 'unknown'), and best-effort screenshot.png when enabled
 * (failure → no `files.screenshot`, never fatal). Only unrecoverable I/O
 * (mkdir/write on the session dir) can throw.
 */
export async function captureSnapshot(opts: CaptureSnapshotOptions): Promise<SnapshotRecord> {
  const { page, step, paths, captureScreenshot } = opts;
  const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const axeRunner = opts.axeRunner ?? defaultAxeRunner;
  const files = paths.stepFiles(step);
  await mkdir(paths.stepDir(step), { recursive: true });

  // 1. HTML — scrubbed BEFORE it reaches disk (see module header).
  const rawHtml = await captureHtmlWithRetry(page, retryDelayMs);
  const scrubbedHtml = scrubSensitiveValues(rawHtml);
  await writeFile(files.snapshot, scrubbedHtml, 'utf8');

  // 2. axe scan — full result object on disk, violations only in memory.
  let axeViolations: unknown[] = [];
  try {
    const axeResult = await axeRunner(page);
    axeViolations = Array.isArray(axeResult.violations) ? axeResult.violations : [];
    await writeFile(files.axeResults, JSON.stringify(axeResult, null, 2), 'utf8');
  } catch (error) {
    await writeFile(
      files.axeResults,
      JSON.stringify({ violations: [], error: describeError(error) }, null, 2),
      'utf8',
    );
  }

  // 3. axe context — validated url/elementCount with retry.
  const axeContext = await captureAxeContextWithRetry(page, retryDelayMs);
  await writeFile(files.axeContext, JSON.stringify(axeContext, null, 2), 'utf8');

  // 4. Screenshot — best-effort, never fatal.
  let screenshotFile: string | undefined;
  if (captureScreenshot) {
    try {
      await page.screenshot({ path: files.screenshot, fullPage: true });
      screenshotFile = files.screenshot;
    } catch {
      // No screenshot file on failure; the snapshot itself stands.
    }
  }

  return {
    step,
    url: axeContext.url,
    title: axeContext.title,
    elementCount: axeContext.elementCount,
    scrubbedHtml,
    axeViolations,
    files: {
      html: files.snapshot,
      axeResults: files.axeResults,
      axeContext: files.axeContext,
      ...(screenshotFile !== undefined ? { screenshot: screenshotFile } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Default axe scan; only valid when `page` is a real Playwright Page. */
async function defaultAxeRunner(page: SnapshotPage): Promise<{ violations: unknown[] }> {
  return new AxeBuilder({ page: page as unknown as Page }).analyze();
}

/**
 * page.content() with up to 3 attempts; a capture is accepted when it is
 * longer than 100 chars and contains '<body' (legacy heuristic). Errors and
 * junk both retry; the legacy fallback document is returned when every
 * attempt fails so downstream files stay well-formed.
 */
async function captureHtmlWithRetry(page: SnapshotPage, retryDelayMs: number): Promise<string> {
  for (let attempt = 1; attempt <= CAPTURE_ATTEMPTS; attempt++) {
    try {
      const html = await page.content();
      if (html && html.length > 100 && html.includes('<body')) {
        return html;
      }
    } catch {
      // content() can reject mid-navigation — retry below.
    }
    if (attempt < CAPTURE_ATTEMPTS) await sleep(retryDelayMs);
  }
  return FALLBACK_HTML;
}

/**
 * Evaluate the axe context with up to 3 attempts; accepted only when the url
 * is non-empty and not 'about:blank' AND elements exist (port of the legacy
 * validatePageReadiness + captureAxeContextWithRetry, preventing "Unknown"
 * URLs in analysis output). Falls back to the legacy sentinel context.
 */
async function captureAxeContextWithRetry(
  page: SnapshotPage,
  retryDelayMs: number,
): Promise<AxeContext> {
  for (let attempt = 1; attempt <= CAPTURE_ATTEMPTS; attempt++) {
    try {
      const raw = (await page.evaluate(AXE_CONTEXT_SCRIPT)) as Record<string, unknown> | null;
      const context: AxeContext = {
        include: [['html']],
        exclude: [],
        elementCount: typeof raw?.elementCount === 'number' ? raw.elementCount : 0,
        title: typeof raw?.title === 'string' ? raw.title : 'Untitled',
        url: typeof raw?.url === 'string' ? raw.url : '',
      };
      if (context.url && context.url !== 'about:blank' && context.elementCount > 0) {
        return context;
      }
    } catch {
      // Evaluate can reject mid-navigation — retry below.
    }
    if (attempt < CAPTURE_ATTEMPTS) await sleep(retryDelayMs);
  }
  return {
    include: [['html']],
    exclude: [],
    elementCount: 0,
    title: 'Context Capture Failed',
    url: 'unknown',
  };
}

/** Compact error text for the axe failure sentinel (bounded, never throws). */
function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 300 ? `${message.slice(0, 297)}...` : message;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
