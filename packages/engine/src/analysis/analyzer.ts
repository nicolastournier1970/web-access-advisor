/**
 * Analysis orchestration: replay the recording against a live browser,
 * capture gated snapshots (HTML + axe + screenshot), pause for login at auth
 * checkpoints / login walls, run the hierarchical LLM analysis, and write
 * manifest.json + analysis.json. Rewrite of the legacy `analyzeActions`
 * (packages/core/src/analyzer.ts) keeping its onProgress phase vocabulary
 * ('replaying-actions' → 'capturing-snapshots' → 'running-accessibility-checks'
 * → 'processing-with-ai' → 'generating-report' → 'completed').
 *
 * New vs. legacy:
 *  - pause-for-login (docs/rewrite-plan.md §6): the replay PAUSES on recorded
 *    auth checkpoints (unless a validated storageState covers the session) and
 *    on live login walls; `continueAuth`/`cancelAuth` on the returned
 *    {@link AnalyzeControl} drive the {@link AuthCheckpointMachine};
 *  - per-action outcomes (executed | skipped | failed) reach the manifest;
 *  - the result promise NEVER rejects — every failure resolves to
 *    `success: false` with whatever partial manifest exists.
 *
 * Everything Playwright-facing is expressed against structural interfaces and
 * the injectable {@link AnalyzerDeps}, so the full orchestration is
 * unit-testable with fake pages/contexts (recorder.ts pattern).
 */
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  analysisResultSchema,
  type AnalysisPhase,
  type AnalysisResult,
  type LlmAnalysis,
  type ReplayAuthState,
  type SessionManifest,
} from '@waa/shared';
import type { AnalyzeControl, AnalyzeEvent, AnalyzeOptions } from '../engine-types.js';
import { detectLoginWall, isAuthUrl, type LoginWallResult } from '../auth/login-detection.js';
import { detectBrowsers } from '../browsers/detect.js';
import { AuthCheckpointMachine, type AuthPauseReason } from '../replay/auth-checkpoint.js';
import {
  executeAction,
  settle,
  type ActionOutcome,
  type ReplayPageActions,
  type SettleOptions,
} from '../replay/replayer.js';
import { DomChangeDetector, decideSnapshot, type DomChangeDetails } from '../snapshot/dom-change-detector.js';
import { capturePageState, captureSnapshot, type SnapshotPage } from '../snapshot/snapshotter.js';
import { sessionPaths, type SessionPaths } from '../storage/session-files.js';
import { getStorageStateStatus, validateStorageState } from '../storage/storage-state.js';
import { createBatches, groupSnapshotsForAnalysis, runLlmAnalysis } from './batching.js';
import {
  buildManifest,
  consolidateAxeViolations,
  type ActionOutcomeRecord,
  type AnalyzerSnapshot,
} from './manifest-builder.js';

/** Interval between timeout polls while the replay is paused for login. */
const AUTH_TIMEOUT_POLL_MS = 1000;
/** In-page probe: is a password field still present? (login not finished) */
const PASSWORD_PROBE_SCRIPT = `!!document.querySelector('input[type="password"]')`;

const CHROMIUM_ARGS = ['--no-first-run', '--no-default-browser-check'];

// ---------------------------------------------------------------------------
// Structural views of Playwright objects + injectable deps (test seams)
// ---------------------------------------------------------------------------

/** The page surface the analyzer needs: replayable AND snapshottable. */
export type AnalyzerPage = ReplayPageActions & SnapshotPage;

export interface AnalyzerContextLike {
  storageState(options?: { path?: string }): Promise<unknown>;
  close(): Promise<unknown>;
}

export interface AnalyzerBrowserLike {
  close(): Promise<unknown>;
}

/** What a launcher hands back; `browser` is absent for persistent contexts. */
export interface AnalyzerLaunchResult {
  browser?: AnalyzerBrowserLike;
  context: AnalyzerContextLike;
  page: AnalyzerPage;
  /** Human-readable degradation note (e.g. profile fallback), surfaced as a warning. */
  warning?: string;
}

