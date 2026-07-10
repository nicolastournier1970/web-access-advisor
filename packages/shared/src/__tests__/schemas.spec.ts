/**
 * Contract tests: the schemas must accept the real artefacts the legacy app
 * left on disk (v1 recordings, manifests, config) and enforce the v2 rules.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  actionV2Schema,
  authDomainsConfigSchema,
  axeViolationSchema,
  componentIssueSchema,
  errorResponseSchema,
  llmAnalysisSchema,
  recordingV1Schema,
  recordingV2Schema,
  sessionManifestSchema,
  sseEventSchema,
  startRecordingRequestSchema,
} from '../index.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const snapshotsDir = path.join(repoRoot, 'snapshots');
const goldenSession = path.join(snapshotsDir, 'session_1755656440621_9w7pfo5ce');

const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf-8'));

describe('recordingV1Schema (legacy files)', () => {
  it.skipIf(!existsSync(path.join(goldenSession, 'recording.json')))(
    'parses the golden v1 recording from disk',
    () => {
      const parsed = recordingV1Schema.parse(readJson(path.join(goldenSession, 'recording.json')));
      expect(parsed.sessionId).toBe('session_1755656440621_9w7pfo5ce');
      expect(parsed.actions.length).toBe(6);
      expect(parsed.actions[0].type).toBe('navigate');
    },
  );

  it.skipIf(!existsSync(snapshotsDir))('parses every recording.json under snapshots/', () => {
    // The live snapshots dir is user data: it can hold v1 (legacy) AND v2
    // (new recorder) files, or be empty. Route each file by its discriminator.
    const sessions = readdirSync(snapshotsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(snapshotsDir, d.name, 'recording.json'))
      .filter((p) => existsSync(p));
    for (const file of sessions) {
      const raw = readJson(file) as { formatVersion?: unknown };
      const schema = raw.formatVersion === 2 ? recordingV2Schema : recordingV1Schema;
      const result = schema.safeParse(raw);
      expect(result.success, `${file}: ${result.success ? '' : result.error.message}`).toBe(true);
    }
  });

  it('rejects objects that carry formatVersion (those are v2)', () => {
    // Fixture-free: a schema-valid v1 shape gains formatVersion → must fail.
    const v1 = {
      sessionId: 's_v1',
      url: 'https://example.test/',
      startTime: '2025-08-20T02:20:41.024Z',
      actions: [{ type: 'navigate', step: 1, timestamp: '2025-08-20T02:20:41.398Z', url: 'https://example.test/' }],
    };
    expect(recordingV1Schema.safeParse(v1).success).toBe(true);
    expect(recordingV1Schema.safeParse({ ...v1, formatVersion: 2 }).success).toBe(false);
  });
});

describe('recordingV2Schema', () => {
  const minimalV2 = {
    formatVersion: 2,
    sessionId: 's1',
    url: 'https://example.test/',
    startTime: '2026-07-07T00:00:00.000Z',
    actions: [
      {
        type: 'click',
        step: 1,
        timestamp: '2026-07-07T00:00:01.000Z',
        target: {
          candidates: [
            { strategy: 'role', role: 'button', name: 'Submit' },
            { strategy: 'css', value: 'form button.primary' },
          ],
          description: 'Submit button',
        },
        selector: 'form button.primary',
      },
    ],
    authCheckpoints: [
      {
        id: 'acp_1',
        afterStep: 1,
        reason: 'user-marked',
        loginUrl: 'https://idp.example.test/login',
        storageStateSaved: true,
        startedAt: '2026-07-07T00:00:02.000Z',
        completedAt: '2026-07-07T00:00:30.000Z',
      },
    ],
  };

  it('accepts a v2 recording with target candidates and an auth checkpoint', () => {
    const parsed = recordingV2Schema.parse(minimalV2);
    expect(parsed.authCheckpoints[0].afterStep).toBe(1);
    expect(parsed.actions[0].redacted).toBe(false); // defaulted
  });

  it('rejects unknown locator strategies', () => {
    const bad = structuredClone(minimalV2) as Record<string, unknown>;
    (bad as any).actions[0].target.candidates[0] = { strategy: 'xpath', value: '//button' };
    expect(recordingV2Schema.safeParse(bad).success).toBe(false);
  });

  it('marks redacted values', () => {
    const action = actionV2Schema.parse({
      type: 'fill',
      step: 2,
      timestamp: '2026-07-07T00:00:03.000Z',
      selector: '#password',
      value: '[REDACTED]',
      redacted: true,
    });
    expect(action.redacted).toBe(true);
  });
});

describe('sessionManifestSchema (legacy files)', () => {
  it.skipIf(!existsSync(snapshotsDir))('parses every manifest.json under snapshots/', () => {
    // User data: sessions can be deleted via the UI, so zero manifests is legal.
    const manifests = readdirSync(snapshotsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(snapshotsDir, d.name, 'manifest.json'))
      .filter((p) => existsSync(p));
    for (const file of manifests) {
      const result = sessionManifestSchema.safeParse(readJson(file));
      expect(result.success, `${file}: ${result.success ? '' : result.error.message}`).toBe(true);
    }
  });
});

describe('authDomainsConfigSchema', () => {
  it('parses config/auth-domains.json', () => {
    const parsed = authDomainsConfigSchema.parse(
      readJson(path.join(repoRoot, 'config', 'auth-domains.json')),
    );
    expect(parsed.authDomains).toContain('auth.identity.gov.au');
    expect(parsed.clientDomains).toContain('hbsp-test.powerappsportals.com');
  });
});

describe('analysis leniency (review findings)', () => {
  it('accepts the legacy object form of wcagReference on enriched axe violations', () => {
    const v = axeViolationSchema.parse({
      id: 'color-contrast',
      impact: 'serious',
      wcagReference: { guideline: '1.4.3', level: 'AA', title: 'Contrast (Minimum)', url: 'https://w3.org/...' },
    });
    expect(v.wcagReference?.guideline).toBe('1.4.3');
  });

  it('accepts shadow-DOM axe node targets (nested string arrays)', () => {
    const v = axeViolationSchema.parse({
      id: 'label',
      nodes: [{ html: '<input>', target: ['my-app', ['#shadow-host', 'input.inner']] }],
    });
    expect(v.nodes[0].target.length).toBe(2);
  });

  it('degrades off-vocabulary LLM impact instead of failing the parse', () => {
    expect(componentIssueSchema.parse({ componentName: 'C', issue: 'x', impact: 'Critical' }).impact)
      .toBe('moderate');
    expect(componentIssueSchema.parse({ componentName: 'C', issue: 'x' }).impact).toBe('moderate');
  });

  it('clamps out-of-range LLM scores and degrades non-numeric ones', () => {
    expect(llmAnalysisSchema.parse({ score: 105 }).score).toBe(100);
    expect(llmAnalysisSchema.parse({ score: -3 }).score).toBe(0);
    expect(llmAnalysisSchema.parse({ score: 'high' }).score).toBe(0);
  });
});

describe('request hardening (review findings)', () => {
  it('rejects non-http(s) recording targets', () => {
    const base = { browserType: 'chromium' as const };
    expect(startRecordingRequestSchema.safeParse({ ...base, url: 'javascript:alert(1)' }).success).toBe(false);
    expect(startRecordingRequestSchema.safeParse({ ...base, url: 'file:///C:/x.html' }).success).toBe(false);
    expect(startRecordingRequestSchema.safeParse({ ...base, url: 'http://localhost:4300/a?b=1' }).success).toBe(true);
  });

  it('parses a Nest-style error envelope', () => {
    const err = errorResponseSchema.parse({
      statusCode: 400,
      error: 'Bad Request',
      message: 'Validation failed',
      details: [{ path: ['url'], message: 'Invalid URL', code: 'invalid_format' }],
    });
    expect(err.statusCode).toBe(400);
  });
});

describe('sseEventSchema', () => {
  it('accepts a recording.action event', () => {
    const event = sseEventSchema.parse({
      type: 'recording.action',
      actionCount: 3,
      action: { type: 'navigate', step: 3, timestamp: '2026-07-07T00:00:00Z', url: 'https://x.test' },
    });
    expect(event.type).toBe('recording.action');
  });

  it('accepts replay.auth_required with a recorded checkpoint', () => {
    const event = sseEventSchema.parse({
      type: 'replay.auth_required',
      checkpointId: 'acp_1',
      reason: 'recorded-checkpoint',
      loginUrl: 'https://idp.example.test/login',
      pausedAtStep: 4,
      timeoutAt: '2026-07-07T00:10:00.000Z',
    });
    expect(event.type).toBe('replay.auth_required');
  });

  it('accepts recording.warning (trust-critical degradation notice)', () => {
    const event = sseEventSchema.parse({
      type: 'recording.warning',
      message: 'Profile locked — recording with a clean browser',
      reason: 'profile-unavailable',
    });
    expect(event.type).toBe('recording.warning');
    expect(
      sseEventSchema.safeParse({ type: 'recording.warning', message: 'x', reason: 'bogus' })
        .success,
    ).toBe(false);
  });

  it('rejects unknown event types', () => {
    expect(sseEventSchema.safeParse({ type: 'bogus.event' }).success).toBe(false);
  });
});
