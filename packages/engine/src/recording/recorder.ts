/**
 * Live recording session: launches a (normally headed) Playwright browser,
 * injects the in-page capture script, and turns bridge payloads into
 * RecordingV2 actions via {@link RecorderState}.
 *
 * v2 fixes over the legacy recordingService:
 *  - no `--disable-web-security` anywhere;
 *  - `browserType` is respected on every launch path (legacy hardcoded
 *    chromium for storage-state reuse);
 *  - the initial navigation is recorded exactly once (via `framenavigated`,
 *    never as an additional manual action);
 *  - sensitive input values arrive already redacted from the page, and a
 *    recorder-side backstop re-redacts any password-typed fill;
 *  - launch degradations (profile unusable, saved login unreadable) are NEVER
 *    silent: the recording proceeds on a clean browser but a `warning` event
 *    is emitted so the UI can tell the user their logins are absent;
 *  - capture bridges + init script are wired at CONTEXT level, and every page
 *    the context opens (popups, target=_blank tabs — SSO flows live there) is
 *    wired for main-frame navigation recording. Popups contribute actions and
 *    navigations to the recording, but `currentUrl()` keeps reporting the
 *    ORIGINAL page's URL (the UI's current-url display contract), and closing
 *    a popup never ends the session — only closing the whole browser/context
 *    does.
 *
 * Everything Playwright-facing is expressed against the narrow *Like
 * interfaces below and the injectable `launch` dep, so the wiring is
 * unit-testable with fake page/context objects.
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { REDACTED_VALUE, type TargetCandidate } from '@waa/shared';
import type {
  EndAuthSegmentResult,
  RecorderEvent,
  RecorderHandle,
  RecorderOptions,
  StartAuthSegmentResult,
} from '../engine-types.js';
import { isAuthUrl } from '../auth/login-detection.js';
import { detectBrowsers } from '../browsers/detect.js';
import { saveRecording } from '../storage/recording-format.js';
import { readStorageStateFile, writeStorageStateFile } from '../storage/secure-storage-state.js';
import { sessionPaths } from '../storage/session-files.js';
import { buildRecorderScript } from './injected/recorder-script.js';
import { RecorderState } from './recorder-state.js';
import { describeTarget, sanitizeCandidates } from './selector-engine.js';

/** Hard cap on a recorded fill/select/key value (a page could blur a huge textarea). */
const MAX_VALUE_LENGTH = 1_000;

// ---------------------------------------------------------------------------
// Narrow structural views of Playwright objects (real Page/BrowserContext
// satisfy these; tests supply fakes so no browser is needed for wiring tests).
// ---------------------------------------------------------------------------

export interface RecorderFrameLike {
  url(): string;
}

export interface RecorderPageLike {
  url(): string;
  isClosed(): boolean;
  goto(url: string): Promise<unknown>;
  bringToFront(): Promise<unknown>;
  close(): Promise<unknown>;
  on(event: 'framenavigated', handler: (frame: RecorderFrameLike) => void): unknown;
  on(event: 'close', handler: () => void): unknown;
  mainFrame(): RecorderFrameLike;
}

export interface RecorderContextLike {
  /** Returns the live storage state OBJECT; the recorder encrypts it to disk itself. */
  storageState(): Promise<unknown>;
  /** Context-level bridge: available on every page the context opens (incl. popups). */
  exposeFunction(name: string, callback: (payload: unknown) => unknown): Promise<unknown>;
  /** Context-level init script: evaluated in every page/navigation (incl. popups). */
  addInitScript(script: string): Promise<unknown>;
  close(): Promise<unknown>;
  on(event: 'close', handler: () => void): unknown;
  /** Fired for pages opened after subscription (popups, target=_blank tabs). */
  on(event: 'page', handler: (page: RecorderPageLike) => void): unknown;
}

export interface RecorderBrowserLike {
  close(): Promise<unknown>;
}