/** Injectable interval timer pair (fake clocks in tests). */
export interface AnalyzerTimers {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/** Injectable seams for tests; production callers pass nothing. */
export interface AnalyzerDeps {
  /** Replaces the default Playwright launch (fakes in unit tests). */
  launch?: (options: AnalyzeOptions) => Promise<AnalyzerLaunchResult>;
  /** Forwarded to captureSnapshot (fake axe in unit tests). */
  axeRunner?: (page: SnapshotPage) => Promise<{ violations: unknown[] }>;
  /** Epoch-ms clock for the auth-checkpoint machine (default Date.now). */
  clock?: () => number;
  /** Timer pair for the auth-pause timeout poll (default real setInterval). */
  timers?: AnalyzerTimers;
  /** Test seam: shrink settle()'s fixed per-action waits. */
  settleDelaysMs?: SettleOptions['delaysMs'];
  /** Test seam: snapshot capture retry delay (default 500ms). */
  snapshotRetryDelayMs?: number;
}

// ---------------------------------------------------------------------------
// Default Playwright launch
// ---------------------------------------------------------------------------

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Session paths derived from the options' absolute sessionDir. */
function pathsFor(options: AnalyzeOptions): SessionPaths {
  return sessionPaths(path.dirname(options.sessionDir), path.basename(options.sessionDir));
}

/** Profile directory for the requested browser via detectBrowsers; undefined = none. */
async function findProfilePath(options: AnalyzeOptions): Promise<string | undefined> {
  try {
    const browsers = await detectBrowsers();
    const match = browsers.find(
      (b) =>
        b.type === options.browserType &&
        b.available &&
        b.profileSupported &&
        b.profilePath !== undefined &&
        (options.browserName === undefined || b.name === options.browserName),
    );
    return match?.profilePath;
  } catch {
    return undefined;
  }
}

/**
 * Real launcher. Paths, in priority order:
 *  1. sessionDir storageState.json present → clean launch of the requested
 *     browser type + `newContext({ storageState })` (recorded login reused);
 *  2. `useProfile` with a detectable profile → persistent context (Edge/Chrome
 *     profiles run on the bundled chromium binary; firefox uses
 *     `firefox.launchPersistentContext`; webkit has none). A locked/unusable
 *     profile falls back to a clean launch WITH a warning;
 *  3. clean launch + fresh context.
 * Analysis defaults to headless (`options.headless ?? true`); pause-for-login
 * callers pass `headless: false` so the user can sign in. `playwright` is
 * imported lazily so unit tests with an injected launcher never load it.
 */
async function defaultLaunch(options: AnalyzeOptions): Promise<AnalyzerLaunchResult> {
  const playwright = await import('playwright');
  const headless = options.headless ?? true;
  const engine =
    options.browserType === 'firefox'
      ? playwright.firefox
      : options.browserType === 'webkit'
        ? playwright.webkit
        : playwright.chromium;
  const args = options.browserType === 'chromium' ? CHROMIUM_ARGS : [];
  const storageStatePath = pathsFor(options).storageState;

  if (await fileExists(storageStatePath)) {
    const browser = await engine.launch({ headless, args });
    const context = await browser.newContext({ storageState: storageStatePath });
    return { browser, context, page: await context.newPage() };
  }

  if (options.useProfile && options.browserType !== 'webkit') {
    const profilePath = await findProfilePath(options);
    if (profilePath !== undefined) {
      try {
        // Edge/Chrome profiles launch with the bundled chromium binary.
        const launcher =
          options.browserType === 'firefox' ? playwright.firefox : playwright.chromium;
        const context = await launcher.launchPersistentContext(profilePath, { headless, args });
        const page = context.pages()[0] ?? (await context.newPage());
        return { context, page };
      } catch {
        // Profile locked by a running browser, or unusable → clean fallback.
      }
    }
    const browser = await engine.launch({ headless, args });
    const context = await browser.newContext();
    return {
      browser,
      context,
      page: await context.newPage(),
      warning:
        'Requested browser profile could not be used; continuing with a clean browser session.',
    };
  }

  const browser = await engine.launch({ headless, args });
  const context = await browser.newContext();
  return { browser, context, page: await context.newPage() };
}

// ---------------------------------------------------------------------------
// runAnalysis
// ---------------------------------------------------------------------------

/**
 * Start an analysis run. Returns immediately with the {@link AnalyzeControl}
 * handle; the replay/AI pipeline runs in the background and `result` resolves
 * when it finishes (it NEVER rejects). While the replay is paused for login,
 * `continueAuth()` validates the live page and resumes on success;
 * `cancelAuth()` aborts the replay keeping partial snapshots (the manifest is
 * marked truncated). The optional `deps` parameter is a test-only seam.
 */
export function runAnalysis(options: AnalyzeOptions, deps: AnalyzerDeps = {}): AnalyzeControl {
  const run = new AnalysisRun(options, deps);
  return {
    continueAuth: () => run.continueAuth(),
    cancelAuth: () => run.cancelAuth(),
    result: run.result,
  };
}

type PauseResolution = 'resumed' | 'cancelled' | 'timed_out';

/** One analysis execution; owns the browser, the machine and the pause gate. */
class AnalysisRun {
  readonly result: Promise<AnalysisResult>;

