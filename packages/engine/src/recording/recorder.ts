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
 *    recorder-side backstop re-redacts any password-typed fill.
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
  exposeFunction(name: string, callback: (payload: unknown) => unknown): Promise<unknown>;
  addInitScript(script: string): Promise<unknown>;
  goto(url: string): Promise<unknown>;
  bringToFront(): Promise<unknown>;
  close(): Promise<unknown>;
  on(event: 'framenavigated', handler: (frame: RecorderFrameLike) => void): unknown;
  mainFrame(): RecorderFrameLike;
}

export interface RecorderContextLike {
  /** Returns the live storage state OBJECT; the recorder encrypts it to disk itself. */
  storageState(): Promise<unknown>;
  close(): Promise<unknown>;
  on(event: 'close', handler: () => void): unknown;
}

export interface RecorderBrowserLike {
  close(): Promise<unknown>;
}

/** What a launcher must hand back; `browser` is absent for persistent contexts. */
export interface RecorderLaunchResult {
  browser?: RecorderBrowserLike;
  context: RecorderContextLike;
  page: RecorderPageLike;
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

/**
 * Real launcher. Paths, in priority order:
 *  1. `reuseStorageStatePath` → clean launch of the REQUESTED browser type +
 *     `newContext({ storageState })` (validated reuse; failures propagate).
 *  2. `useProfile` with a detectable profile → persistent context. Edge/Chrome
 *     profiles run on the bundled chromium binary (legacy-proven combination);
 *     firefox uses `firefox.launchPersistentContext`. webkit has no persistent
 *     contexts and a locked/broken profile falls through to a clean launch.
 *  3. Clean launch + fresh context.
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
  const viewportOption = headless ? {} : { viewport: null };

  if (options.reuseStorageStatePath !== undefined) {
    // Decrypt (or legacy-plaintext read) and seed the context with the OBJECT
    // form; read failures propagate — this is validated reuse.
    const storageState = await readStorageStateFile(options.reuseStorageStatePath);
    const browser = await engine.launch({ headless, args });
    const context = await browser.newContext({
      storageState,
      ...viewportOption,
    });
    return { browser, context, page: await context.newPage() };
  }

  if (options.useProfile && options.browserType !== 'webkit') {
    const profilePath = await findProfilePath(options);
    if (profilePath !== undefined) {
      try {
        // Edge/Chrome profiles launch with the bundled chromium binary.
        const launcher =
          options.browserType === 'firefox' ? playwright.firefox : playwright.chromium;
        const context = await launcher.launchPersistentContext(profilePath, {
          headless,
          args,
          ...viewportOption,
        });
        const page = context.pages()[0] ?? (await context.newPage());
        return { context, page };
      } catch {
        // Profile locked by a running browser, or unusable → clean fallback.
      }
    }
  }

  const browser = await engine.launch({ headless, args });
  const context = await browser.newContext(viewportOption);
  return { browser, context, page: await context.newPage() };
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
 * manual navigate action is pushed. Fails (and closes the browser) if the
 * initial wiring or navigation fails. The optional `deps` parameter is a
 * test-only seam.
 */
export async function createRecorder(
  options: RecorderOptions,
  deps: RecorderDeps = {},
): Promise<RecorderHandle> {
  const paths = sessionPaths(path.dirname(options.sessionDir), path.basename(options.sessionDir));
  await mkdir(paths.root, { recursive: true });

  const state = new RecorderState(deps.clock);
  const { browser, context, page } = await (deps.launch ?? defaultLaunch)(options);

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

  const closeAll = async (): Promise<void> => {
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
    await page.exposeFunction('__waaRecord', handleRecord);
    await page.exposeFunction('__waaAuthSuspect', handleAuthSuspect);
    await page.addInitScript(buildRecorderScript());

    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
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