/** A launch degradation the user must learn about (mirrors RecorderEvent 'warning'). */
export interface RecorderWarning {
  message: string;
  reason: 'profile-unavailable' | 'storage-state-unavailable';
}

/** What a launcher must hand back; `browser` is absent for persistent contexts. */
export interface RecorderLaunchResult {
  browser?: RecorderBrowserLike;
  context: RecorderContextLike;
  page: RecorderPageLike;
  /** Degradations to surface as 'warning' events (the recording proceeds). */
  warnings?: RecorderWarning[];
}

/** Injectable seams for tests; production callers pass nothing. */
export interface RecorderDeps {
  /** Replaces the default Playwright launch (fakes in unit tests). */
  launch?: (options: RecorderOptions) => Promise<RecorderLaunchResult>;
  /** Time source forwarded to {@link RecorderState}. */
  clock?: () => Date;
}

// ---------------------------------------------------------------------------
// Bridge payload handling (untrusted input from the recorded page)
// ---------------------------------------------------------------------------

interface RecordPayload {
  kind: 'click' | 'fill' | 'select' | 'key';
  candidates: unknown;
  tag: string | undefined;
  inputType: string | undefined;
  text: string | undefined;
  value: string | undefined;
  redacted: boolean;
}

/** Defensive parse of a `__waaRecord` payload; null drops the event. */
function parseRecordPayload(raw: unknown): RecordPayload | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const kind = r['kind'];
  if (kind !== 'click' && kind !== 'fill' && kind !== 'select' && kind !== 'key') return null;
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length > 0 ? v.slice(0, 200) : undefined;
  return {
    kind,
    candidates: r['candidates'],
    tag: str(r['tag']),
    inputType: str(r['inputType']),
    text: str(r['text']),
    value: typeof r['value'] === 'string' ? r['value'].slice(0, MAX_VALUE_LENGTH) : undefined,
    redacted: r['redacted'] === true,
  };
}

/** Legacy single-selector mirror: id → css → nth-path (undefined when none). */
function legacySelector(candidates: TargetCandidate[]): string | undefined {
  let css: string | undefined;
  let nthPath: string | undefined;
  for (const candidate of candidates) {
    if (candidate.strategy === 'id') return `#${candidate.value}`;
    if (candidate.strategy === 'css' && css === undefined) css = candidate.value;
    if (candidate.strategy === 'nth-path' && nthPath === undefined) nthPath = candidate.value;
  }
  return css ?? nthPath;
}

// ---------------------------------------------------------------------------
// Default Playwright launch
// ---------------------------------------------------------------------------

const CHROMIUM_ARGS = ['--no-first-run', '--no-default-browser-check'];

/** Degradation wording — kept aligned with the analyzer's launch warnings. */
const PROFILE_WARNING =
  'Requested browser profile could not be used; continuing with a clean browser session.';

/**
 * Real launcher. Paths, in priority order:
 *  1. `reuseStorageStatePath` → clean launch of the REQUESTED browser type +
 *     `newContext({ storageState })`. An unreadable/undecryptable file (e.g.
 *     copied from another machine/user) does NOT abort the recording: it falls
 *     through to the profile/clean paths carrying a `storage-state-unavailable`
 *     warning (same behaviour and wording as the analyzer's launch).
 *  2. `useProfile` with a detectable profile → persistent context. Edge/Chrome
 *     profiles run on the bundled chromium binary (legacy-proven combination);
 *     firefox uses `firefox.launchPersistentContext`. A missing/locked/broken
 *     profile — and webkit, which has no persistent contexts — falls through
 *     to a clean launch carrying a `profile-unavailable` warning.
 *  3. Clean launch + fresh context.
 * Degradations are never silent: every fallback is reported via the returned
 * `warnings`, which {@link createRecorder} emits as 'warning' events.
 * Headed chromium gets `viewport: null` + `--start-maximized` for natural
 * window sizing. `playwright` is imported lazily so unit tests with an
 * injected launcher never load the browser driver.
 */