  private readonly options: AnalyzeOptions;
  private readonly deps: AnalyzerDeps;
  private readonly paths: SessionPaths;
  private readonly machine: AuthCheckpointMachine;
  private readonly timers: AnalyzerTimers;
  private readonly warnings: string[] = [];

  private live: AnalyzerLaunchResult | null = null;
  private pauseGate: { resolve(resolution: PauseResolution): void } | null = null;
  private timerHandle: unknown = null;
  /** Set once up front (and again after a successful in-replay login). */
  private hasValidStorageState = false;
  private truncated = false;
  private truncationReason: string | undefined;

  constructor(options: AnalyzeOptions, deps: AnalyzerDeps) {
    this.options = options;
    this.deps = deps;
    this.paths = pathsFor(options);
    this.timers = deps.timers ?? {
      setInterval: (callback, ms) => setInterval(callback, ms),
      clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
    };
    this.machine = new AuthCheckpointMachine({
      checkpoints: options.recording.authCheckpoints ?? [],
      authPauseTimeoutMs: options.authPauseTimeoutMs,
      ...(deps.clock !== undefined ? { now: deps.clock } : {}),
      onTransition: (state) => this.emit({ type: 'auth-state', state }),
    });
    this.result = this.run();
  }

  // -- control surface ------------------------------------------------------

  /**
   * "I've logged in": validate the LIVE page (must be off any auth URL and
   * carry no password field), save fresh storageState, resume the replay from
   * the paused action. On failure the replay STAYS paused (`auth_required`)
   * and the timeout clock keeps running from the original pause.
   */
  async continueAuth(): Promise<{ ok: boolean; reason?: string }> {
    if (this.machine.state !== 'auth_required' || this.live === null) {
      return { ok: false, reason: 'not-paused' };
    }
    this.machine.beginValidation();
    this.emit({ type: 'auth-validating' });

    let failReason: string | null = null;
    try {
      const state = await capturePageState(this.live.page);
      const url = state.url !== '' ? state.url : this.safeUrl();
      const hasPassword = Boolean(await this.live.page.evaluate(PASSWORD_PROBE_SCRIPT));
      if (isAuthUrl(url, this.options.authConfig)) {
        failReason = 'still-on-auth-page';
      } else if (hasPassword) {
        failReason = 'password-field-still-present';
      }
    } catch (error) {
      failReason = `validation-probe-failed: ${describeError(error)}`;
    }

    // cancelAuth() may have won the race while the probe was in flight.
    // (machineState() re-reads the getter; TS would otherwise keep the
    // 'auth_required' narrowing from the guard at the top of this method.)
    if (this.machineState() !== 'validating') {
      return { ok: false, reason: `replay-${this.machineState()}` };
    }

    if (failReason !== null) {
      this.machine.validationFailed(failReason);
      this.emit({ type: 'auth-failed', reason: failReason });
      return { ok: false, reason: failReason };
    }

    let storageStateSaved = false;
    try {
      await this.live.context.storageState({ path: this.paths.storageState });
      storageStateSaved = true;
    } catch (error) {
      this.warnings.push(`Failed to save storage state after login: ${describeError(error)}`);
    }
    this.hasValidStorageState = true; // the live login covers the rest of the replay
    const { resumedAtStep } = this.machine.validationSucceeded();
    this.emit({ type: 'auth-resolved', resumedAtStep, storageStateSaved });
    this.pauseGate?.resolve('resumed');
    return { ok: true };
  }

