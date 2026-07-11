import { describe, it, expect } from 'vitest';
import { resolveSystemChannel } from './system-engine.js';

const WIN_ENV = {
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  LOCALAPPDATA: 'C:\\Users\\t\\AppData\\Local',
};

describe('resolveSystemChannel', () => {
  it('prefers msedge over chrome when both are present (win32)', async () => {
    const channel = await resolveSystemChannel({
      platform: 'win32',
      env: WIN_ENV,
      pathExists: async () => true, // both exist
    });
    expect(channel).toBe('msedge');
  });

  it('falls back to chrome when only chrome is present (win32)', async () => {
    const channel = await resolveSystemChannel({
      platform: 'win32',
      env: WIN_ENV,
      pathExists: async (p) => p.toLowerCase().includes('chrome'),
    });
    expect(channel).toBe('chrome');
  });

  it('returns undefined when neither is installed', async () => {
    const channel = await resolveSystemChannel({
      platform: 'win32',
      env: WIN_ENV,
      pathExists: async () => false,
    });
    expect(channel).toBeUndefined();
  });

  it('resolves darwin paths', async () => {
    const channel = await resolveSystemChannel({
      platform: 'darwin',
      pathExists: async (p) => p.includes('Microsoft Edge'),
    });
    expect(channel).toBe('msedge');
  });

  it('never throws when the probe rejects', async () => {
    const channel = await resolveSystemChannel({
      platform: 'linux',
      pathExists: async () => {
        throw new Error('EACCES');
      },
    });
    expect(channel).toBeUndefined();
  });
});
