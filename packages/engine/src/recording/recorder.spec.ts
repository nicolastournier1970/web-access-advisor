import { mkdtemp, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { REDACTED_VALUE, recordingV2Schema } from '@waa/shared';
import type { RecorderEvent, RecorderOptions } from '../engine-types.js';
import { DEFAULT_AUTH_DOMAINS_CONFIG } from '../auth/domain-config.js';
import {
  fixedKeyProvider,
  readStorageStateFile,
  setDefaultKeyProviderForTests,
  writeStorageStateFile,
} from '../storage/secure-storage-state.js';
import { buildRecorderScript } from './injected/recorder-script.js';
import {
  createRecorder,
  type RecorderContextLike,
  type RecorderFrameLike,
  type RecorderLaunchResult,
} from './recorder.js';

// Encrypt with a fixed in-memory key: no DPAPI/PowerShell, no ~/.waa writes.
beforeAll(() => {
  setDefaultKeyProviderForTests(fixedKeyProvider(Buffer.alloc(32, 42)));
});
afterAll(() => {
  setDefaultKeyProviderForTests(null);
});

// ---------------------------------------------------------------------------
// Fakes (no browser)
// ---------------------------------------------------------------------------

class FakeFrame implements RecorderFrameLike {
  constructor(private currentUrl: string) {}
  url(): string {
    return this.currentUrl;
  }
  setUrl(url: string): void {
    this.currentUrl = url;
  }
}

class FakePage {
  readonly gotoUrls: string[] = [];
  closed = false;
  gotoError: Error | null = null;
  private readonly frame = new FakeFrame('about:blank');
  private readonly navHandlers: Array<(frame: RecorderFrameLike) => void> = [];
  private readonly closeHandlers: Array<() => void> = [];

  url(): string {
    return this.frame.url();
  }
  isClosed(): boolean {
    return this.closed;
  }
  async goto(url: string): Promise<void> {
    if (this.gotoError) throw this.gotoError;
    this.gotoUrls.push(url);
    this.navigate(url);
  }
  async bringToFront(): Promise<void> {}
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const handler of this.closeHandlers) handler();
  }
  on(event: 'framenavigated', handler: (frame: RecorderFrameLike) => void): this;
  on(event: 'close', handler: () => void): this;
  on(event: 'framenavigated' | 'close', handler: unknown): this {
    if (event === 'framenavigated') {
      this.navHandlers.push(handler as (frame: RecorderFrameLike) => void);
    } else {
      this.closeHandlers.push(handler as () => void);
    }
    return this;
  }
  mainFrame(): RecorderFrameLike {
    return this.frame;
  }
  /** Simulate a main-frame navigation (redirect, user click, …). */
  navigate(url: string): void {
    this.frame.setUrl(url);
    for (const handler of this.navHandlers) handler(this.frame);
  }
}

/** Cookie value the fake context reports — must NEVER appear raw on disk. */
export const FAKE_COOKIE_VALUE = 'fake-cookie-value-do-not-persist';

class FakeContext implements RecorderContextLike {
  /** Context-level bridges (v2: exposeFunction lives on the context). */
  readonly exposed = new Map<string, (payload: unknown) => unknown>();
  /** Context-level init scripts (inherited by every page incl. popups). */
  readonly initScripts: string[] = [];
  storageStateCalls = 0;
  storageStateError: Error | null = null;
  closed = false;
  private readonly closeHandlers: Array<() => void> = [];
  private readonly pageHandlers: Array<(page: FakePage) => void> = [];