async function defaultLaunch(options: RecorderOptions): Promise<RecorderLaunchResult> {
  const playwright = await import('playwright');
  const headless = options.headless ?? false;
  const engine =
    options.browserType === 'firefox'
      ? playwright.firefox
      : options.browserType === 'webkit'
        ? playwright.webkit
        : playwright.chromium;
  const args =
    options.browserType === 'chromium'
      ? headless
        ? CHROMIUM_ARGS
        : [...CHROMIUM_ARGS, '--start-maximized']
      : [];
  // System-Chromium channel (packaged app); undefined = bundled binary (dev).
  const channel = options.browserType === 'chromium' ? options.browserChannel : undefined;
  const launchOpts = { headless, args, ...(channel !== undefined ? { channel } : {}) };
  const viewportOption = headless ? {} : { viewport: null };
  const warnings: RecorderWarning[] = [];

  if (options.reuseStorageStatePath !== undefined) {
    // Decrypt (or legacy-plaintext read) and seed the context with the OBJECT
    // form. A read failure degrades (with a warning) instead of aborting — the
    // user still gets their recording, just without the saved login.
    let storageState: Awaited<ReturnType<typeof readStorageStateFile>> | undefined;
    try {
      storageState = await readStorageStateFile(options.reuseStorageStatePath);
    } catch (error) {
      warnings.push({
        reason: 'storage-state-unavailable',
        message: `Saved login could not be loaded (${describeError(error)}); continuing without it.`,
      });
    }
    if (storageState !== undefined) {
      const browser = await engine.launch(launchOpts);
      const context = await browser.newContext({
        storageState,
        ...viewportOption,
      });
      return { browser, context, page: await context.newPage() };
    }
  }

  if (options.useProfile) {
    // webkit has no persistent contexts — profile requested but unusable.
    const profilePath =
      options.browserType !== 'webkit' ? await findProfilePath(options) : undefined;
    if (profilePath !== undefined) {
      try {
        // Edge/Chrome profiles launch with the bundled chromium binary.
        const launcher =
          options.browserType === 'firefox' ? playwright.firefox : playwright.chromium;
        const context = await launcher.launchPersistentContext(profilePath, {
          ...launchOpts,
          ...viewportOption,
        });
        const page = context.pages()[0] ?? (await context.newPage());
        return { context, page, warnings };
      } catch {
        // Profile locked by a running browser, or unusable → clean fallback.
      }
    }
    warnings.push({ reason: 'profile-unavailable', message: PROFILE_WARNING });
  }

  const browser = await engine.launch(launchOpts);
  const context = await browser.newContext(viewportOption);
  return { browser, context, page: await context.newPage(), warnings };
}

/** Compact error text (bounded, never throws). */
function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 300 ? `${message.slice(0, 297)}...` : message;
}

