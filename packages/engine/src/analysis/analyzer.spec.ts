import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  analysisResultSchema,
  type ActionV2,
  type AnalysisPhase,
  type AuthDomainsConfig,
  type RecordingV2,
} from '@waa/shared';
import type { AnalyzeEvent, AnalyzeOptions } from '../engine-types.js';
import { StubProvider } from '../llm/stub.provider.js';
import type { ReplayLocator } from '../replay/replayer.js';
import { sessionPaths } from '../storage/session-files.js';
import {
  runAnalysis,
  type AnalyzerDeps,
  type AnalyzerTimers,
} from './analyzer.js';

const APP_URL = 'https://app.example/start';
const LOGIN_URL = 'https://login.example/signin';

const AUTH_CONFIG: AuthDomainsConfig = {
  authDomains: ['login.example'],
  clientDomains: [],
  authPathPatterns: ['/signin'],
};

// ---------------------------------------------------------------------------
// Fakes (no browser)
// ---------------------------------------------------------------------------

class FakeLocator implements ReplayLocator {
  constructor(
    private readonly matches: number,
    private readonly onClick?: () => void,
  ) {}
  async count(): Promise<number> {
    return this.matches;
  }
  first(): ReplayLocator {
    return this;
  }
  async click(): Promise<void> {
    this.onClick?.();
  }
  async fill(): Promise<void> {}
  async selectOption(): Promise<unknown> {
    return [];
  }
  async hover(): Promise<void> {}
}

/** Satisfies ReplayPageActions & SnapshotPage structurally. */
class FakePage {
  currentUrl = 'about:blank';
  title = 'Fake Page';
  bodyHtml = '<main>initial content</main>';
  elementCount = 25;
  passwordFieldPresent = false;
  /** goto(url) lands on redirects.get(url) when set (login-wall simulation). */
  readonly redirects = new Map<string, string>();
  readonly gotoCalls: string[] = [];
  clickCount = 0;

  readonly keyboard = { press: async (): Promise<void> => {} };

  url(): string {
    return this.currentUrl;
  }
  async goto(url: string): Promise<void> {
    this.gotoCalls.push(url);
    this.currentUrl = this.redirects.get(url) ?? url;
  }
  locator(_selector: string): ReplayLocator {
    return new FakeLocator(1, () => {
      this.clickCount++;
      this.elementCount += 5;
      this.bodyHtml += `<div>click ${this.clickCount}</div>`;
    });
  }
  getByRole(_role: string): ReplayLocator {
    return this.locator('');
  }
  getByText(_text: string): ReplayLocator {
    return this.locator('');
  }
  getByTestId(_id: string): ReplayLocator {
    return this.locator('');
  }
  async evaluate(script: string): Promise<unknown> {
    if (script.includes('password')) return this.passwordFieldPresent;
    if (script.includes('bodyHtml')) {
      return {
        url: this.currentUrl,
        title: this.title,
        elementCount: this.elementCount,
        bodyHtml: this.bodyHtml,
      };
    }
    // axe context script
    return { elementCount: this.elementCount, title: this.title, url: this.currentUrl };
  }
  async content(): Promise<string> {
    return `<html><head><title>${this.title}</title></head><body>${this.bodyHtml}${'x'.repeat(150)}</body></html>`;
  }
  async screenshot(_options: { path: string; fullPage: boolean }): Promise<unknown> {
    return Buffer.alloc(0);
  }
}

class FakeContext {
  readonly storageStatePaths: string[] = [];
  closed = false;
  async storageState(options?: { path?: string }): Promise<unknown> {
    if (options?.path !== undefined) this.storageStatePaths.push(options.path);
    return { cookies: [], origins: [] };
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeBrowser {
  closed = false;
  async close(): Promise<void> {
    this.closed = true;
  }
}

const FAKE_AXE_VIOLATION = {
  id: 'image-alt',
  impact: 'critical',
  description: 'Images must have alternate text',
  help: 'Images must have alternate text',
  helpUrl: 'https://dequeuniversity.com/rules/axe/image-alt',
  tags: ['wcag2a'],
  nodes: [{ html: '<img src="x.png">', target: ['img'] }],
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'waa-analyzer-'));
});