  /** Abort a paused replay; partial snapshots are kept, manifest notes truncation. */
  async cancelAuth(): Promise<void> {
    if (this.pauseGate === null) return;
    const state = this.machine.state;
    if (state === 'auth_required' || state === 'validating') {
      this.machine.cancel();
    }
    this.pauseGate.resolve('cancelled');
  }

  // -- pipeline --------------------------------------------------------------

  /** Full pipeline; resolves (never rejects) with the AnalysisResult. */
  private async run(): Promise<AnalysisResult> {
    const snapshots: AnalyzerSnapshot[] = [];
    const outcomesByStep = new Map<number, ActionOutcomeRecord>();
    try {
      await mkdir(this.paths.root, { recursive: true });

      // Storage-state validation happens ONCE up front (never per checkpoint):
      // only worth a probe when a recorded checkpoint could consult it.
      if ((this.options.recording.authCheckpoints ?? []).length > 0) {
        const status = await getStorageStateStatus(this.paths.storageState);
        if (status.present) {
          const probe = await validateStorageState({
            storageStatePath: this.paths.storageState,
            probeUrl: this.options.recording.url,
            isAuthUrl: (url) => isAuthUrl(url, this.options.authConfig),
          });
          this.hasValidStorageState = probe.ok;
        }
      }

      this.live = await (this.deps.launch ?? defaultLaunch)(this.options);
      if (this.live.warning !== undefined) {
        this.warnings.push(this.live.warning);
        this.progress('replaying-actions', this.live.warning);
      }

      await this.replayLoop(snapshots, outcomesByStep);
      return await this.finish(snapshots, [...outcomesByStep.values()]);
    } catch (error) {
      return await this.failureResult(error, snapshots, [...outcomesByStep.values()]);
    } finally {
      this.stopTimeoutTimer();
      await this.closeAll();
    }
  }

