import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  getStorageStateStatus,
  validateStorageState,
  type ProbeBrowser,
} from './storage-state.js';

let tmp: string;

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'waa-storage-state-'));
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** Write a Playwright-shaped storageState fixture; returns its path. */
async function writeState(name: string, cookies: Array<Record<string, unknown>>): Promise<string> {
  const file = path.join(tmp, name);
  await writeFile(file, JSON.stringify({ cookies, origins: [] }), 'utf8');
  return file;
}

const cookie = (expires: number | undefined): Record<string, unknown> => ({
  name: 'sid',
  value: 'secret-value-never-surfaced',
  domain: 'example.com',
  path: '/',
  ...(expires !== undefined ? { expires } : {}),
  httpOnly: true,
  secure: true,
  sameSite: 'Lax',
});

describe('getStorageStateStatus', () => {
  it('reports missing file as not present', async () => {
    const status = await getStorageStateStatus(path.join(tmp, 'does-not-exist.json'));
    expect(status).toEqual({
      present: false,
      expired: null,
      earliestExpiry: null,
      message: 'Storage state missing or unreadable',
    });
  });

  it('reports unparseable JSON as not present', async () => {
    const file = path.join(tmp, 'broken.json');
    await writeFile(file, '{not json', 'utf8');
    const status = await getStorageStateStatus(file);
    expect(status.present).toBe(false);
    expect(status.expired).toBeNull();
  });

  it('flags an expired cookie', async () => {
    const past = Math.floor(Date.now() / 1000) - 24 * 3600;
    const file = await writeState('expired.json', [cookie(past)]);
    const status = await getStorageStateStatus(file);
    expect(status.present).toBe(true);
    expect(status.expired).toBe(true);
    expect(status.earliestExpiry).toBe(new Date(past * 1000).toISOString());
    expect(status.message).toMatch(/expired/i);
  });

  it('reports a future cookie as valid', async () => {
    const future = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
    const file = await writeState('future.json', [cookie(future)]);
    const status = await getStorageStateStatus(file);
    expect(status.present).toBe(true);
    expect(status.expired).toBe(false);
    expect(status.earliestExpiry).toBe(new Date(future * 1000).toISOString());
  });

  it('treats session-only cookies (-1 / absent expires) as unknown expiry', async () => {
    const file = await writeState('session-only.json', [cookie(-1), cookie(undefined)]);
    const status = await getStorageStateStatus(file);
    expect(status.present).toBe(true);
    expect(status.expired).toBeNull();
    expect(status.earliestExpiry).toBeNull();
    expect(status.message).toMatch(/session-only/i);
  });

  it('uses the earliest positive expiry among mixed cookies', async () => {
    const soon = Math.floor(Date.now() / 1000) + 60;
    const later = Math.floor(Date.now() / 1000) + 3600;
    const file = await writeState('mixed.json', [cookie(later), cookie(-1), cookie(soon)]);
    const status = await getStorageStateStatus(file);
    expect(status.expired).toBe(false);
    expect(status.earliestExpiry).toBe(new Date(soon * 1000).toISOString());
  });

  it('never surfaces cookie values in the status', async () => {
    const file = await writeState('leak-check.json', [cookie(-1)]);
    const status = await getStorageStateStatus(file);
    expect(JSON.stringify(status)).not.toContain('secret-value-never-surfaced');
  });
});

/** Fake browser satisfying ProbeBrowser; records lifecycle for assertions. */
function fakeBrowser(landedUrl: string, log: string[]): ProbeBrowser {
  return {
    async newContext() {
      log.push('newContext');
      return {
        async newPage() {
          return {
            async goto() {
              log.push('goto');
              return null;
            },
            async waitForSelector() {
              log.push('waitForSelector');
              return null;
            },
            url: () => landedUrl,
          };
        },
        async close() {
          log.push('context.close');
        },
      };
    },
    async close() {
      log.push('browser.close');
    },
  };
}

describe('validateStorageState', () => {
  it('fails fast on a missing file without launching a browser', async () => {
    const start = Date.now();
    const result = await validateStorageState({
      storageStatePath: path.join(tmp, 'missing-state.json'),
      probeUrl: 'https://example.com/',
      launchBrowser: () => {
        throw new Error('browser must not launch for a missing file');
      },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('storage-state-missing');
    expect(result.elapsedMs).toBeLessThan(2000);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it('fails with landed-on-auth-page when isAuthUrl matches, still closing the browser', async () => {
    const file = await writeState('probe-auth.json', [cookie(-1)]);
    const log: string[] = [];
    const result = await validateStorageState({
      storageStatePath: file,
      probeUrl: 'https://example.com/dashboard',
      isAuthUrl: (url) => url.includes('login'),
      launchBrowser: async () => fakeBrowser('https://auth.example.com/login?next=/dashboard', log),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('landed-on-auth-page');
    expect(log).toContain('browser.close');
  });

  it('succeeds when navigation and selector wait pass', async () => {
    const file = await writeState('probe-ok.json', [cookie(-1)]);
    const log: string[] = [];
    const result = await validateStorageState({
      storageStatePath: file,
      probeUrl: 'https://example.com/dashboard',
      successSelector: '[data-testid="avatar"]',
      isAuthUrl: (url) => url.includes('login'),
      launchBrowser: async () => fakeBrowser('https://example.com/dashboard', log),
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(log).toEqual(['newContext', 'goto', 'waitForSelector', 'browser.close']);
  });

  it('reports probe errors as ok:false and closes the browser', async () => {
    const file = await writeState('probe-err.json', [cookie(-1)]);
    const log: string[] = [];
    const browser = fakeBrowser('https://example.com/', log);
    browser.newContext = async () => {
      throw new Error('navigation exploded');
    };
    const result = await validateStorageState({
      storageStatePath: file,
      probeUrl: 'https://example.com/',
      launchBrowser: async () => browser,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('navigation exploded');
    expect(log).toContain('browser.close');
  });
});
