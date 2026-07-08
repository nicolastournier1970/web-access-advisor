/**
 * Unit tests for the snapshotter (fake page + injected axe runner writing to
 * temp dirs) plus the ONE real-browser smoke test of this wave: headless
 * chromium via page.setContent, covering scrubbed snapshot.html, a real axe
 * image-alt violation, the screenshot, and a role-candidate click replay.
 */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import { executeAction } from '../replay/replayer.js';
import { sessionPaths, type SessionPaths } from '../storage/session-files.js';
import { capturePageState, captureSnapshot, type SnapshotPage } from './snapshotter.js';

// ---------------------------------------------------------------------------
// Temp dirs + fakes
// ---------------------------------------------------------------------------

const tmpRoots: string[] = [];

afterAll(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
});

async function tmpPaths(): Promise<SessionPaths> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'waa-snap-'));
  tmpRoots.push(root);
  return sessionPaths(root, 'sess');
}

const VALID_HTML =
  '<html><head><title>ok</title></head><body>' +
  '<input type="password" value="hunter2">' +
  '<input type="text" value="alice@example.com">' +
  `<p>${'pad '.repeat(40)}</p>` +
  '</body></html>';

interface FakePageConfig {
  /** content() return sequence; the last entry repeats. */
  htmls?: string[];
  /** axe-context evaluate() return sequence; the last entry repeats. */
  contexts?: Array<Record<string, unknown> | null>;
  /** page-state evaluate() result. */
  state?: Record<string, unknown> | null;
  screenshot?: 'write' | 'throw';
}

function fakeSnapshotPage(config: FakePageConfig = {}): {
  page: SnapshotPage;
  calls: { content: number; context: number; screenshot: number };
} {
  const calls = { content: 0, context: 0, screenshot: 0 };
  const htmls = config.htmls ?? [VALID_HTML];
  const contexts = config.contexts ?? [
    { url: 'https://fake.test/', title: 'Fake', elementCount: 9 },
  ];
  const page: SnapshotPage = {
    content: async () => {
      const html = htmls[Math.min(calls.content, htmls.length - 1)]!;
      calls.content++;
      return html;
    },
    evaluate: async (script: string) => {
      if (script.includes('bodyHtml')) {
        return config.state === undefined
          ? { url: 'https://fake.test/', title: 'Fake', elementCount: 9, bodyHtml: '<p>x</p>' }
          : config.state;
      }
      const context = contexts[Math.min(calls.context, contexts.length - 1)]!;
      calls.context++;
      return context;
    },
    screenshot: async (options: { path: string; fullPage: boolean }) => {
      calls.screenshot++;
      if (config.screenshot === 'throw') throw new Error('screenshot failed');
      await writeFile(options.path, Buffer.from('fake-png'));
      return Buffer.from('fake-png');
    },
  };
  return { page, calls };
}

const okAxeRunner = async (): Promise<{ violations: unknown[] }> => ({ violations: [] });

// ---------------------------------------------------------------------------
// capturePageState
// ---------------------------------------------------------------------------

describe('capturePageState', () => {
  it('returns the single-evaluate observation as a PageState', async () => {
    const { page } = fakeSnapshotPage({
      state: { url: 'https://a.test/', title: 'A', elementCount: 42, bodyHtml: '<div>a</div>' },
    });

    await expect(capturePageState(page)).resolves.toEqual({
      url: 'https://a.test/',
      title: 'A',
      elementCount: 42,
      bodyHtml: '<div>a</div>',
    });
  });

  it('normalizes malformed evaluate results to safe defaults', async () => {
    const { page } = fakeSnapshotPage({ state: null });

    await expect(capturePageState(page)).resolves.toEqual({
      url: '',
      title: '',
      elementCount: 0,
      bodyHtml: '',
    });
  });
});

// ---------------------------------------------------------------------------
// captureSnapshot (fake page, injected axe)
// ---------------------------------------------------------------------------

