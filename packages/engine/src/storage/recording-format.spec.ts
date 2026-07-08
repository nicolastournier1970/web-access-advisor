import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RecordingV2 } from '@waa/shared';
import { loadRecording, loadRecordingFile, saveRecording } from './recording-format.js';

const here = path.dirname(fileURLToPath(import.meta.url));
/** Repo-root snapshots dir with real legacy v1 recordings (may be absent in CI). */
const snapshotsDir = path.resolve(here, '../../../../snapshots');
const goldenPath = path.join(snapshotsDir, 'session_1755656440621_9w7pfo5ce', 'recording.json');

describe('loadRecording — v1 upgrade (golden fixture)', () => {
  it.skipIf(!existsSync(goldenPath))('upgrades the real legacy recording to v2', async () => {
    const recording = await loadRecordingFile(goldenPath);

    expect(recording.formatVersion).toBe(2);
    expect(recording.sessionId).toBe('session_1755656440621_9w7pfo5ce');
    expect(recording.actions).toHaveLength(6);
    expect(recording.authCheckpoints).toEqual([]);

    // Click actions carried a v1 selector → single css candidate.
    const clicks = recording.actions.filter((a) => a.type === 'click');
    expect(clicks).toHaveLength(2);
    expect(clicks.map((a) => a.target)).toEqual([
      { candidates: [{ strategy: 'css', value: '.l_fill-height' }] },
      { candidates: [{ strategy: 'css', value: '.c_breadcrumb__link' }] },
    ]);
    // Legacy selector mirror preserved.
    expect(clicks.map((a) => a.selector)).toEqual(['.l_fill-height', '.c_breadcrumb__link']);

    // Selector-less navigations get no target; nothing is redacted in v1.
    const navigations = recording.actions.filter((a) => a.type === 'navigate');
    expect(navigations).toHaveLength(4);
    for (const nav of navigations) expect(nav.target).toBeUndefined();
    for (const action of recording.actions) expect(action.redacted).toBe(false);
  });
});