function act(step: number, type: ActionV2['type'], over: Partial<ActionV2> = {}): ActionV2 {
  return { type, step, timestamp: `2026-07-08T00:00:0${step}.000Z`, redacted: false, ...over };
}

function makeRecording(actions: ActionV2[], over: Partial<RecordingV2> = {}): RecordingV2 {
  return {
    formatVersion: 2,
    sessionId: 'session_analyzer',
    url: APP_URL,
    startTime: '2026-07-08T00:00:00.000Z',
    actions,
    authCheckpoints: [],
    browserType: 'chromium',
    useProfile: false,
    ...over,
  };
}

interface Harness {
  options: AnalyzeOptions;
  deps: AnalyzerDeps;
  events: AnalyzeEvent[];
  page: FakePage;
  context: FakeContext;
  browser: FakeBrowser;
  sessionDir: string;
}

function makeHarness(
  recording: RecordingV2,
  optionOverrides: Partial<AnalyzeOptions> = {},
  depOverrides: Partial<AnalyzerDeps> = {},
): Harness {
  const events: AnalyzeEvent[] = [];
  const page = new FakePage();
  const context = new FakeContext();
  const browser = new FakeBrowser();
  const sessionDir = path.join(tempRoot, recording.sessionId);
  const options: AnalyzeOptions = {
    sessionId: recording.sessionId,
    sessionDir,
    recording,
    browserType: 'chromium',
    useProfile: false,
    headless: true,
    captureScreenshots: false,
    staticSectionMode: 'ignore',
    llmProvider: null,
    llmBatchTimeoutMs: 5000,
    authConfig: AUTH_CONFIG,
    authPauseTimeoutMs: 600_000,
    onEvent: (event) => events.push(event),
    ...optionOverrides,
  };
  const deps: AnalyzerDeps = {
    launch: async () => ({ browser, context, page }),
    axeRunner: async () => ({ violations: [FAKE_AXE_VIOLATION] }),
    settleDelaysMs: { navigate: 1, click: 1, form: 1, default: 1 },
    snapshotRetryDelayMs: 1,
    ...depOverrides,
  };
  return { options, deps, events, page, context, browser, sessionDir };
}

function ofType<K extends AnalyzeEvent['type']>(
  events: AnalyzeEvent[],
  type: K,
): Array<Extract<AnalyzeEvent, { type: K }>> {
  return events.filter((e): e is Extract<AnalyzeEvent, { type: K }> => e.type === type);
}

/** Deduplicated progress-phase sequence, in emission order. */
function phasesOf(events: AnalyzeEvent[]): AnalysisPhase[] {
  const phases: AnalysisPhase[] = [];
  for (const event of events) {
    if (event.type === 'progress' && phases[phases.length - 1] !== event.phase) {
      phases.push(event.phase);
    }
  }
  return phases;
}

function expectSubsequence(actual: readonly string[], expected: readonly string[]): void {
  let cursor = 0;
  for (const phase of expected) {
    const found = actual.indexOf(phase, cursor);
    expect(found, `phase '${phase}' missing (after index ${cursor}) in [${actual.join(', ')}]`).toBeGreaterThanOrEqual(0);
    cursor = found + 1;
  }
}

const LEGACY_PHASE_PROGRESSION: AnalysisPhase[] = [
  'replaying-actions',
  'capturing-snapshots',
  'running-accessibility-checks',
  'processing-with-ai',
  'generating-report',
  'completed',
];

