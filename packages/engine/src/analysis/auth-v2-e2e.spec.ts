/**
 * Phase 6 gate (docs/rewrite-plan.md): the full auth-v2 journey against the
 * fixture login site with REAL headless Chromium.
 *
 *  A — recording with a marked login segment: credentials never persist,
 *      storageState (the waa_session cookie) is saved at segment end.
 *  B — replay without saved login pauses at the recorded checkpoint, rejects
 *      a premature continue, resumes after a real sign-in, saves fresh state.
 *  C — replay WITH the saved login never pauses.
 *
 * The fixture site (e2e/fixtures/site) is served by the spec itself on :4310.
 * Note /login.html deliberately does NOT match the '/login' path pattern
 * (segment-aware matching), so login-wall detection here exercises the
 * checkpoint path and the password+failed-target fallback, not URL matching.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, copyFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';
import { DEFAULT_AUTH_DOMAINS_CONFIG } from '../auth/domain-config.js';
import { createRecorder } from '../recording/recorder.js';
import { runAnalysis } from './analyzer.js';
import { sessionPaths } from '../storage/session-files.js';
import type { AnalyzeEvent, RecorderEvent } from '../engine-types.js';
import type { RecordingV2 } from '@waa/shared';

const here = path.dirname(fileURLToPath(new URL(import.meta.url)));
const repoRoot = path.resolve(here, '../../../..');
const FIXTURE_PORT = 4310;
const BASE = `http://127.0.0.1:${FIXTURE_PORT}`;

async function until(probe: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('until(): condition not met in time');
}

/** Sign in on the fixture login page via a held page reference. */
async function signIn(page: Page): Promise<void> {
  await page.fill('[data-testid="username-input"]', 'tester');
  await page.fill('[data-testid="password-input"]', 'letmein');
  await page.click('[data-testid="login-submit"]');
  await page.waitForURL(/protected\.html/, { timeout: 10_000 });
}