  /**
   * Replay every recorded action in order. Pauses before an action whose step
   * has an unconsumed recorded checkpoint (unless a validated storageState
   * covers the session), and after navigations/failed actions that land on a
   * login wall; a pause resolved by login RETRIES the paused action. Snapshot
   * capture is gated by the DOM-change detector.
   */
  private async replayLoop(
    snapshots: AnalyzerSnapshot[],
    outcomesByStep: Map<number, ActionOutcomeRecord>,
  ): Promise<void> {
    const { actions } = this.options.recording;
    const totalSteps = actions.length;
    const detector = new DomChangeDetector();
    const page = this.live!.page;

    this.progress('replaying-actions', 'Replaying user actions in browser...', {
      currentStep: 0,
      totalSteps,
      snapshotCount: 0,
    });

    let i = 0;
    while (i < actions.length) {
      const action = actions[i]!;
      const step = action.step;

      // Recorded checkpoint due at this step → pause unless saved login covers it.
      const checkpoint = this.machine.checkpointDueAt(step);
      if (checkpoint !== undefined && !this.hasValidStorageState) {
        const resolution = await this.pauseForLogin('recorded-checkpoint', step, checkpoint.id);
        if (resolution !== 'resumed') return;
        continue; // checkpoint consumed — re-enter this step from the top
      }
      if (checkpoint !== undefined) {
        // Validated saved login covers the session: skip the pause but consume
        // the checkpoint so a retry of this step doesn't re-offer it.
        this.machine.consumeCheckpoint(checkpoint.id);
      }

      // Recorded auth-redirect navigations (the bounce INTO the login page)
      // must not be replayed when a saved login covers the upcoming
      // checkpoint: they would drive the authenticated browser back onto the
      // login page and the next real action would fail there (caught by the
      // Phase 6 fixture gate, journey C).
      if (action.type === 'navigate' && this.hasValidStorageState) {
        const covering = this.machine.pendingCheckpointCovering(step);
        const url = action.url ?? '';
        if (
          covering !== undefined &&
          (url === covering.loginUrl || isAuthUrl(url, this.options.authConfig))
        ) {
          outcomesByStep.set(step, {
            step,
            outcome: 'skipped',
            detail: 'auth-redirect-covered-by-saved-login',
          });
          i += 1;
          continue;
        }
      }

      this.progress('replaying-actions', `Replaying step ${step}: ${action.type}`, {
        currentStep: step,
        totalSteps,
        snapshotCount: snapshots.length,
      });

      const outcome = await executeAction(page, action);
      outcomesByStep.set(step, { step, ...outcome }); // last attempt wins (retries)

      // Login-wall check after navigations and failed actions.
      if (action.type === 'navigate' || outcome.outcome === 'failed') {
        const wall = await this.probeLoginWall(outcome);
        if (wall.isLoginWall && this.machine.state === 'running') {
          const resolution = await this.pauseForLogin(wall.reason!, step);
          if (resolution !== 'resumed') return;
          continue; // retry the same action, now authenticated
        }
      }

      await settle(page, action, {
        ...(this.deps.settleDelaysMs !== undefined ? { delaysMs: this.deps.settleDelaysMs } : {}),
      });

      let change: DomChangeDetails;
      try {
        change = detector.detectChanges(await capturePageState(page));
      } catch (error) {
        change = {
          type: 'none',
          significant: false,
          elementsAdded: 0,
          elementsRemoved: 0,
          urlChanged: false,
          titleChanged: false,
          description: `Page state capture failed: ${describeError(error)}`,
        };
      }

      const decision = decideSnapshot({
        action,
        actionIndex: i,
        allActions: actions,
        change,
        isFirstSnapshot: snapshots.length === 0,
      });
      if (decision.capture) {
        this.progress('capturing-snapshots', `Capturing snapshot ${snapshots.length + 1}`, {
          currentStep: step,
          totalSteps,
          snapshotCount: snapshots.length + 1,
        });
        try {
          const record = await captureSnapshot({
            page,
            step,
            paths: this.paths,
            captureScreenshot: this.options.captureScreenshots,
            ...(this.deps.axeRunner !== undefined ? { axeRunner: this.deps.axeRunner } : {}),
            ...(this.deps.snapshotRetryDelayMs !== undefined
              ? { retryDelayMs: this.deps.snapshotRetryDelayMs }
              : {}),
          });
          snapshots.push({ ...record, change, capturedAt: new Date().toISOString() });
          this.progress(
            'running-accessibility-checks',
            `Automated accessibility checks completed for step ${step}`,
            { currentStep: step, totalSteps, snapshotCount: snapshots.length },
          );
        } catch (error) {
          this.warnings.push(`Snapshot capture failed at step ${step}: ${describeError(error)}`);
        }
      }
      i++;
    }
  }