async function waitFor<T>(probe: () => T | undefined | false, timeoutMs = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const result = probe();
    if (result !== undefined && result !== false) return result as T;
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// ---------------------------------------------------------------------------
// Unit tests (full fakes)
// ---------------------------------------------------------------------------

describe('runAnalysis (fakes)', () => {
  it('happy path: replays, snapshots, runs axe + LLM, writes files, emits legacy phases', async () => {
    const recording = makeRecording([
      act(1, 'navigate', { url: APP_URL }),
      act(2, 'click', { selector: '#button', target: { candidates: [{ strategy: 'css', value: '#button' }] } }),
    ]);
    const h = makeHarness(recording, { llmProvider: new StubProvider() });

    const control = runAnalysis(h.options, h.deps);
    const result = await control.result;

    expect(result.success).toBe(true);
    expect(result.sessionId).toBe('session_analyzer');
    expect(result.snapshotCount).toBeGreaterThanOrEqual(1);
    expect(result.axeResults.length).toBeGreaterThan(0);
    expect(result.axeResults[0]!.id).toBe('image-alt');
    expect(result.analysis).toBeDefined();
    expect(result.llmProvider).toBe('stub');
    expect(result.completedAt).toBeDefined();

    // The replay actually drove the fake page.
    expect(h.page.gotoCalls).toEqual([APP_URL]);
    expect(h.page.clickCount).toBe(1);

    // manifest.json + analysis.json written; analysis.json is schema-valid.
    const paths = sessionPaths(path.dirname(h.sessionDir), path.basename(h.sessionDir));
    const manifestOnDisk = JSON.parse(await readFile(paths.manifest, 'utf8')) as {
      stepDetails: Array<{ step: number; actionOutcome?: string }>;
    };
    expect(manifestOnDisk.stepDetails.length).toBeGreaterThanOrEqual(1);
    expect(manifestOnDisk.stepDetails[0]!.actionOutcome).toBe('executed');
    const analysisOnDisk = analysisResultSchema.parse(
      JSON.parse(await readFile(paths.analysis, 'utf8')),
    );
    expect(analysisOnDisk.success).toBe(true);

    // Legacy progress vocabulary, in order, ending with 'completed'.
    const phases = phasesOf(h.events);
    expectSubsequence(phases, LEGACY_PHASE_PROGRESSION);
    expect(phases[phases.length - 1]).toBe('completed');

    // Browser resources always released.
    expect(h.context.closed).toBe(true);
    expect(h.browser.closed).toBe(true);

    // No pause happened → continueAuth on a finished run is a polite no.
    await expect(control.continueAuth()).resolves.toEqual({ ok: false, reason: 'not-paused' });
  });

  it('pauses on a login wall; failed validation stays paused; success resumes and saves storageState', async () => {
    const recording = makeRecording([act(1, 'navigate', { url: APP_URL })]);
    const h = makeHarness(recording, { llmProvider: new StubProvider() });
    h.page.redirects.set(APP_URL, LOGIN_URL); // navigate lands on the IdP

    const control = runAnalysis(h.options, h.deps);

    // Pause: auth-required with the LIVE login URL.
    const required = await waitFor(() => ofType(h.events, 'auth-required')[0]);
    expect(required.reason).toBe('auth-domain-navigation');
    expect(required.loginUrl).toBe(LOGIN_URL);
    expect(required.pausedAtStep).toBe(1);
    expect(required.timeoutAt).toBeTruthy();
    expect(ofType(h.events, 'auth-state').map((e) => e.state)).toContain('auth_required');

    // continueAuth while STILL on the auth page → validation fails, stays paused.
    const failed = await control.continueAuth();
    expect(failed.ok).toBe(false);
    expect(failed.reason).toBe('still-on-auth-page');
    expect(ofType(h.events, 'auth-validating').length).toBe(1);
    expect(ofType(h.events, 'auth-failed')[0]!.reason).toBe('still-on-auth-page');
    const statesAfterFail = ofType(h.events, 'auth-state').map((e) => e.state);
    expect(statesAfterFail).toContain('validating');
    expect(statesAfterFail).toContain('auth_failed');
    expect(statesAfterFail[statesAfterFail.length - 1]).toBe('auth_required');
    expect(h.context.storageStatePaths).toHaveLength(0);

    // User signs in: page moves off the auth domain, redirect gone.
    h.page.currentUrl = 'https://app.example/home';
    h.page.redirects.delete(APP_URL);

    const resumed = await control.continueAuth();
    expect(resumed).toEqual({ ok: true });

    const resolved = ofType(h.events, 'auth-resolved')[0]!;
    expect(resolved.resumedAtStep).toBe(1);
    expect(resolved.storageStateSaved).toBe(true);
    const paths = sessionPaths(path.dirname(h.sessionDir), path.basename(h.sessionDir));
    expect(h.context.storageStatePaths).toEqual([paths.storageState]);

    // Loop resumed from the paused action: the navigate was retried.
    const result = await control.result;
    expect(result.success).toBe(true);
    expect(h.page.gotoCalls).toEqual([APP_URL, APP_URL]);
    expect(result.snapshotCount).toBeGreaterThanOrEqual(1);
    expect(result.manifest.truncated).toBeUndefined();

    // analysis.json written and schema-valid.
    const analysisOnDisk = analysisResultSchema.parse(
      JSON.parse(await readFile(paths.analysis, 'utf8')),
    );
    expect(analysisOnDisk.success).toBe(true);
    expectSubsequence(phasesOf(h.events), LEGACY_PHASE_PROGRESSION);
  });

  it('password-field validation failure keeps the pause alive', async () => {
    const recording = makeRecording([act(1, 'navigate', { url: APP_URL })]);
    const h = makeHarness(recording);
    h.page.redirects.set(APP_URL, LOGIN_URL);

    const control = runAnalysis(h.options, h.deps);
    await waitFor(() => ofType(h.events, 'auth-required')[0]);

    // Off the auth URL but a password field is still on screen.
    h.page.currentUrl = 'https://app.example/home';
    h.page.passwordFieldPresent = true;
    const failed = await control.continueAuth();
    expect(failed).toEqual({ ok: false, reason: 'password-field-still-present' });

    h.page.passwordFieldPresent = false;
    h.page.redirects.delete(APP_URL);
    await expect(control.continueAuth()).resolves.toEqual({ ok: true });
    const result = await control.result;
    expect(result.success).toBe(true);
  });

  it('cancelAuth aborts the paused replay and marks the manifest truncated', async () => {
    const recording = makeRecording([
      act(1, 'navigate', { url: APP_URL }),
      act(2, 'click', { selector: '#never' }),
    ]);
    const h = makeHarness(recording);
    h.page.redirects.set(APP_URL, LOGIN_URL);

    const control = runAnalysis(h.options, h.deps);
    await waitFor(() => ofType(h.events, 'auth-required')[0]);
    await control.cancelAuth();

    const result = await control.result;
    expect(result.success).toBe(true); // partial result, not a crash
    expect(result.manifest.truncated).toBe(true);
    expect(result.manifest.truncationReason).toContain('cancelled');
    expect(result.warnings.some((w) => w.includes('cancelled'))).toBe(true);
    expect(ofType(h.events, 'auth-state').map((e) => e.state)).toContain('cancelled');
    // The post-pause action never ran.
    expect(h.page.clickCount).toBe(0);
    expect(h.context.closed).toBe(true);
    // manifest.json persisted with the truncation note.
    const paths = sessionPaths(path.dirname(h.sessionDir), path.basename(h.sessionDir));
    const manifestOnDisk = JSON.parse(await readFile(paths.manifest, 'utf8')) as {
      truncated?: boolean;
    };
    expect(manifestOnDisk.truncated).toBe(true);
  });

  it('times out a pause via the injected clock/timers and truncates like a cancel', async () => {
    const recording = makeRecording([act(1, 'navigate', { url: APP_URL })]);
    let now = 1_000_000;
    const intervalCallbacks: Array<() => void> = [];
    let clearedCount = 0;
    const timers: AnalyzerTimers = {
      setInterval: (callback) => {
        intervalCallbacks.push(callback);
        return callback;
      },
      clearInterval: () => {
        clearedCount++;
      },
    };
    const h = makeHarness(
      recording,
      { authPauseTimeoutMs: 5000 },
      { clock: () => now, timers },
    );
    h.page.redirects.set(APP_URL, LOGIN_URL);

    const control = runAnalysis(h.options, h.deps);
    await waitFor(() => ofType(h.events, 'auth-required')[0]);
    expect(intervalCallbacks).toHaveLength(1);

    // Not yet expired: the poll is a no-op.
    intervalCallbacks[0]!();
    expect(ofType(h.events, 'auth-state').map((e) => e.state)).not.toContain('timed_out');

    // Cross the deadline and poll again.
    now += 5001;
    intervalCallbacks[0]!();

    const result = await control.result;
    expect(ofType(h.events, 'auth-state').map((e) => e.state)).toContain('timed_out');
    expect(result.manifest.truncated).toBe(true);
    expect(result.manifest.truncationReason).toContain('not completed within 5000ms');
    expect(clearedCount).toBeGreaterThanOrEqual(1);
  });

  it('pauses on a recorded checkpoint before the step it precedes', async () => {
    const recording = makeRecording(
      [
        act(1, 'navigate', { url: APP_URL }),
        act(2, 'click', { selector: '#a' }),
        act(3, 'click', { selector: '#b' }),
      ],
      {
        authCheckpoints: [
          {
            id: 'cp1',
            afterStep: 2,
            reason: 'user-marked',
            storageStateSaved: false,
            startedAt: '2026-07-08T00:00:00.000Z',
          },
        ],
      },
    );
    const h = makeHarness(recording);

    const control = runAnalysis(h.options, h.deps);
    const required = await waitFor(() => ofType(h.events, 'auth-required')[0]);
    expect(required.reason).toBe('recorded-checkpoint');
    expect(required.checkpointId).toBe('cp1');
    // The checkpoint sits AFTER step 2: steps 1-2 replay first (they belong to
    // the pre-login flow), the pause lands before step 3.
    expect(required.pausedAtStep).toBe(3);
    // Step 2 HAS executed; step 3 has not.
    expect(h.page.clickCount).toBe(1);

    // Page is on the app (no auth URL, no password field) → validation passes.
    await expect(control.continueAuth()).resolves.toEqual({ ok: true });
    const result = await control.result;
    expect(result.success).toBe(true);
    // Checkpoint consumed: both clicks ran, no second pause.
    expect(h.page.clickCount).toBe(2);
    expect(ofType(h.events, 'auth-required')).toHaveLength(1);
    expect(h.context.storageStatePaths).toHaveLength(1);
  });

  it('never rejects: a thrown launch resolves to success:false with the error', async () => {
    const recording = makeRecording([act(1, 'navigate', { url: APP_URL })]);
    const h = makeHarness(recording, {}, {
      launch: async () => {
        throw new Error('browser exploded');
      },
    });

    const result = await runAnalysis(h.options, h.deps).result;
    expect(result.success).toBe(false);
    expect(result.error).toBe('browser exploded');
    expect(result.snapshotCount).toBe(0);
    expect(result.manifest.sessionId).toBe('session_analyzer');
    const phases = phasesOf(h.events);
    expect(phases[phases.length - 1]).toBe('completed');
  });

  it('skips the AI phase when llmProvider is null (axe-only)', async () => {
    const recording = makeRecording([act(1, 'navigate', { url: APP_URL })]);
    const h = makeHarness(recording, { llmProvider: null });

    const result = await runAnalysis(h.options, h.deps).result;
    expect(result.success).toBe(true);
    expect(result.analysis).toBeUndefined();
    expect(result.llmProvider).toBeUndefined();
    expect(result.axeResults.length).toBeGreaterThan(0);
    expect(phasesOf(h.events)).not.toContain('processing-with-ai');
  });

  it('surfaces a launch degradation warning as progress + result warning', async () => {
    const recording = makeRecording([act(1, 'navigate', { url: APP_URL })]);
    const h = makeHarness(recording);
    const launch = h.deps.launch!;
    h.deps.launch = async (options) => ({
      ...(await launch(options)),
      warning: 'Requested browser profile could not be used; continuing with a clean browser session.',
    });

    const result = await runAnalysis(h.options, h.deps).result;
    expect(result.warnings.some((w) => w.includes('profile'))).toBe(true);
    const progressMessages = ofType(h.events, 'progress').map((e) => e.message);
    expect(progressMessages.some((m) => m.includes('profile'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Real-browser smoke test (headless bundled chromium + real axe)
// ---------------------------------------------------------------------------

describe.skipIf(process.env.WAA_SKIP_BROWSER_TESTS === '1')('browser smoke (analyzer)', () => {
  it('analyzes a 2-action recording end-to-end with the stub provider', async () => {
    const pageHtml =
      '<!DOCTYPE html><html><head><title>Analyzer Smoke</title></head><body>' +
      '<h1>Demo</h1><img src="missing.png">' +
      '<button onclick="for(let i=0;i<4;i++){const d=document.createElement(\'div\');d.textContent=\'added \'+i;document.body.appendChild(d);}">Go</button>' +
      `<p>${'padding '.repeat(40)}</p></body></html>`;
    const dataUrl = `data:text/html,${encodeURIComponent(pageHtml)}`;
    const sessionDir = path.join(tempRoot, 'session_smoke');
    const recording = makeRecording(
      [
        act(1, 'navigate', { url: dataUrl }),
        act(2, 'click', {
          target: { candidates: [{ strategy: 'role', role: 'button', name: 'Go' }] },
        }),
      ],
      { sessionId: 'session_smoke', url: dataUrl },
    );
    const events: AnalyzeEvent[] = [];

    const control = runAnalysis({
      sessionId: 'session_smoke',
      sessionDir,
      recording,
      browserType: 'chromium',
      useProfile: false,
      headless: true,
      captureScreenshots: false,
      staticSectionMode: 'ignore',
      llmProvider: new StubProvider(),
      llmBatchTimeoutMs: 10_000,
      authConfig: AUTH_CONFIG,
      authPauseTimeoutMs: 60_000,
      onEvent: (event) => events.push(event),
    });
    const result = await control.result;

    expect(result.success).toBe(true);
    expect(result.snapshotCount).toBeGreaterThanOrEqual(1);
    // Real axe flagged the img without alt.
    expect(result.axeResults.map((v) => v.id)).toContain('image-alt');
    expect(result.analysis).toBeDefined();

    // Session files on disk.
    const paths = sessionPaths(path.dirname(sessionDir), path.basename(sessionDir));
    await expect(stat(paths.manifest)).resolves.toBeTruthy();
    await expect(stat(paths.analysis)).resolves.toBeTruthy();
    const step1 = paths.stepFiles(1);
    await expect(stat(step1.snapshot)).resolves.toBeTruthy();
    await expect(stat(step1.axeResults)).resolves.toBeTruthy();
    const analysisOnDisk = analysisResultSchema.parse(
      JSON.parse(await readFile(paths.analysis, 'utf8')),
    );
    expect(analysisOnDisk.axeResults.length).toBeGreaterThan(0);

    // Legacy phase progression observed.
    expectSubsequence(phasesOf(events), LEGACY_PHASE_PROGRESSION);
  }, 60_000);
});