  async storageState(): Promise<unknown> {
    if (this.storageStateError) throw this.storageStateError;
    this.storageStateCalls += 1;
    return {
      cookies: [
        {
          name: 'fake_session',
          value: FAKE_COOKIE_VALUE,
          domain: 'app.example',
          path: '/',
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
        },
      ],
      origins: [],
    };
  }
  async exposeFunction(name: string, callback: (payload: unknown) => unknown): Promise<void> {
    this.exposed.set(name, callback);
  }
  async addInitScript(script: string): Promise<void> {
    this.initScripts.push(script);
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const handler of this.closeHandlers) handler();
  }
  on(event: 'close', handler: () => void): this;
  on(event: 'page', handler: (page: FakePage) => void): this;
  on(event: 'close' | 'page', handler: unknown): this {
    if (event === 'close') {
      this.closeHandlers.push(handler as () => void);
    } else {
      this.pageHandlers.push(handler as (page: FakePage) => void);
    }
    return this;
  }
  /** Simulate an in-page bridge call arriving over the context exposeFunction. */
  bridge(name: string, payload: unknown): void {
    this.exposed.get(name)?.(payload);
  }
  /** Fire the 'page' event (a popup opened, or a replayed initial page). */
  emitPage(page: FakePage): void {
    for (const handler of this.pageHandlers) handler(page);
  }
  /** Open a popup: new FakePage announced via the 'page' event. */
  openPopup(): FakePage {
    const popup = new FakePage();
    this.emitPage(popup);
    return popup;
  }
}

class FakeBrowser {
  closed = false;
  async close(): Promise<void> {
    this.closed = true;
  }
}

interface Harness {
  options: RecorderOptions;
  events: RecorderEvent[];
  page: FakePage;
  context: FakeContext;
  browser: FakeBrowser;
  sessionDir: string;
  launch: () => Promise<RecorderLaunchResult>;
}

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'waa-recorder-'));
});

function makeHarness(overrides: Partial<RecorderOptions> = {}): Harness {
  const events: RecorderEvent[] = [];
  const page = new FakePage();
  const context = new FakeContext();
  const browser = new FakeBrowser();
  const sessionDir = path.join(tempRoot, 'session_unit');
  const options: RecorderOptions = {
    sessionId: 'session_unit',
    url: 'https://app.example/start',
    browserType: 'chromium',
    useProfile: false,
    headless: true,
    sessionDir,
    authConfig: DEFAULT_AUTH_DOMAINS_CONFIG,
    onEvent: (event) => events.push(event),
    ...overrides,
  };
  return { options, events, page, context, browser, sessionDir, launch: async () => ({ browser, context, page }) };
}

function ofType<K extends RecorderEvent['type']>(
  events: RecorderEvent[],
  type: K,
): Array<Extract<RecorderEvent, { type: K }>> {
  return events.filter((e): e is Extract<RecorderEvent, { type: K }> => e.type === type);
}

// ---------------------------------------------------------------------------
// Unit tests (fake page/context)
// ---------------------------------------------------------------------------

describe('createRecorder wiring', () => {
  it('exposes both bridges, injects the recorder script, and navigates exactly once', async () => {
    const h = makeHarness();
    const handle = await createRecorder(h.options, { launch: h.launch });

    expect(h.context.exposed.has('__waaRecord')).toBe(true);
    expect(h.context.exposed.has('__waaAuthSuspect')).toBe(true);
    expect(h.context.initScripts).toContain(buildRecorderScript());
    expect(h.page.gotoUrls).toEqual(['https://app.example/start']);

    // The initial navigation is recorded ONCE, via framenavigated (step 1).
    const actions = handle.getActions();
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: 'navigate', step: 1, url: 'https://app.example/start' });
    expect(ofType(h.events, 'navigated')).toEqual([
      { type: 'navigated', url: 'https://app.example/start', step: 1 },
    ]);
    expect(await handle.currentUrl()).toBe('https://app.example/start');
  });

  it('closes everything and rethrows when the initial navigation fails', async () => {
    const h = makeHarness();
    h.page.gotoError = new Error('net::ERR_NAME_NOT_RESOLVED');
    await expect(createRecorder(h.options, { launch: h.launch })).rejects.toThrow(
      'ERR_NAME_NOT_RESOLVED',
    );
    expect(h.page.closed).toBe(true);
    expect(h.context.closed).toBe(true);
    expect(h.browser.closed).toBe(true);
  });

  it('survives a throwing onEvent consumer', async () => {
    const h = makeHarness({
      onEvent: () => {
        throw new Error('consumer bug');
      },
    });
    const handle = await createRecorder(h.options, { launch: h.launch });
    h.context.bridge('__waaRecord', { kind: 'click', candidates: [] });
    expect(handle.getActions()).toHaveLength(2);
  });
});