  /** AI batching + report generation + persistence (success path). */
  private async finish(
    snapshots: AnalyzerSnapshot[],
    outcomes: ActionOutcomeRecord[],
  ): Promise<AnalysisResult> {
    const { options } = this;
    if (options.recording.actions.length === 0) {
      this.warnings.push('No actions were recorded - analysis skipped');
    }
    const manifest = this.buildManifestSafe(snapshots, outcomes);

    let analysis: LlmAnalysis | undefined;
    if (options.llmProvider !== null && snapshots.length > 0) {
      this.progress('processing-with-ai', `Analyzing ${snapshots.length} snapshots with AI...`, {
        snapshotCount: snapshots.length,
      });
      try {
        const grouped = groupSnapshotsForAnalysis(snapshots, manifest.stepDetails);
        const batches = createBatches(grouped);
        analysis = await runLlmAnalysis({
          batches,
          provider: options.llmProvider,
          sessionUrl: options.recording.url,
          staticSectionMode: options.staticSectionMode,
          timeoutMs: options.llmBatchTimeoutMs,
          onBatch: (batchCurrent, batchTotal, flowType) =>
            this.progress(
              'processing-with-ai',
              `Analyzing batch ${batchCurrent}/${batchTotal}: ${flowType}`,
              { batchCurrent, batchTotal, snapshotCount: snapshots.length },
            ),
        });
      } catch (error) {
        this.warnings.push(`AI analysis failed: ${describeError(error)}`);
      }
    }

    this.progress('generating-report', 'Generating final accessibility report...', {
      snapshotCount: snapshots.length,
    });
    const axeResults = consolidateAxeViolations(snapshots, analysis);
    await writeFile(this.paths.manifest, JSON.stringify(manifest, null, 2), 'utf8');

    const result = analysisResultSchema.parse({
      success: true,
      sessionId: options.sessionId,
      snapshotCount: snapshots.length,
      manifest,
      ...(analysis !== undefined ? { analysis } : {}),
      axeResults,
      warnings: this.warnings,
      completedAt: new Date().toISOString(),
      ...(options.llmProvider !== null ? { llmProvider: options.llmProvider.name } : {}),
    });
    await writeFile(this.paths.analysis, JSON.stringify(result, null, 2), 'utf8');

    this.progress('completed', 'Analysis complete', { snapshotCount: snapshots.length });
    return result;
  }

  /** The result promise never rejects: wrap any error into success:false. */
  private async failureResult(
    error: unknown,
    snapshots: AnalyzerSnapshot[],
    outcomes: ActionOutcomeRecord[],
  ): Promise<AnalysisResult> {
    const message = describeError(error);
    this.truncated = true;
    this.truncationReason = this.truncationReason ?? `Analysis failed: ${message}`;
    const manifest = this.buildManifestSafe(snapshots, outcomes);
    const result = analysisResultSchema.parse({
      success: false,
      sessionId: this.options.sessionId,
      snapshotCount: snapshots.length,
      manifest,
      axeResults: safeConsolidate(snapshots),
      warnings: this.warnings,
      error: message,
      completedAt: new Date().toISOString(),
      ...(this.options.llmProvider !== null ? { llmProvider: this.options.llmProvider.name } : {}),
    });
    try {
      await writeFile(this.paths.manifest, JSON.stringify(manifest, null, 2), 'utf8');
      await writeFile(this.paths.analysis, JSON.stringify(result, null, 2), 'utf8');
    } catch {
      // Persistence is best-effort on the failure path.
    }
    this.progress('completed', `Analysis failed: ${message}`, { snapshotCount: snapshots.length });
    return result;
  }

  /** buildManifest that degrades to a minimal manifest instead of throwing. */
  private buildManifestSafe(
    snapshots: AnalyzerSnapshot[],
    outcomes: ActionOutcomeRecord[],
  ): SessionManifest {
    try {
      return buildManifest({
        recording: this.options.recording,
        snapshots,
        outcomes,
        sessionUrl: this.options.recording.url,
        authConfig: this.options.authConfig,
        ...(this.truncated ? { truncated: true } : {}),
        ...(this.truncationReason !== undefined ? { truncationReason: this.truncationReason } : {}),
      });
    } catch {
      return {
        sessionId: this.options.sessionId,
        url: this.options.recording.url,
        timestamp: new Date().toISOString(),
        totalSteps: snapshots.length,
        stepDetails: [],
        ...(this.truncated ? { truncated: true } : {}),
        ...(this.truncationReason !== undefined ? { truncationReason: this.truncationReason } : {}),
      };
    }
  }

  // -- pause mechanics --------------------------------------------------------