describe('captureSnapshot', () => {
  it('writes ONLY scrubbed HTML to disk (passwords and typed values stripped)', async () => {
    const paths = await tmpPaths();
    const { page } = fakeSnapshotPage();

    const record = await captureSnapshot({
      page,
      step: 1,
      paths,
      captureScreenshot: false,
      axeRunner: okAxeRunner,
      retryDelayMs: 1,
    });

    const onDisk = await readFile(record.files.html, 'utf8');
    expect(onDisk).not.toContain('hunter2');
    expect(onDisk).not.toContain('alice@example.com');
    expect(onDisk).toContain('value=""'); // structure preserved, value emptied
    expect(record.scrubbedHtml).toBe(onDisk);
    expect(record.files.screenshot).toBeUndefined();
  });

  it('creates the zero-padded step directory', async () => {
    const paths = await tmpPaths();
    const { page } = fakeSnapshotPage();

    const record = await captureSnapshot({
      page,
      step: 7,
      paths,
      captureScreenshot: false,
      axeRunner: okAxeRunner,
      retryDelayMs: 1,
    });

    expect(record.files.html).toContain('step_007');
    await expect(stat(paths.stepDir(7))).resolves.toBeTruthy();
  });

  it('retries junk HTML and persists the first plausible capture', async () => {
    const paths = await tmpPaths();
    const { page, calls } = fakeSnapshotPage({ htmls: ['junk', '<body>short</body>', VALID_HTML] });

    const record = await captureSnapshot({
      page,
      step: 1,
      paths,
      captureScreenshot: false,
      axeRunner: okAxeRunner,
      retryDelayMs: 1,
    });

    expect(calls.content).toBe(3);
    expect(record.scrubbedHtml).toContain('<p>');
  });

  it('falls back to the legacy placeholder when HTML never becomes plausible', async () => {
    const paths = await tmpPaths();
    const { page } = fakeSnapshotPage({ htmls: ['junk'] });

    const record = await captureSnapshot({
      page,
      step: 1,
      paths,
      captureScreenshot: false,
      axeRunner: okAxeRunner,
      retryDelayMs: 1,
    });

    expect(record.scrubbedHtml).toContain('HTML Capture Failed');
    expect(await readFile(record.files.html, 'utf8')).toContain('HTML Capture Failed');
  });

  it('writes the FULL axe output to disk but keeps only violations in memory', async () => {
    const paths = await tmpPaths();
    const { page } = fakeSnapshotPage();
    const fullResult = {
      violations: [{ id: 'image-alt', impact: 'critical' }],
      passes: [{ id: 'label' }],
      incomplete: [],
    };

    const record = await captureSnapshot({
      page,
      step: 1,
      paths,
      captureScreenshot: false,
      axeRunner: async () => fullResult,
      retryDelayMs: 1,
    });

    expect(record.axeViolations).toEqual(fullResult.violations);
    const onDisk = JSON.parse(await readFile(record.files.axeResults, 'utf8'));
    expect(onDisk.passes).toEqual([{ id: 'label' }]);
    expect(onDisk.violations[0].id).toBe('image-alt');
  });

  it('survives a throwing axe runner and still writes a sentinel axe_results.json', async () => {
    const paths = await tmpPaths();
    const { page } = fakeSnapshotPage();

    const record = await captureSnapshot({
      page,
      step: 1,
      paths,
      captureScreenshot: false,
      axeRunner: async () => {
        throw new Error('axe exploded');
      },
      retryDelayMs: 1,
    });

    expect(record.axeViolations).toEqual([]);
    const onDisk = JSON.parse(await readFile(record.files.axeResults, 'utf8'));
    expect(onDisk.violations).toEqual([]);
    expect(onDisk.error).toContain('axe exploded');
  });

  it('retries the axe context until the url is real (about:blank rejected)', async () => {
    const paths = await tmpPaths();
    const { page, calls } = fakeSnapshotPage({
      contexts: [
        { url: 'about:blank', title: 'x', elementCount: 3 },
        { url: '', title: 'x', elementCount: 3 },
        { url: 'https://real.test/', title: 'Real', elementCount: 7 },
      ],
    });

    const record = await captureSnapshot({
      page,
      step: 1,
      paths,
      captureScreenshot: false,
      axeRunner: okAxeRunner,
      retryDelayMs: 1,
    });

    expect(calls.context).toBe(3);
    expect(record.url).toBe('https://real.test/');
    expect(record.title).toBe('Real');
    expect(record.elementCount).toBe(7);
    const onDisk = JSON.parse(await readFile(record.files.axeContext, 'utf8'));
    expect(onDisk).toEqual({
      include: [['html']],
      exclude: [],
      elementCount: 7,
      title: 'Real',
      url: 'https://real.test/',
    });
  });

  it('falls back to the sentinel context when the page never becomes ready', async () => {
    const paths = await tmpPaths();
    const { page } = fakeSnapshotPage({
      contexts: [{ url: 'about:blank', title: 'x', elementCount: 0 }],
    });

    const record = await captureSnapshot({
      page,
      step: 1,
      paths,
      captureScreenshot: false,
      axeRunner: okAxeRunner,
      retryDelayMs: 1,
    });

    expect(record.url).toBe('unknown');
    expect(record.title).toBe('Context Capture Failed');
    expect(record.elementCount).toBe(0);
  });

  it('records the screenshot path when enabled and the capture succeeds', async () => {
    const paths = await tmpPaths();
    const { page } = fakeSnapshotPage({ screenshot: 'write' });

    const record = await captureSnapshot({
      page,
      step: 1,
      paths,
      captureScreenshot: true,
      axeRunner: okAxeRunner,
      retryDelayMs: 1,
    });

    expect(record.files.screenshot).toBe(paths.stepFiles(1).screenshot);
    await expect(stat(record.files.screenshot!)).resolves.toBeTruthy();
  });

  it('treats screenshot failure as non-fatal (no screenshot file recorded)', async () => {
    const paths = await tmpPaths();
    const { page } = fakeSnapshotPage({ screenshot: 'throw' });

    const record = await captureSnapshot({
      page,
      step: 1,
      paths,
      captureScreenshot: true,
      axeRunner: okAxeRunner,
      retryDelayMs: 1,
    });

    expect(record.files.screenshot).toBeUndefined();
    expect(record.scrubbedHtml.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Real-browser smoke test (headless bundled chromium)
// ---------------------------------------------------------------------------

describe.skipIf(process.env.WAA_SKIP_BROWSER_TESTS === '1')('browser smoke (chromium)', () => {
  it('captures a scrubbed snapshot with real axe violations, then replays a click', async () => {
    const paths = await tmpPaths();
    const browser = await chromium.launch();
    try {
      // Explicit context: AxeBuilder.finishRun opens a helper page via
      // page.context().newPage(), which Playwright forbids on the ephemeral
      // context created by browser.newPage().
      const context = await browser.newContext();
      const page = await context.newPage();
      // goto a data: URL first so window.location.href is never about:blank
      // (setContent alone would fail the axe-context readiness validation).
      await page.goto('data:text/html,<title>seed</title>');
      await page.setContent(`<!DOCTYPE html>
        <html><head><title>Smoke</title></head><body>
          <h1>Login</h1>
          <img src="missing.png">
          <form>
            <label>User <input type="text" value="alice@example.com"></label>
            <label>Password <input type="password" value="hunter2secret"></label>
            <button type="button" onclick="document.title='clicked'">Submit</button>
          </form>
          <p>${'padding '.repeat(30)}</p>
        </body></html>`);

      const record = await captureSnapshot({
        page,
        step: 1,
        paths,
        captureScreenshot: true,
        retryDelayMs: 50,
      });

      // snapshot.html exists and carries NO typed credentials.
      const html = await readFile(record.files.html, 'utf8');
      expect(html).toContain('<form');
      expect(html).not.toContain('hunter2secret');
      expect(html).not.toContain('alice@example.com');

      // Real axe run flagged the img without alt.
      const axe = JSON.parse(await readFile(record.files.axeResults, 'utf8')) as {
        violations: Array<{ id: string }>;
      };
      expect(axe.violations.map((v) => v.id)).toContain('image-alt');
      expect(record.axeViolations.length).toBeGreaterThan(0);

      // Screenshot written; context captured the data: URL.
      expect(record.files.screenshot).toBeDefined();
      await expect(stat(record.files.screenshot!)).resolves.toBeTruthy();
      expect(record.url.startsWith('data:text/html')).toBe(true);
      expect(record.elementCount).toBeGreaterThan(5);

      // Replay a click through a role candidate on the live page.
      const outcome = await executeAction(page, {
        type: 'click',
        step: 2,
        timestamp: new Date().toISOString(),
        redacted: false,
        target: { candidates: [{ strategy: 'role', role: 'button', name: 'Submit' }] },
      });
      expect(outcome).toEqual({ outcome: 'executed', resolvedBy: 'role' });
      expect(await page.title()).toBe('clicked');
    } finally {
      await browser.close();
    }
  }, 20_000);
});