describe('bridge payload handling', () => {
  it('sanitizes candidates and records a click with target + legacy selector', async () => {
    const h = makeHarness();
    const handle = await createRecorder(h.options, { launch: h.launch });
    h.context.bridge('__waaRecord', {
      kind: 'click',
      candidates: [
        { strategy: 'id', value: 'save-btn' },
        { strategy: 'junk-strategy', nonsense: true },
        { strategy: 'nth-path', value: 'div:nth-child(1) > button:nth-child(2)' },
      ],
      tag: 'button',
      text: 'Save',
    });

    const action = handle.getActions()[1];
    expect(action).toMatchObject({
      type: 'click',
      step: 2,
      selector: '#save-btn',
      redacted: false,
      metadata: { tag: 'button', text: 'Save' },
    });
    expect(action?.target?.candidates).toEqual([
      { strategy: 'id', value: 'save-btn' },
      { strategy: 'nth-path', value: 'div:nth-child(1) > button:nth-child(2)' },
    ]);
    expect(action?.target?.description).toBe('#save-btn');

    const actionEvents = ofType(h.events, 'action');
    expect(actionEvents).toHaveLength(1);
    expect(actionEvents[0]!.actionCount).toBe(2);
  });

  it('drops malformed payloads silently', async () => {
    const h = makeHarness();
    const handle = await createRecorder(h.options, { launch: h.launch });
    for (const junk of [null, 42, 'click', {}, { kind: 'explode' }, { kind: 'fill', value: 1 }]) {
      h.context.bridge('__waaRecord', junk);
    }
    // Only the { kind:'fill', value:1 } payload is a valid kind (value dropped).
    expect(handle.getActions().filter((a) => a.type !== 'navigate')).toHaveLength(1);
  });

  it('re-redacts a password fill even if the page script failed to (backstop)', async () => {
    const h = makeHarness();
    const handle = await createRecorder(h.options, { launch: h.launch });
    h.context.bridge('__waaRecord', {
      kind: 'fill',
      candidates: [{ strategy: 'id', value: 'pw' }],
      inputType: 'password',
      value: 'leaked-secret',
      redacted: false,
    });
    const action = handle.getActions()[1];
    expect(action).toMatchObject({ type: 'fill', value: REDACTED_VALUE, redacted: true });
    expect(JSON.stringify(handle.getActions())).not.toContain('leaked-secret');
  });

  it('emits auth-suspected (password-field) once per url with the current last step', async () => {
    const h = makeHarness();
    await createRecorder(h.options, { launch: h.launch });
    h.context.bridge('__waaAuthSuspect', { reason: 'password-field', url: 'https://app.example/start' });
    h.context.bridge('__waaAuthSuspect', { reason: 'password-field', url: 'https://app.example/start' });
    const suspected = ofType(h.events, 'auth-suspected');
    expect(suspected).toEqual([
      {
        type: 'auth-suspected',
        reason: 'password-field',
        url: 'https://app.example/start',
        suspectedAtStep: 1,
      },
    ]);
  });
});