describe.skipIf(process.env.WAA_SKIP_BROWSER_TESTS === '1')('auth-v2 gate (fixture site)', () => {
  let server: ChildProcess;
  let tempRoot: string;
  let recording: RecordingV2;
  let storageStateFromB: string;

  beforeAll(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'waa-auth-gate-'));
    server = spawn(process.execPath, [path.join(repoRoot, 'e2e/fixtures/serve.mjs'), String(FIXTURE_PORT)], {
      stdio: 'ignore',
    });
    await until(async () => {
      try {
        const res = await fetch(`${BASE}/index.html`);
        return res.ok;
      } catch {
        return false;
      }
    }, 20_000);
  }, 30_000);

  afterAll(() => {
    server?.kill();
  });

  it('A: records a login segment — credentials never persist, storageState saved at segment end', async () => {
    const { chromium } = await import('playwright');
    const sessionDir = path.join(tempRoot, 'session_record');
    const events: RecorderEvent[] = [];
    let page!: Page;

    const handle = await createRecorder(
      {
        sessionId: 'session_record',
        url: `${BASE}/protected.html`,
        browserType: 'chromium',
        useProfile: false,
        headless: true,
        sessionDir,
        authConfig: DEFAULT_AUTH_DOMAINS_CONFIG,
        onEvent: (e) => events.push(e),
      },
      {
        launch: async () => {
          const browser = await chromium.launch({ headless: true });
          const context = await browser.newContext();
          page = (await context.newPage()) as Page;
          return { browser, context, page };
        },
      },
    );

    // Bounced to the login wall.
    await page.waitForURL(/login\.html/, { timeout: 10_000 });
    await until(() => handle.getActions().filter((a) => a.type === 'navigate').length >= 1);

    // Focusing the password field fires the auto-detect assist.
    await page.focus('[data-testid="password-input"]');
    await until(() =>
      events.some((e) => e.type === 'auth-suspected' && e.reason === 'password-field'),
    );

    // Marked login segment: everything typed in here is discarded.
    const segment = await handle.startAuthSegment('user-marked');
    expect(segment.checkpoint.reason).toBe('user-marked');
    await signIn(page);
    const ended = await handle.endAuthSegment();
    expect(ended.storageStateSaved).toBe(true);
    expect(ended.postLoginUrl).toContain('protected.html');

    // storageState.json exists and carries the fixture session cookie (name only).
    const paths = sessionPaths(tempRoot, 'session_record');
    const storageState = JSON.parse(await readFile(paths.storageState, 'utf-8')) as {
      cookies: Array<{ name: string }>;
    };
    expect(storageState.cookies.map((c) => c.name)).toContain('waa_session');

    // A post-login interaction IS recorded, with target candidates.
    const before = handle.getActions().length;
    await page.click('[data-testid="nav-form"]');
    await until(() => handle.getActions().length > before);

    recording = await handle.stop();

    // The headline security assertion: credentials appear NOWHERE.
    const persisted = await readFile(paths.recording, 'utf-8');
    expect(persisted).not.toContain('letmein');
    expect(persisted).not.toContain('tester');
    expect(JSON.stringify(recording.actions)).not.toContain('letmein');

    expect(recording.authCheckpoints).toHaveLength(1);
    expect(recording.authCheckpoints[0]!.storageStateSaved).toBe(true);
    const click = recording.actions.find((a) => a.type === 'click');
    expect(click?.target?.candidates.length).toBeGreaterThan(0);
    // Only pre-segment navigations + post-segment interactions persist.
    expect(recording.actions.every((a) => a.type === 'navigate' || a.type === 'click')).toBe(true);
  }, 90_000);

  it('B: replay without saved login pauses at the checkpoint, rejects premature continue, resumes after sign-in', async () => {
    const { chromium } = await import('playwright');
    const sessionDir = path.join(tempRoot, 'session_replay');
    await mkdir(sessionDir, { recursive: true });
    const events: AnalyzeEvent[] = [];
    let page!: Page;

    const control = runAnalysis(
      {
        sessionId: 'session_replay',
        sessionDir,
        recording,
        browserType: 'chromium',
        useProfile: false,
        headless: true,
        captureScreenshots: false,
        staticSectionMode: 'ignore',
        llmProvider: null,
        llmBatchTimeoutMs: 1_000,
        authConfig: DEFAULT_AUTH_DOMAINS_CONFIG,
        authPauseTimeoutMs: 60_000,
        onEvent: (e) => events.push(e),
      },
      {
        launch: async () => {
          const browser = await chromium.launch({ headless: true });
          const context = await browser.newContext();
          page = (await context.newPage()) as Page;
          return { browser, context, page };
        },
        settleDelaysMs: { navigate: 100, click: 100, default: 50 },
        snapshotRetryDelayMs: 50,
      },
    );

    // Pause fires at the recorded checkpoint, before the first post-login action.
    await until(() => events.some((e) => e.type === 'auth-required'), 30_000);
    const required = events.find((e) => e.type === 'auth-required')!;
    expect(required.reason).toBe('recorded-checkpoint');
    expect(required.loginUrl).toContain('login.html');
    const checkpointStep = recording.authCheckpoints[0]!.afterStep;
    expect(required.pausedAtStep).toBeGreaterThan(checkpointStep);

    // Premature continue: still on the login page → rejected, stays paused.
    const premature = await control.continueAuth();
    expect(premature.ok).toBe(false);
    expect(events.some((e) => e.type === 'auth-failed')).toBe(true);

    // Real sign-in in the held (engine-owned) page, then continue.
    await signIn(page);
    const resumed = await control.continueAuth();
    expect(resumed.ok).toBe(true);
    await until(() => events.some((e) => e.type === 'auth-resolved'));
    const resolved = events.find((e) => e.type === 'auth-resolved')!;
    expect(resolved.storageStateSaved).toBe(true);

    const result = await control.result;
    expect(result.success).toBe(true);
    expect(result.manifest.truncated).toBeUndefined();
    // The replay reached authenticated content.
    const urls = result.manifest.stepDetails.map((s) => s.url).join(' ');
    expect(urls).toMatch(/protected\.html|form\.html/);
    // Fresh login state persisted for cross-session reuse (journey C).
    storageStateFromB = sessionPaths(tempRoot, 'session_replay').storageState;
    expect(existsSync(storageStateFromB)).toBe(true);
  }, 120_000);

  it('C: replay WITH the saved login never pauses', async () => {
    const { chromium } = await import('playwright');
    const sessionDir = path.join(tempRoot, 'session_reuse');
    await mkdir(sessionDir, { recursive: true });
    const paths = sessionPaths(tempRoot, 'session_reuse');
    await copyFile(storageStateFromB, paths.storageState);
    const events: AnalyzeEvent[] = [];

    const control = runAnalysis(
      {
        sessionId: 'session_reuse',
        sessionDir,
        recording,
        browserType: 'chromium',
        useProfile: false,
        headless: true,
        captureScreenshots: false,
        staticSectionMode: 'ignore',
        llmProvider: null,
        llmBatchTimeoutMs: 1_000,
        authConfig: DEFAULT_AUTH_DOMAINS_CONFIG,
        authPauseTimeoutMs: 60_000,
        onEvent: (e) => events.push(e),
      },
      {
        // Mirror the default launch's storageState seeding with a held browser.
        launch: async () => {
          const browser = await chromium.launch({ headless: true });
          const context = await browser.newContext({ storageState: paths.storageState });
          const page = (await context.newPage()) as Page;
          return { browser, context, page };
        },
        settleDelaysMs: { navigate: 100, click: 100, default: 50 },
        snapshotRetryDelayMs: 50,
      },
    );

    const result = await control.result;
    expect(result.success).toBe(true);
    expect(events.some((e) => e.type === 'auth-required')).toBe(false);
    const urls = result.manifest.stepDetails.map((s) => s.url).join(' ');
    expect(urls).toMatch(/protected\.html|form\.html/);
  }, 120_000);
});
