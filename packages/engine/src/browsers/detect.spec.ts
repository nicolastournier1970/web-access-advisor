import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { detectBrowsers, probeProfile, type DetectDeps } from './detect.js';

const WIN_HOME = 'C:\\Users\\test';
const winPath = (...segments: string[]) => path.win32.join(WIN_HOME, ...segments);

/** Fake deps where every profile-dir exists and Firefox has profiles. */
function allPresentDeps(overrides: Partial<DetectDeps> = {}): DetectDeps {
  return {
    platform: 'win32',
    homedir: () => WIN_HOME,
    pathExists: async () => true,
    listDir: async () => ['abcd1234.default-release', 'wxyz.default'],
    timeoutMs: 50,
    ...overrides,
  };
}

describe('detectBrowsers', () => {
  it('returns Edge, Chrome, Firefox and Playwright Chromium when all win32 profiles exist', async () => {
    const browsers = await detectBrowsers(allPresentDeps());

    expect(browsers).toHaveLength(4);

    const [edge, chrome, firefox, bundled] = browsers;
    expect(edge).toEqual({
      type: 'chromium',
      name: 'Microsoft Edge',
      available: true,
      profilePath: winPath('AppData', 'Local', 'Microsoft', 'Edge', 'User Data', 'Default'),
      profileSupported: true,
    });
    expect(chrome).toEqual({
      type: 'chromium',
      name: 'Google Chrome',
      available: true,
      profilePath: winPath('AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Default'),
      profileSupported: true,
    });
    expect(firefox).toEqual({
      type: 'firefox',
      name: 'Firefox',
      available: true,
      profilePath: winPath(
        'AppData',
        'Roaming',
        'Mozilla',
        'Firefox',
        'Profiles',
        'abcd1234.default-release',
      ),
      profileSupported: true,
    });
    expect(bundled).toEqual({
      type: 'chromium',
      name: 'Playwright Chromium',
      available: true,
      profileSupported: false,
    });
    expect(bundled!.profilePath).toBeUndefined();
  });

  it('marks every browser unavailable when no profiles are present, keeping Playwright Chromium usable', async () => {
    const browsers = await detectBrowsers(
      allPresentDeps({
        pathExists: async () => false,
        listDir: async () => {
          throw Object.assign(new Error('ENOENT: no such directory'), { code: 'ENOENT' });
        },
      }),
    );

    expect(browsers).toEqual([
      { type: 'chromium', name: 'Microsoft Edge', available: false, profileSupported: false },
      { type: 'chromium', name: 'Google Chrome', available: false, profileSupported: false },
      { type: 'firefox', name: 'Firefox', available: false, profileSupported: false },
      { type: 'chromium', name: 'Playwright Chromium', available: true, profileSupported: false },
    ]);
    for (const browser of browsers) expect(browser.profilePath).toBeUndefined();
  });

  it('prefers the *.default-release Firefox profile over earlier entries', async () => {
    const browsers = await detectBrowsers(
      allPresentDeps({ listDir: async () => ['aaaa.default', 'bbbb.default-release', 'cccc'] }),
    );

    const firefox = browsers.find((b) => b.type === 'firefox');
    expect(firefox?.profilePath).toBe(
      winPath('AppData', 'Roaming', 'Mozilla', 'Firefox', 'Profiles', 'bbbb.default-release'),
    );
  });

  it('falls back to the first Firefox profile when no *.default-release exists', async () => {
    const browsers = await detectBrowsers(
      allPresentDeps({ listDir: async () => ['first.default', 'second'] }),
    );

    const firefox = browsers.find((b) => b.type === 'firefox');
    expect(firefox?.profilePath).toBe(
      winPath('AppData', 'Roaming', 'Mozilla', 'Firefox', 'Profiles', 'first.default'),
    );
  });

  it('degrades hung filesystem checks to unavailable instead of hanging or throwing', async () => {
    const never = () => new Promise<never>(() => {});
    const started = Date.now();

    const browsers = await detectBrowsers(
      allPresentDeps({ pathExists: never, listDir: never, timeoutMs: 10 }),
    );

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(browsers).toEqual([
      { type: 'chromium', name: 'Microsoft Edge', available: false, profileSupported: false },
      { type: 'chromium', name: 'Google Chrome', available: false, profileSupported: false },
      { type: 'firefox', name: 'Firefox', available: false, profileSupported: false },
      { type: 'chromium', name: 'Playwright Chromium', available: true, profileSupported: false },
    ]);
  });

  it('uses posix locations and joining for linux', async () => {
    const home = '/home/test';
    const browsers = await detectBrowsers({
      platform: 'linux',
      homedir: () => home,
      pathExists: async (p) => p === '/home/test/.config/google-chrome/Default',
      listDir: async () => [],
      timeoutMs: 50,
    });

    expect(browsers).toEqual([
      { type: 'chromium', name: 'Microsoft Edge', available: false, profileSupported: false },
      {
        type: 'chromium',
        name: 'Google Chrome',
        available: true,
        profilePath: '/home/test/.config/google-chrome/Default',
        profileSupported: true,
      },
      { type: 'firefox', name: 'Firefox', available: false, profileSupported: false },
      { type: 'chromium', name: 'Playwright Chromium', available: true, profileSupported: false },
    ]);
  });

  it('checks darwin Application Support locations', async () => {
    const seen: string[] = [];
    await detectBrowsers({
      platform: 'darwin',
      homedir: () => '/Users/test',
      pathExists: async (p) => {
        seen.push(p);
        return false;
      },
      listDir: async (p) => {
        seen.push(p);
        return [];
      },
      timeoutMs: 50,
    });

    expect(seen).toEqual(
      expect.arrayContaining([
        '/Users/test/Library/Application Support/Microsoft Edge/Default',
        '/Users/test/Library/Application Support/Google/Chrome/Default',
        '/Users/test/Library/Application Support/Firefox/Profiles',
      ]),
    );
  });

  it('offers only Playwright Chromium on unknown platforms', async () => {
    const pathExists = vi.fn(async () => true);
    const browsers = await detectBrowsers(
      allPresentDeps({ platform: 'freebsd', pathExists }),
    );

    expect(pathExists).not.toHaveBeenCalled();
    expect(browsers).toEqual([
      { type: 'chromium', name: 'Playwright Chromium', available: true, profileSupported: false },
    ]);
  });
});