describe('navigation handling', () => {
  it('records later navigations and flags auth-domain URLs', async () => {
    const h = makeHarness();
    const handle = await createRecorder(h.options, { launch: h.launch });
    h.page.navigate('https://accounts.google.com/signin');

    expect(handle.getActions()[1]).toMatchObject({
      type: 'navigate',
      step: 2,
      url: 'https://accounts.google.com/signin',
    });
    expect(ofType(h.events, 'auth-suspected')).toEqual([
      {
        type: 'auth-suspected',
        reason: 'auth-domain-navigation',
        url: 'https://accounts.google.com/signin',
        suspectedAtStep: 2,
      },
    ]);
  });

  it('ignores about:blank', async () => {
    const h = makeHarness();
    const handle = await createRecorder(h.options, { launch: h.launch });
    h.page.navigate('about:blank');
    expect(handle.getActions()).toHaveLength(1);
  });
});

describe('auth segments', () => {
  it('discards actions during the segment and saves storage state at the end', async () => {
    const h = makeHarness();
    const handle = await createRecorder(h.options, { launch: h.launch });
    h.context.bridge('__waaRecord', { kind: 'click', candidates: [] });

    const started = await handle.startAuthSegment('user-marked');
    expect(started.checkpoint).toMatchObject({
      id: 'acp_1',
      afterStep: 2,
      reason: 'user-marked',
      loginUrl: 'https://app.example/start',
    });
    expect(started.discardedActions).toBe(0);
    expect(ofType(h.events, 'auth-segment')[0]).toMatchObject({ state: 'started' });

    // Credentials typed during the segment never become actions or events.
    h.context.bridge('__waaRecord', { kind: 'fill', candidates: [], value: 'hunter2' });
    h.page.navigate('https://accounts.google.com/signin');
    h.page.navigate('https://app.example/dashboard');
    expect(handle.getActions()).toHaveLength(2);
    expect(ofType(h.events, 'action')).toHaveLength(1);
    // auth-suspected is muted while the segment is open
    expect(ofType(h.events, 'auth-suspected')).toHaveLength(0);

    const ended = await handle.endAuthSegment();
    expect(ended.storageStateSaved).toBe(true);
    expect(ended.checkpoint.storageStateSaved).toBe(true);
    expect(ended.postLoginUrl).toBe('https://app.example/dashboard');
    // Saved ENCRYPTED at the session path: envelope on disk, no raw cookie data,
    // and the decrypted roundtrip yields the captured state.
    const storageStatePath = path.join(h.sessionDir, 'storageState.json');
    expect(h.context.storageStateCalls).toBe(1);
    const rawState = await readFile(storageStatePath, 'utf8');
    expect(rawState).toContain('waaEncrypted');
    expect(rawState).not.toContain('fake_session');
    expect(rawState).not.toContain(FAKE_COOKIE_VALUE);
    const decrypted = (await readStorageStateFile(storageStatePath)) as {
      cookies: Array<{ name: string }>;
    };
    expect(decrypted.cookies.map((c) => c.name)).toEqual(['fake_session']);
    const segmentEvents = ofType(h.events, 'auth-segment');
    expect(segmentEvents[1]).toMatchObject({
      state: 'ended',
      checkpoint: { storageStateSaved: true },
    });
    expect(JSON.stringify(handle.getActions())).not.toContain('hunter2');
  });

  it('supports retroactive segment starts that discard the action tail', async () => {
    const h = makeHarness();
    const handle = await createRecorder(h.options, { launch: h.launch });
    h.context.bridge('__waaRecord', { kind: 'click', candidates: [] }); // step 2
    h.context.bridge('__waaRecord', { kind: 'fill', candidates: [], value: 'user@example.com' }); // step 3

    const started = await handle.startAuthSegment('auto-detected', 1);
    expect(started.discardedActions).toBe(2);
    expect(started.checkpoint.afterStep).toBe(1);
    expect(handle.getActions().map((a) => a.step)).toEqual([1]);
  });

  it('reports storageStateSaved false when the save fails', async () => {
    const h = makeHarness();
    const handle = await createRecorder(h.options, { launch: h.launch });
    h.context.storageStateError = new Error('disk full');
    await handle.startAuthSegment('user-marked');
    const ended = await handle.endAuthSegment();
    expect(ended.storageStateSaved).toBe(false);
    expect(ended.checkpoint.storageStateSaved).toBe(false);
  });
});