describe('loadRecording — every legacy recording on disk', () => {
  it.skipIf(!existsSync(snapshotsDir))('upgrades all snapshots/*/recording.json', async () => {
    const entries = await readdir(snapshotsDir, { withFileTypes: true });
    const failures: Array<{ session: string; error: string }> = [];
    let upgraded = 0;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = path.join(snapshotsDir, entry.name, 'recording.json');
      if (!existsSync(file)) continue;
      try {
        const recording = await loadRecordingFile(file);
        expect(recording.formatVersion).toBe(2);
        expect(Array.isArray(recording.authCheckpoints)).toBe(true);
        upgraded += 1;
      } catch (error) {
        failures.push({
          session: entry.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    expect(failures).toEqual([]);
    expect(upgraded).toBeGreaterThan(0);
  });
});

describe('saveRecording / loadRecordingFile roundtrip (v2)', () => {
  const v2Recording: RecordingV2 = {
    formatVersion: 2,
    sessionId: 'session_test_v2',
    sessionName: 'Roundtrip fixture',
    url: 'https://example.com/app',
    startTime: '2026-07-07T00:00:00.000Z',
    endTime: '2026-07-07T00:01:00.000Z',
    duration: 60_000,
    actionCount: 2,
    actions: [
      {
        type: 'navigate',
        step: 1,
        timestamp: '2026-07-07T00:00:01.000Z',
        url: 'https://example.com/app',
        redacted: false,
      },
      {
        type: 'fill',
        step: 2,
        timestamp: '2026-07-07T00:00:30.000Z',
        target: {
          candidates: [
            { strategy: 'testid', attribute: 'data-testid', value: 'search' },
            { strategy: 'css', value: '#search' },
          ],
          description: 'Search box',
        },
        selector: '#search',
        value: '[REDACTED]',
        redacted: true,
      },
    ],
    authCheckpoints: [
      {
        id: 'cp-1',
        afterStep: 1,
        reason: 'user-marked',
        loginUrl: 'https://login.example.com/',
        postLoginUrl: 'https://example.com/app',
        storageStateSaved: true,
        startedAt: '2026-07-07T00:00:10.000Z',
        completedAt: '2026-07-07T00:00:25.000Z',
      },
    ],
    browserType: 'chromium',
    useProfile: false,
  };

  it('writes pretty JSON and reads back an identical recording', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'waa-recording-'));
    try {
      const file = path.join(tmp, 'recording.json');
      await saveRecording(file, v2Recording);

      const text = await readFile(file, 'utf8');
      expect(text).toContain('\n  "formatVersion": 2'); // pretty-printed

      const loaded = await loadRecordingFile(file);
      expect(loaded).toEqual(v2Recording);
      expect(loaded.authCheckpoints).toHaveLength(1);
      expect(loaded.authCheckpoints[0]?.reason).toBe('user-marked');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('refuses to save a schema-invalid recording', async () => {
    const broken = {
      ...v2Recording,
      actions: [{ type: 'explode', step: 0 }],
    } as unknown as RecordingV2;
    await expect(saveRecording(path.join(os.tmpdir(), 'never.json'), broken)).rejects.toThrow(
      /Refusing to save invalid v2 recording \(session session_test_v2\)/,
    );
  });
});

describe('loadRecording — v1 credential redaction (security regression)', () => {
  const v1Base = {
    sessionId: 's_v1_creds',
    url: 'https://app.example.test/',
    startTime: '2025-08-20T02:20:41.024Z',
    actions: [] as Array<Record<string, unknown>>,
  };
  const fill = (selector: string, value: string, metadata?: Record<string, unknown>) => ({
    type: 'fill',
    step: 1,
    timestamp: '2025-08-20T02:20:42.000Z',
    selector,
    value,
    ...(metadata ? { metadata } : {}),
  });

  it('redacts fills whose selector looks credential-like', () => {
    for (const selector of ['#password', 'input[name=pwd]', '.otp-code', '#session-token']) {
      const upgraded = loadRecording({ ...v1Base, actions: [fill(selector, 'hunter2')] });
      expect(upgraded.actions[0].value, selector).toBe('[REDACTED]');
      expect(upgraded.actions[0].redacted, selector).toBe(true);
    }
  });

  it('redacts fills whose metadata marks a password input', () => {
    const upgraded = loadRecording({
      ...v1Base,
      actions: [fill('.field-3', 'hunter2', { inputType: 'password' })],
    });
    expect(upgraded.actions[0].value).toBe('[REDACTED]');
    expect(upgraded.actions[0].redacted).toBe(true);
  });

  it('leaves ordinary fills and non-fill values untouched', () => {
    const upgraded = loadRecording({
      ...v1Base,
      actions: [
        fill('#name', 'Alice'),
        {
          type: 'click',
          step: 2,
          timestamp: '2025-08-20T02:20:43.000Z',
          selector: '#pin-board',
          value: 'Pin board',
        },
      ],
    });
    expect(upgraded.actions[0].value).toBe('Alice');
    expect(upgraded.actions[0].redacted).toBe(false);
    // clicks capture element text, not user input — never redacted
    expect(upgraded.actions[1].value).toBe('Pin board');
    expect(upgraded.actions[1].redacted).toBe(false);
  });
});

describe('loadRecording — rejection paths', () => {
  it('rejects garbage input with a descriptive error', () => {
    expect(() => loadRecording('garbage')).toThrow(/Invalid v1 recording/);
    expect(() => loadRecording(null)).toThrow(/Invalid v1 recording/);
    expect(() => loadRecording({ foo: 1 })).toThrow(/sessionId/);
  });

  it('includes the sessionId in errors when parseable', () => {
    expect(() => loadRecording({ sessionId: 'session_bad', actions: 'nope' })).toThrow(
      /\(session session_bad\)/,
    );
    expect(() =>
      loadRecording({ formatVersion: 2, sessionId: 'session_bad_v2', actions: [] }),
    ).toThrow(/Invalid v2 recording \(session session_bad_v2\)/);
  });

  it('rejects unknown formatVersion values explicitly', () => {
    expect(() => loadRecording({ formatVersion: 3, sessionId: 's3' })).toThrow(
      /Unsupported recording formatVersion 3 \(session s3\)/,
    );
  });
});