describe('probeProfile', () => {
  const profilePath = 'C:\\Users\\test\\AppData\\Local\\Google\\Chrome\\User Data\\Default';

  it('maps a successful launch-and-close to usable', async () => {
    const close = vi.fn(async () => {});
    const launcher = vi.fn(async () => ({ close }));

    const result = await probeProfile({ browserType: 'chromium', profilePath, launcher });

    expect(result.status).toBe('usable');
    expect(launcher).toHaveBeenCalledWith(profilePath);
    expect(close).toHaveBeenCalledOnce();
  });

  it('maps EBUSY launch failures to locked', async () => {
    const result = await probeProfile({
      browserType: 'chromium',
      profilePath,
      launcher: async () => {
        throw new Error('EBUSY: resource busy or locked, open lockfile');
      },
    });

    expect(result.status).toBe('locked');
  });

  it('maps ProcessSingleton launch failures to locked', async () => {
    const result = await probeProfile({
      browserType: 'chromium',
      profilePath,
      launcher: async () => {
        throw new Error('Failed to create a ProcessSingleton for your profile directory.');
      },
    });

    expect(result.status).toBe('locked');
  });

  it('maps "profile is in use" launch failures to locked', async () => {
    const result = await probeProfile({
      browserType: 'firefox',
      profilePath,
      launcher: async () => {
        throw new Error('The profile is already in use by another Firefox instance');
      },
    });

    expect(result.status).toBe('locked');
  });

  it('maps ENOENT launch failures to no_profile', async () => {
    const result = await probeProfile({
      browserType: 'chromium',
      profilePath: 'C:\\does\\not\\exist',
      launcher: async () => {
        throw new Error('ENOENT: no such file or directory');
      },
    });

    expect(result.status).toBe('no_profile');
  });

  it('maps unrecognized failures to error and includes the message', async () => {
    const result = await probeProfile({
      browserType: 'chromium',
      profilePath,
      launcher: async () => {
        throw new Error('kaboom: unexpected driver crash');
      },
    });

    expect(result.status).toBe('error');
    expect(result.message).toContain('kaboom');
  });

  it('never rejects even when the launcher throws non-Error values', async () => {
    const result = await probeProfile({
      browserType: 'chromium',
      profilePath,
      launcher: async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'string failure';
      },
    });

    expect(result.status).toBe('error');
    expect(result.message).toContain('string failure');
  });
});