  /**
   * Pause the replay for login: drive the machine, emit `auth-required`
   * (loginUrl = live page URL), start the timeout poll, and block until
   * continueAuth / cancelAuth / timeout resolves the gate. Cancel and timeout
   * mark the run truncated; the caller aborts the loop.
   */
  private async pauseForLogin(
    reason: AuthPauseReason,
    pausedAtStep: number,
    checkpointId?: string,
  ): Promise<PauseResolution> {
    const loginUrl = this.safeUrl();
    const { timeoutAt } = this.machine.pause({
      reason,
      loginUrl,
      pausedAtStep,
      ...(checkpointId !== undefined ? { checkpointId } : {}),
    });
    this.emit({
      type: 'auth-required',
      reason,
      loginUrl,
      pausedAtStep,
      timeoutAt,
      ...(checkpointId !== undefined ? { checkpointId } : {}),
    });
    this.startTimeoutTimer();

    const resolution = await new Promise<PauseResolution>((resolve) => {
      this.pauseGate = { resolve };
    });
    this.pauseGate = null;
    this.stopTimeoutTimer();

    if (resolution === 'cancelled') {
      this.truncated = true;
      this.truncationReason = `Replay cancelled while paused for login at step ${pausedAtStep}`;
      this.warnings.push(this.truncationReason);
    } else if (resolution === 'timed_out') {
      this.truncated = true;
      this.truncationReason = `Login was not completed within ${this.options.authPauseTimeoutMs}ms (paused at step ${pausedAtStep})`;
      this.warnings.push(this.truncationReason);
    }
    return resolution;
  }

  /** Poll machine.expireIfTimedOut(); timeout resolves the gate like a cancel. */
  private startTimeoutTimer(): void {
    this.stopTimeoutTimer();
    this.timerHandle = this.timers.setInterval(() => {
      if (this.machine.expireIfTimedOut()) {
        // auth-state 'timed_out' already emitted via the machine transition.
        this.pauseGate?.resolve('timed_out');
      }
    }, AUTH_TIMEOUT_POLL_MS);
  }

  private stopTimeoutTimer(): void {
    if (this.timerHandle !== null) {
      this.timers.clearInterval(this.timerHandle);
      this.timerHandle = null;
    }
  }

  /** Observe the live page and decide whether replay hit a login wall. */
  private async probeLoginWall(outcome: ActionOutcome): Promise<LoginWallResult> {
    try {
      const page = this.live!.page;
      const state = await capturePageState(page);
      const hasPasswordField = Boolean(await page.evaluate(PASSWORD_PROBE_SCRIPT));
      const targetResolutionFailed =
        outcome.outcome === 'failed'
          ? true
          : outcome.resolvedBy !== undefined
            ? false
            : undefined;
      return detectLoginWall(
        {
          url: state.url !== '' ? state.url : this.safeUrl(),
          hasPasswordField,
          ...(targetResolutionFailed !== undefined ? { targetResolutionFailed } : {}),
        },
        this.options.authConfig,
      );
    } catch {
      return { isLoginWall: false };
    }
  }

  // -- plumbing ---------------------------------------------------------------

  /** onEvent is consumer code — it must never break the analysis. */
  private emit(event: AnalyzeEvent): void {
    try {
      this.options.onEvent(event);
    } catch {
      /* ignore consumer errors */
    }
  }

  private progress(
    phase: AnalysisPhase,
    message: string,
    extra: {
      currentStep?: number;
      totalSteps?: number;
      snapshotCount?: number;
      batchCurrent?: number;
      batchTotal?: number;
    } = {},
  ): void {
    this.emit({ type: 'progress', phase, message, ...extra });
  }

  /** Widened read of the machine state (defeats getter narrowing). */
  private machineState(): ReplayAuthState {
    return this.machine.state;
  }

  private safeUrl(): string {
    try {
      return this.live?.page.url() ?? '';
    } catch {
      return '';
    }
  }

  /** Close page context browser, always, best-effort each. */
  private async closeAll(): Promise<void> {
    if (this.live === null) return;
    const { context, browser } = this.live;
    this.live = null;
    try {
      await context.close();
    } catch {
      /* already closed */
    }
    if (browser !== undefined) {
      try {
        await browser.close();
      } catch {
        /* already closed */
      }
    }
  }
}

/** Compact error text (bounded, never throws). */
function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 300 ? `${message.slice(0, 297)}...` : message;
}

/** consolidateAxeViolations that cannot throw (failure path). */
function safeConsolidate(snapshots: AnalyzerSnapshot[]): unknown[] {
  try {
    return consolidateAxeViolations(snapshots);
  } catch {
    return [];
  }
}
