import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureSessionDir, sessionPaths } from './session-files.js';

describe('sessionPaths', () => {
  const paths = sessionPaths('/snapshots', 'session_abc');

  it('builds absolute well-known file paths under the session root', () => {
    expect(path.isAbsolute(paths.root)).toBe(true);
    expect(paths.root.endsWith(path.join('snapshots', 'session_abc'))).toBe(true);
    expect(paths.recording).toBe(path.join(paths.root, 'recording.json'));
    expect(paths.storageState).toBe(path.join(paths.root, 'storageState.json'));
    expect(paths.manifest).toBe(path.join(paths.root, 'manifest.json'));
    expect(paths.analysis).toBe(path.join(paths.root, 'analysis.json'));
    expect(paths.sessionMeta).toBe(path.join(paths.root, 'session.json'));
  });

  it('resolves a relative snapshotsDir against cwd', () => {
    const rel = sessionPaths('snapshots', 's1');
    expect(path.isAbsolute(rel.root)).toBe(true);
  });

  it('zero-pads step directories to three digits (legacy step_NNN)', () => {
    expect(path.basename(paths.stepDir(1))).toBe('step_001');
    expect(path.basename(paths.stepDir(12))).toBe('step_012');
    expect(path.basename(paths.stepDir(123))).toBe('step_123');
    expect(path.basename(paths.stepDir(1234))).toBe('step_1234');
    expect(paths.stepDir(7)).toBe(path.join(paths.root, 'step_007'));
  });

  it('rejects non-integer or negative step numbers', () => {
    expect(() => paths.stepDir(-1)).toThrow(/Invalid step/);
    expect(() => paths.stepDir(1.5)).toThrow(/Invalid step/);
  });

  it('returns the four legacy capture filenames per step', () => {
    const files = paths.stepFiles(3);
    const dir = paths.stepDir(3);
    expect(files.snapshot).toBe(path.join(dir, 'snapshot.html'));
    expect(files.axeResults).toBe(path.join(dir, 'axe_results.json'));
    expect(files.axeContext).toBe(path.join(dir, 'axe_context.json'));
    expect(files.screenshot).toBe(path.join(dir, 'screenshot.png'));
  });
});

describe('ensureSessionDir', () => {
  it('creates the session root recursively and is idempotent', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'waa-session-files-'));
    try {
      const paths = sessionPaths(path.join(tmp, 'nested', 'snapshots'), 'session_x');
      expect(existsSync(paths.root)).toBe(false);
      await ensureSessionDir(paths);
      expect(existsSync(paths.root)).toBe(true);
      await ensureSessionDir(paths); // second call must not throw
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