describe('stop / dispose / close', () => {
  it('stop() writes a schema-valid recording.json, closes the browser, and is idempotent', async () => {
    const h = makeHarness();
    const handle = await createRecorder(h.options, { launch: h.launch });
    h.context.bridge('__waaRecord', { kind: 'click', candidates: [{ strategy: 'id', value: 'go' }] });

    const recording = await handle.stop();
    expect(recording.formatVersion).toBe(2);
    expect(recording.actionCount).toBe(2);
    expect(recording).toMatchObject({ browserType: 'chromium', useProfile: false });

    const onDisk = recordingV2Schema.parse(
      JSON.parse(await readFile(path.join(h.sessionDir, 'recording.json'), 'utf8')),
    );
    expect(onDisk.sessionId).toBe('session_unit');
    expect(onDisk.actions).toHaveLength(2);

    expect(h.page.closed).toBe(true);
    expect(h.context.closed).toBe(true);
    expect(h.browser.closed).toBe(true);
    // storage state saved best-effort at stop — encrypted envelope on disk
    const stopStatePath = path.join(h.sessionDir, 'storageState.json');
    expect(existsSync(stopStatePath)).toBe(true);
    expect(await readFile(stopStatePath, 'utf8')).toContain('waaEncrypted');
    // exactly one closed event, reason 'stopped' (no browser-closed from our own close)
    expect(ofType(h.events, 'closed')).toEqual([{ type: 'closed', reason: 'stopped' }]);

    const again = await handle.stop();
    expect(again).toBe(recording);
    expect(ofType(h.events, 'closed')).toHaveLength(1);
  });

  it('stop() ends a still-open auth segment and records its checkpoint', async () => {
    const h = makeHarness();
    const handle = await createRecorder(h.options, { launch: h.launch });
    await handle.startAuthSegment('user-marked');
    const recording = await handle.stop();
    expect(recording.authCheckpoints).toHaveLength(1);
    expect(recording.authCheckpoints[0]).toMatchObject({
      storageStateSaved: true,
      completedAt: expect.any(String),
    });
  });

  it('emits closed(browser-closed) when the user closes the browser', async () => {
    const h = makeHarness();
    await createRecorder(h.options, { launch: h.launch });
    await h.context.close(); // user closed the window
    expect(ofType(h.events, 'closed')).toEqual([{ type: 'closed', reason: 'browser-closed' }]);
  });

  it('dispose() closes everything without saving or emitting', async () => {
    const h = makeHarness();
    const handle = await createRecorder(h.options, { launch: h.launch });
    const eventCount = h.events.length;
    await handle.dispose();
    expect(h.page.closed).toBe(true);
    expect(h.browser.closed).toBe(true);
    expect(existsSync(path.join(h.sessionDir, 'recording.json'))).toBe(false);
    expect(h.events).toHaveLength(eventCount);
  });
});

// ---------------------------------------------------------------------------
// Real-browser smoke tests (headless bundled chromium)
// ---------------------------------------------------------------------------

const FORM_HTML = `<!doctype html><html><body>
  <label for="username">Name</label><input id="username" type="text">
  <label for="password">Pass</label><input id="password" type="password">
  <button id="btn" data-testid="go-btn">Go</button>
</body></html>`;
const DATA_URL = `data:text/html,${encodeURIComponent(FORM_HTML)}`;