/** Profile directory for the requested browser via detectBrowsers; undefined = none. */
async function findProfilePath(options: RecorderOptions): Promise<string | undefined> {
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

// ---------------------------------------------------------------------------
// createRecorder
// ---------------------------------------------------------------------------

/**
 * Launch the recording browser, wire the capture bridges, navigate to
 * `options.url` and return the live {@link RecorderHandle}. The initial
 * navigation is recorded as step 1 by the `framenavigated` listener — no
 * manual navigate action is pushed. Bridges + init script are installed at
 * CONTEXT level and `context.on('page')` wires every later page (popups /
 * target=_blank tabs), so popup interactions and navigations are recorded
 * too; `currentUrl()` still reports the ORIGINAL page's URL and closing a
 * popup never emits `closed`. Launch degradations arrive as 'warning' events
 * before the first navigation. Fails (and closes the browser) if the initial
 * wiring or navigation fails. The optional `deps` parameter is a test-only
 * seam.
 */
export async function createRecorder(
  options: RecorderOptions,
  deps: RecorderDeps = {},
): Promise<RecorderHandle> {
  const paths = sessionPaths(path.dirname(options.sessionDir), path.basename(options.sessionDir));
  await mkdir(paths.root, { recursive: true });

  const state = new RecorderState(deps.clock);
  const { browser, context, page, warnings = [] } = await (deps.launch ?? defaultLaunch)(options);

  let stopping = false;
  let stoppedRecording: ReturnType<RecorderState['toRecording']> | null = null;
  let lastSuspectKey = '';

  /** onEvent is consumer code — it must never break the recorder. */
  const emit = (event: RecorderEvent): void => {
    try {
      options.onEvent(event);
    } catch {
      /* ignore consumer errors */
    }
  };

  const safeUrl = (): string | null => {
    try {
      return page.isClosed() ? null : page.url();
    } catch {
      return null;
    }
  };

  /** Deduped (per reason+url) and muted while a segment is already open. */
  const emitAuthSuspected = (
    reason: 'auth-domain-navigation' | 'password-field',
    url: string,
  ): void => {
    if (state.isSegmentActive) return;
    const key = `${reason}|${url}`;
    if (key === lastSuspectKey) return;
    lastSuspectKey = key;
    emit({ type: 'auth-suspected', reason, url, suspectedAtStep: state.lastStep });
  };

  const handleRecord = (raw: unknown): void => {
    const payload = parseRecordPayload(raw);
    if (payload === null) return;
    const candidates = sanitizeCandidates(payload.candidates);
    // Backstop: a password-typed fill is redacted even if the in-page script
    // somehow failed to do so. The value from the bridge is then discarded.
    const redacted =
      payload.redacted ||
      (payload.kind === 'fill' && payload.inputType?.toLowerCase() === 'password');
    const value =
      payload.kind === 'fill' && redacted
        ? REDACTED_VALUE
        : payload.kind === 'click'
          ? undefined
          : payload.value;
    const metadata: Record<string, unknown> = {};
    if (payload.tag !== undefined) metadata['tag'] = payload.tag;
    if (payload.inputType !== undefined) metadata['inputType'] = payload.inputType;
    if (payload.text !== undefined) metadata['text'] = payload.text;
    const selector = legacySelector(candidates);
    const action = state.addAction({
      type: payload.kind,
      ...(candidates.length > 0
        ? { target: { candidates, description: describeTarget(candidates) } }
        : {}),
      ...(selector !== undefined ? { selector } : {}),
      ...(value !== undefined ? { value } : {}),
      redacted,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    });
    if (action !== null) emit({ type: 'action', action, actionCount: state.actionCount });
  };

  const handleAuthSuspect = (raw: unknown): void => {
    const r = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    if (r['reason'] !== 'password-field') return;
    const url = typeof r['url'] === 'string' && r['url'].length > 0 ? r['url'] : (safeUrl() ?? '');
    emitAuthSuspected('password-field', url);
  };

  const saveStorageState = async (): Promise<boolean> => {
    try {
      // Capture the state object and encrypt it to disk ourselves — the
      // plaintext `context.storageState({ path })` write is never used.
      const state = await context.storageState();
      await writeStorageStateFile(paths.storageState, state as object);
      return true;
    } catch {
      return false;
    }
  };

  // Every live page in the context (initial + popups). Pages remove themselves
  // on close, so closeAll never touches already-closed popups.
  const livePages = new Set<RecorderPageLike>();

  /**
   * Wire main-frame navigation recording for one page. Guarded by `livePages`
   * so the initial page (wired explicitly below) is never double-wired when it
   * also arrives via `context.on('page')` — one real navigation, one action.
   */
  const wirePage = (target: RecorderPageLike): void => {
    if (livePages.has(target)) return;
    livePages.add(target);
    target.on('framenavigated', (frame: RecorderFrameLike) => {
      if (frame !== target.mainFrame()) return;
      let url = '';
      try {
        url = frame.url();
      } catch {
        return;
      }
      if (url === '' || url === 'about:blank') return;
      const action = state.addAction({ type: 'navigate', url, metadata: { actionType: 'navigation' } });
      emit({ type: 'navigated', url, ...(action !== null ? { step: action.step } : {}) });
      if (isAuthUrl(url, options.authConfig)) emitAuthSuspected('auth-domain-navigation', url);
    });
    // A closing POPUP is just bookkeeping — the session only ends via the
    // context 'close' path (or stop()), never from a popup's close.
    target.on('close', () => {
      livePages.delete(target);
    });
  };

  const closeAll = async (): Promise<void> => {
    for (const openPage of [...livePages]) {
      try {
        await openPage.close();
      } catch {
        /* already closed */
      }
    }
    try {
      await page.close();
    } catch {
      /* already closed */
    }
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
  };

  try {
    // Launch degradations first: the consumer's onEvent is already attached,
    // so the "recording without your logins" warning precedes any action.
    for (const warning of warnings) {
      emit({ type: 'warning', message: warning.message, reason: warning.reason });
    }

    // Context-level bridges + init script: inherited by every page the context
    // opens, so popup interactions (SSO windows, target=_blank) are captured.
    await context.exposeFunction('__waaRecord', handleRecord);
    await context.exposeFunction('__waaAuthSuspect', handleAuthSuspect);
    await context.addInitScript(buildRecorderScript());

    wirePage(page);
    context.on('page', (popup: RecorderPageLike) => wirePage(popup));

    context.on('close', () => {
      if (!stopping) emit({ type: 'closed', reason: 'browser-closed' });
    });

    if (!(options.headless ?? false)) {
      try {
        await page.bringToFront();
      } catch {
        /* focus is best-effort */
      }
    }
    await page.goto(options.url);
  } catch (error) {
    stopping = true;
    await closeAll();
    throw error;
  }

  const endSegmentAndSave = async (): Promise<EndAuthSegmentResult> => {
    const { checkpoint } = state.endSegment(safeUrl() ?? undefined);
    const storageStateSaved = await saveStorageState();
    if (storageStateSaved) state.markStorageStateSaved(checkpoint.id);
    emit({ type: 'auth-segment', state: 'ended', checkpoint: { ...checkpoint } });
    return {
      checkpoint,
      storageStateSaved,
      ...(checkpoint.postLoginUrl !== undefined ? { postLoginUrl: checkpoint.postLoginUrl } : {}),
    };
  };

  return {
    sessionId: options.sessionId,

    // UI contract: always the ORIGINAL page's URL — popups contribute actions
    // and navigations to the recording but never the current-url display.
    async currentUrl(): Promise<string | null> {
      return safeUrl();
    },

    getActions() {
      return state.getActions();
    },

    async startAuthSegment(
      reason: 'user-marked' | 'auto-detected',
      fromStep?: number,
    ): Promise<StartAuthSegmentResult> {
      const loginUrl = safeUrl() ?? undefined;
      const result = state.startSegment(reason, fromStep, loginUrl);
      emit({ type: 'auth-segment', state: 'started', checkpoint: { ...result.checkpoint } });
      return result;
    },

    async endAuthSegment(): Promise<EndAuthSegmentResult> {
      return endSegmentAndSave();
    },

    async stop() {
      if (stoppedRecording !== null) return stoppedRecording;
      stopping = true;
      if (state.isSegmentActive) {
        await endSegmentAndSave();
      } else {
        await saveStorageState(); // best-effort session-level save
      }
      const recording = state.toRecording({
        sessionId: options.sessionId,
        url: options.url,
        browserType: options.browserType,
        ...(options.browserName !== undefined ? { browserName: options.browserName } : {}),
        useProfile: options.useProfile,
      });
      await saveRecording(paths.recording, recording);
      await closeAll();
      stoppedRecording = recording;
      emit({ type: 'closed', reason: 'stopped' });
      return recording;
    },

    async dispose(): Promise<void> {
      stopping = true;
      await closeAll();
    },
  };
}