async function until<T>(probe: () => T | undefined | false, timeoutMs = 8_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const result = probe();
    if (result !== undefined && result !== false) return result as T;
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(process.env.WAA_SKIP_BROWSER_TESTS === '1')('browser smoke', () => {
  it('records, redacts passwords, handles an auth segment, and writes recording v2', async () => {
    const { chromium } = await import('playwright');
    const sessionDir = path.join(tempRoot, 'session_smoke');
    const events: RecorderEvent[] = [];
    let page!: import('playwright').Page;

    const handle = await createRecorder(
      {
        sessionId: 'session_smoke',
        url: DATA_URL,
        browserType: 'chromium',
        useProfile: false,
        headless: true,
        sessionDir,
        authConfig: DEFAULT_AUTH_DOMAINS_CONFIG,
        onEvent: (event) => events.push(event),
      },
      {
        launch: async () => {
          const browser = await chromium.launch({ headless: true });
          const context = await browser.newContext();
          page = await context.newPage();
          return { browser, context, page };
        },
      },
    );

    // Initial navigation recorded exactly once, via framenavigated.
    await until(() => handle.getActions().some((a) => a.type === 'navigate'));
    expect(handle.getActions().filter((a) => a.type === 'navigate')).toHaveLength(1);

    // Simulate a user: type a name, type a password, click the button.
    await page.fill('#username', 'Alice');
    await page.fill('#password', 'hunter2-smoke'); // focusing blurs #username
    await page.click('#btn'); // blurs #password

    const actions = await until(() => {
      const current = handle.getActions();
      return current.some((a) => a.type === 'click') &&
        current.filter((a) => a.type === 'fill').length >= 2
        ? current
        : undefined;
    });

    const fills = actions.filter((a) => a.type === 'fill');
    const nameFill = fills.find((a) => a.value === 'Alice');
    expect(nameFill).toMatchObject({ redacted: false });
    expect(nameFill?.target?.candidates.length).toBeGreaterThan(0);

    const passwordFill = fills.find((a) => a.redacted);
    expect(passwordFill?.value).toBe(REDACTED_VALUE);
    expect(JSON.stringify(actions)).not.toContain('hunter2-smoke');

    const click = actions.find((a) => a.type === 'click');
    expect(click?.target?.candidates).toEqual(
      expect.arrayContaining([{ strategy: 'testid', attribute: 'data-testid', value: 'go-btn' }]),
    );

    // Focusing the password field raised an auth suspicion.
    expect(events.some((e) => e.type === 'auth-suspected' && e.reason === 'password-field')).toBe(
      true,
    );

    // Auth segment: typed actions are discarded, storage state is saved.
    const stepsBefore = handle.getActions().length;
    const started = await handle.startAuthSegment('user-marked');
    expect(started.checkpoint.id).toBe('acp_1');
    await page.fill('#username', 'secretuser-smoke');
    await page.click('#btn');
    await sleep(400); // let in-flight bridge messages land while segment is open

    const ended = await handle.endAuthSegment();
    expect(ended.storageStateSaved).toBe(true);
    expect(existsSync(path.join(sessionDir, 'storageState.json'))).toBe(true);
    // Encrypted at rest even for the real-browser save path.
    expect(await readFile(path.join(sessionDir, 'storageState.json'), 'utf8')).toContain(
      'waaEncrypted',
    );
    expect(handle.getActions()).toHaveLength(stepsBefore);

    // Recording resumes with a monotonic step after the checkpoint.
    await page.click('#btn');
    await until(() => handle.getActions().length === stepsBefore + 1);

    const recording = await handle.stop();
    expect(recording.formatVersion).toBe(2);
    expect(recording.authCheckpoints[0]).toMatchObject({ id: 'acp_1', storageStateSaved: true });

    const rawFile = await readFile(path.join(sessionDir, 'recording.json'), 'utf8');
    expect(rawFile).not.toContain('secretuser-smoke');
    expect(rawFile).not.toContain('hunter2-smoke');
    const onDisk = recordingV2Schema.parse(JSON.parse(rawFile));
    expect(onDisk.actionCount).toBe(onDisk.actions.length);
    expect(events.filter((e) => e.type === 'closed')).toEqual([
      { type: 'closed', reason: 'stopped' },
    ]);
  }, 20_000);

  it('default launcher honours reuseStorageStatePath with the requested browser type', async () => {
    const sessionDir = path.join(tempRoot, 'session_reuse');
    // Seed is an ENCRYPTED file: the default launcher must decrypt it and seed
    // the context with the object form (playwright validates the shape).
    const seedPath = path.join(tempRoot, 'seed-storageState.json');
    await writeStorageStateFile(seedPath, {
      cookies: [
        {
          name: 'seed_cookie',
          value: 'seed-value',
          domain: 'app.example',
          path: '/',
          expires: -1,
          httpOnly: false,
          secure: false,
          sameSite: 'Lax',
        },
      ],
      origins: [],
    });
    expect(await readFile(seedPath, 'utf8')).toContain('waaEncrypted');
    const events: RecorderEvent[] = [];

    const handle = await createRecorder({
      sessionId: 'session_reuse',
      url: DATA_URL,
      browserType: 'chromium',
      useProfile: false,
      headless: true,
      sessionDir,
      reuseStorageStatePath: seedPath,
      authConfig: DEFAULT_AUTH_DOMAINS_CONFIG,
      onEvent: (event) => events.push(event),
    });

    await until(() => handle.getActions().length >= 1);
    expect(await handle.currentUrl()).toBe(DATA_URL);

    const recording = await handle.stop();
    expect(recording.actions[0]).toMatchObject({ type: 'navigate', step: 1 });
    expect(existsSync(path.join(sessionDir, 'recording.json'))).toBe(true);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Hardening: launch-degradation warnings + popup recording
// ---------------------------------------------------------------------------

describe('hardening: launch warnings + popup recording', () => {
  it('emits warning events from launch degradations BEFORE any action', async () => {
    const h = makeHarness();
    const handle = await createRecorder(h.options, {
      launch: async () => ({
        context: h.context,
        page: h.page,
        warnings: [
          {
            reason: 'profile-unavailable' as const,
            message: 'Profile locked — recording with a clean browser',
          },
        ],
      }),
    });
    const warnings = ofType(h.events, 'warning');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.reason).toBe('profile-unavailable');
    // The trust-critical warning must precede the first recorded action.
    const warningIdx = h.events.findIndex((e) => e.type === 'warning');
    const firstActionIdx = h.events.findIndex((e) => e.type === 'action');
    expect(warningIdx).toBeGreaterThanOrEqual(0);
    if (firstActionIdx >= 0) expect(warningIdx).toBeLessThan(firstActionIdx);
    await handle.dispose();
  });

  it('records navigations from popups and fires auth-suspected on popup auth domains', async () => {
    const h = makeHarness();
    const handle = await createRecorder(h.options, { launch: h.launch });
    const before = handle.getActions().length;

    const popup = h.context.openPopup();
    popup.navigate('https://app.example/popup-page');
    expect(handle.getActions().length).toBe(before + 1);
    expect(handle.getActions().at(-1)?.type).toBe('navigate');
    expect(handle.getActions().at(-1)?.url).toBe('https://app.example/popup-page');

    // SSO popup landing on an IdP must trip the auto-detect assist like the main page.
    popup.navigate('https://accounts.google.com/signin');
    const suspected = ofType(h.events, 'auth-suspected');
    expect(
      suspected.some(
        (e) => e.reason === 'auth-domain-navigation' && e.url.includes('accounts.google.com'),
      ),
    ).toBe(true);
    await handle.dispose();
  });

  it('keeps the session alive when a popup closes; only stop ends it', async () => {
    const h = makeHarness();
    const handle = await createRecorder(h.options, { launch: h.launch });
    const popup = h.context.openPopup();
    await popup.close();
    expect(ofType(h.events, 'closed')).toHaveLength(0);

    const recording = await handle.stop();
    expect(recording.sessionId).toBe('session_unit');
    expect(ofType(h.events, 'closed').map((e) => e.reason)).toEqual(['stopped']);
  });
});
