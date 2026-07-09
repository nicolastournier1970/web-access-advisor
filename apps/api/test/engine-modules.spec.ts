/**
 * Engine-backed module tests: sessions, recording, analysis + replay-auth,
 * browsers, storage-state — all against a FAKE engine (no browsers) and a
 * temp snapshots dir, over the compiled dist build.
 */
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { firstValueFrom } from 'rxjs';
import { filter, take, toArray } from 'rxjs/operators';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  analysisResultSchema,
  listSessionsResponseSchema,
  sessionSummarySchema,
  startRecordingResponseSchema,
  stopRecordingResponseSchema,
} from '@waa/shared';
import { AppModule } from '../dist/app.module.js';
import { configureApp } from '../dist/app.factory.js';
import { ENGINE } from '../dist/engine/engine.module.js';
import { ENV, loadEnv } from '../dist/config/env.js';
import { SessionEventsService } from '../dist/events/session-events.service.js';

// ---------------------------------------------------------------------------
// Fixtures + fakes
// ---------------------------------------------------------------------------

const NOW = '2026-07-08T00:00:00.000Z';

function minimalRecording(sessionId: string) {
  return {
    formatVersion: 2,
    sessionId,
    url: 'https://app.example.test/',
    startTime: NOW,
    endTime: NOW,
    actions: [
      { type: 'navigate', step: 1, timestamp: NOW, url: 'https://app.example.test/', redacted: false },
    ],
    authCheckpoints: [],
  };
}

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function makeFakeEngine() {
  const recorderEvents: { onEvent?: (e: unknown) => void } = {};
  const analyzeEvents: { onEvent?: (e: unknown) => void } = {};
  const analysisResult = deferred<Record<string, unknown>>();

  const recorderHandle = {
    sessionId: 'fake',
    currentUrl: vi.fn(async () => 'https://app.example.test/'),
    getActions: vi.fn(() => []),
    startAuthSegment: vi.fn(async (reason: string, fromStep?: number) => ({
      checkpoint: {
        id: 'acp_1',
        afterStep: fromStep ?? 1,
        reason,
        storageStateSaved: false,
        startedAt: NOW,
      },
      discardedActions: fromStep !== undefined ? 1 : 0,
    })),
    endAuthSegment: vi.fn(async () => ({
      checkpoint: {
        id: 'acp_1',
        afterStep: 1,
        reason: 'user-marked',
        storageStateSaved: true,
        startedAt: NOW,
        completedAt: NOW,
      },
      storageStateSaved: true,
      postLoginUrl: 'https://app.example.test/home',
    })),
    stop: vi.fn(async () => minimalRecording('overridden-below')),
    dispose: vi.fn(async () => {}),
  };

  const control = {
    continueAuth: vi.fn(async () => ({ ok: true })),
    cancelAuth: vi.fn(async () => {}),
    result: analysisResult.promise,
  };

  class FakeProvider {
    name = 'stub';
    async analyzeBatch() {
      return { summary: '', components: [], recommendations: [], score: 0 };
    }
    async consolidate() {
      return { summary: '', components: [], recommendations: [], score: 0 };
    }
  }

  const engine = {
    createRecorder: vi.fn(async (opts: { sessionId: string; onEvent: (e: unknown) => void }) => {
      recorderEvents.onEvent = opts.onEvent;
      recorderHandle.stop = vi.fn(async () => minimalRecording(opts.sessionId));
      return recorderHandle;
    }),
    runAnalysis: vi.fn((opts: { onEvent: (e: unknown) => void }) => {
      analyzeEvents.onEvent = opts.onEvent;
      return control;
    }),
    detectBrowsers: vi.fn(async () => [
      { type: 'chromium', name: 'Playwright Chromium', available: true, profileSupported: false },
      {
        type: 'chromium',
        name: 'Microsoft Edge',
        available: true,
        profilePath: 'C:\\fake\\edge-profile',
        profileSupported: true,
      },
    ]),
    probeProfile: vi.fn(async () => ({ status: 'usable', message: 'profile launched cleanly' })),
    getStorageStateStatus: vi.fn(async () => ({
      present: true,
      expired: false,
      earliestExpiry: '2027-01-01T00:00:00.000Z',
      message: 'ok',
    })),
    validateStorageState: vi.fn(async () => ({ ok: true, elapsedMs: 42 })),
    loadRecordingFile: vi.fn(async () => minimalRecording('any')),
    loadAuthDomainsConfig: vi.fn(async () => ({
      authDomains: [],
      clientDomains: [],
      authPathPatterns: [],
    })),
    isAuthUrl: vi.fn(() => false),
    sessionPaths: vi.fn(),
    GeminiProvider: FakeProvider,
    StubProvider: FakeProvider,
  };

  return { engine, recorderHandle, recorderEvents, analyzeEvents, control, analysisResult };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('engine-backed modules (fake engine, tmp snapshots dir)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let events: SessionEventsService;
  let snapshotsDir: string;
  const fake = makeFakeEngine();

  beforeAll(async () => {
    snapshotsDir = await mkdtemp(path.join(os.tmpdir(), 'waa-api-test-'));

    // Legacy session fixture: recording.json only (v1) + manifest.json marker.
    const legacyDir = path.join(snapshotsDir, 'session_1000_legacy');
    await mkdir(path.join(legacyDir, 'step_001'), { recursive: true });
    await writeFile(
      path.join(legacyDir, 'recording.json'),
      JSON.stringify({
        sessionId: 'session_1000_legacy',
        sessionName: 'Legacy one',
        url: 'https://legacy.example.test/',
        startTime: NOW,
        actions: [{ type: 'navigate', step: 1, timestamp: NOW, url: 'https://legacy.example.test/' }],
      }),
    );
    await writeFile(path.join(legacyDir, 'manifest.json'), '{}');
    await writeFile(path.join(legacyDir, 'storageState.json'), '{"cookies":[],"origins":[]}');
    await writeFile(path.join(legacyDir, 'step_001', 'snapshot.html'), '<html><body>x</body></html>');

    const env = {
      ...loadEnv({ NODE_ENV: 'test' }),
      SNAPSHOTS_DIR: snapshotsDir,
      PLAYWRIGHT_HEADLESS: true,
      LLM_PROVIDER: 'stub' as const,
    };

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ENGINE)
      .useValue(fake.engine)
      .overrideProvider(ENV)
      .useValue(env)
      .compile();

    app = configureApp(moduleRef.createNestApplication({ logger: false }));
    await app.init();
    http = app.getHttpServer();
    events = moduleRef.get(SessionEventsService);
  });

  afterAll(async () => {
    await app.close();
  });

  // ---- sessions ----

  it('lists legacy sessions folded from disk', async () => {
    const res = await request(http).get('/api/sessions').expect(200);
    const parsed = listSessionsResponseSchema.parse(res.body);
    const legacy = parsed.sessions.find((s) => s.sessionId === 'session_1000_legacy');
    expect(legacy).toBeDefined();
    expect(legacy).toMatchObject({
      status: 'analyzed',
      hasAnalysis: true,
      hasStorageState: true,
      recordingFormatVersion: 1,
      actionCount: 1,
      name: 'Legacy one',
    });
  });

  it('404s unknown sessions and serves only whitelisted snapshot files', async () => {
    await request(http).get('/api/sessions/nope').expect(404);
    await request(http)
      .get('/api/sessions/session_1000_legacy/snapshots/1/snapshot.html')
      .expect(200)
      .expect('content-type', /text\/html/);
    await request(http)
      .get('/api/sessions/session_1000_legacy/snapshots/1/..%2F..%2Frecording.json')
      .expect(404);
    await request(http)
      .get('/api/sessions/session_1000_legacy/snapshots/1/secrets.txt')
      .expect(404);
  });

  // ---- recording flow ----

  let sessionId: string;

  it('starts a recording, streams events, marks a login segment, and stops', async () => {
    const startRes = await request(http)
      .post('/api/sessions')
      .send({ url: 'https://app.example.test/', browserType: 'chromium', useProfile: false })
      .expect(201);
    const start = startRecordingResponseSchema.parse(startRes.body);
    sessionId = start.sessionId;
    expect(start.status).toBe('recording');
    expect(fake.engine.createRecorder).toHaveBeenCalledOnce();

    // Engine emits an action -> SSE recording.action appears on the stream.
    const collected = firstValueFrom(
      events.stream(sessionId).pipe(
        filter((m) => typeof m.data === 'object'),
        take(3),
        toArray(),
      ),
    );
    fake.recorderEvents.onEvent!({
      type: 'action',
      action: { type: 'click', step: 1, timestamp: NOW, selector: '#go', redacted: false },
      actionCount: 1,
    });
    fake.recorderEvents.onEvent!({ type: 'navigated', url: 'https://app.example.test/next' });
    const messages = await collected;
    const types = messages.map((m) => (m.data as { type: string }).type);
    expect(types).toContain('session.status');
    expect(types).toContain('recording.action');
    expect(types).toContain('recording.navigated');

    // Login segment endpoints proxy to the handle.
    const seg = await request(http)
      .post(`/api/sessions/${sessionId}/recording/auth/start`)
      .send({ reason: 'user-marked' })
      .expect(200);
    expect(seg.body.checkpointId).toBe('acp_1');
    const end = await request(http)
      .post(`/api/sessions/${sessionId}/recording/auth/end`)
      .send({})
      .expect(200);
    expect(end.body.storageStateSaved).toBe(true);

    const stopRes = await request(http)
      .post(`/api/sessions/${sessionId}/recording/stop`)
      .expect(200);
    const stop = stopRecordingResponseSchema.parse(stopRes.body);
    expect(stop.status).toBe('recorded');
    expect(stop.actionCount).toBe(1);

    const summary = sessionSummarySchema.parse(
      (await request(http).get(`/api/sessions/${sessionId}`).expect(200)).body,
    );
    expect(summary.status).toBe('recorded');
  });

  it('maps engine launch warnings to recording.warning on the stream', async () => {
    const started = startRecordingResponseSchema.parse(
      (
        await request(http)
          .post('/api/sessions')
          .send({ url: 'https://app.example.test/', browserType: 'chromium', useProfile: true })
          .expect(201)
      ).body,
    );
    const collected = firstValueFrom(
      events.stream(started.sessionId).pipe(
        filter((m) => (m.data as { type?: string }).type === 'recording.warning'),
        take(1),
      ),
    );
    fake.recorderEvents.onEvent!({
      type: 'warning',
      message: 'Profile locked — recording with a clean browser',
      reason: 'profile-unavailable',
    });
    const message = await collected;
    expect(message.data).toMatchObject({
      type: 'recording.warning',
      reason: 'profile-unavailable',
    });
    await request(http).post(`/api/sessions/${started.sessionId}/recording/stop`).expect(200);
  });

  it('409s recording controls when no live recording exists', async () => {
    await request(http).post(`/api/sessions/${sessionId}/recording/stop`).expect(409);
    await request(http)
      .post(`/api/sessions/${sessionId}/recording/auth/start`)
      .send({})
      .expect(409);
  });

  it('rejects non-http(s) target urls with the shared error envelope', async () => {
    const res = await request(http)
      .post('/api/sessions')
      .send({ url: 'javascript:alert(1)' })
      .expect(400);
    expect(res.body.statusCode).toBe(400);
    expect(res.body.details ?? res.body.message).toBeDefined();
  });

  // ---- analysis + pause-for-login ----

  it('runs an analysis with pause-for-login continue, then completes', async () => {
    // Self-contained: record + stop a fresh session, then create the
    // recording.json the service checks (the fake engine writes nothing).
    if (!sessionId) {
      const started = startRecordingResponseSchema.parse(
        (
          await request(http)
            .post('/api/sessions')
            .send({ url: 'https://app.example.test/', browserType: 'chromium' })
            .expect(201)
        ).body,
      );
      sessionId = started.sessionId;
      await request(http).post(`/api/sessions/${sessionId}/recording/stop`).expect(200);
    }
    await writeFile(
      path.join(snapshotsDir, sessionId, 'recording.json'),
      JSON.stringify(minimalRecording(sessionId)),
    );

    const startRes = await request(http)
      .post(`/api/sessions/${sessionId}/analysis`)
      .send({})
      .expect(202);
    expect(startRes.body.analysisId).toBe(sessionId);
    expect(fake.engine.runAnalysis).toHaveBeenCalledOnce();

    // Replay-auth endpoints 409 for OTHER sessions but work for this one.
    await request(http).post('/api/sessions/other/replay/auth/continue').expect(409);

    // Engine pauses for login -> status flips to awaiting-auth.
    fake.analyzeEvents.onEvent!({ type: 'auth-state', state: 'auth_required' });
    fake.analyzeEvents.onEvent!({
      type: 'auth-required',
      reason: 'login-wall-detected',
      loginUrl: 'https://idp.example.test/login',
      pausedAtStep: 1,
      timeoutAt: '2026-07-08T00:10:00.000Z',
    });
    // session.json is eventually-consistent (SSE is the live channel); the
    // engine event handler patches it fire-and-forget — allow the write to flush.
    await new Promise((r) => setTimeout(r, 50));
    const paused = sessionSummarySchema.parse(
      (await request(http).get(`/api/sessions/${sessionId}`).expect(200)).body,
    );
    expect(paused.status).toBe('awaiting-auth');

    // User clicks Continue -> control.continueAuth() and state reflects events.
    fake.analyzeEvents.onEvent!({ type: 'auth-state', state: 'running' });
    const cont = await request(http)
      .post(`/api/sessions/${sessionId}/replay/auth/continue`)
      .expect(200);
    expect(fake.control.continueAuth).toHaveBeenCalledOnce();
    expect(cont.body.state).toBe('running');

    // Engine finishes -> analysis.complete + status analyzed + result readable.
    await writeFile(
      path.join(snapshotsDir, sessionId, 'analysis.json'),
      JSON.stringify({
        success: true,
        sessionId,
        snapshotCount: 1,
        manifest: {
          sessionId,
          url: 'https://app.example.test/',
          timestamp: NOW,
          totalSteps: 1,
          stepDetails: [],
        },
        axeResults: [],
        warnings: [],
      }),
    );
    fake.analysisResult.resolve({
      success: true,
      sessionId,
      snapshotCount: 1,
      manifest: { sessionId, url: 'https://app.example.test/', timestamp: NOW, totalSteps: 1 },
      axeResults: [],
      warnings: [],
    });
    await new Promise((r) => setTimeout(r, 50)); // let the result handler settle

    const analyzed = sessionSummarySchema.parse(
      (await request(http).get(`/api/sessions/${sessionId}`).expect(200)).body,
    );
    expect(analyzed.status).toBe('analyzed');

    const result = analysisResultSchema.parse(
      (await request(http).get(`/api/sessions/${sessionId}/analysis`).expect(200)).body,
    );
    expect(result.success).toBe(true);
  });

  it('409s deleting a session with a live worker, deletes otherwise', async () => {
    // Start a fresh recording to hold a live worker.
    const live = startRecordingResponseSchema.parse(
      (
        await request(http)
          .post('/api/sessions')
          .send({ url: 'https://app.example.test/', browserType: 'chromium' })
          .expect(201)
      ).body,
    );
    await request(http).delete(`/api/sessions/${live.sessionId}`).expect(409);
    await request(http).post(`/api/sessions/${live.sessionId}/recording/stop`).expect(200);
    await request(http).delete(`/api/sessions/${live.sessionId}`).expect(200);
    expect(existsSync(path.join(snapshotsDir, live.sessionId))).toBe(false);
  });

  // ---- browsers + storage-state ----

  it('lists browsers and probes profiles via the engine', async () => {
    const list = await request(http).get('/api/browsers').expect(200);
    expect(list.body.browsers).toHaveLength(2);
    const probe = await request(http)
      .post('/api/browsers/profile-probe')
      .send({ browserType: 'chromium', browserName: 'Microsoft Edge' })
      .expect(200);
    expect(probe.body.status).toBe('usable');
    await request(http)
      .post('/api/browsers/profile-probe')
      .send({ browserType: 'chromium', browserName: 'Netscape' })
      .expect(400);
  });

  it('reports storage-state status/validate and finds host matches', async () => {
    const status = await request(http)
      .get('/api/sessions/session_1000_legacy/storage-state/status')
      .expect(200);
    expect(status.body).toMatchObject({ sessionId: 'session_1000_legacy', present: true });

    const validate = await request(http)
      .post('/api/sessions/session_1000_legacy/storage-state/validate')
      .send({})
      .expect(200);
    expect(validate.body.ok).toBe(true);

    const find = await request(http)
      .get('/api/storage-state/find')
      .query({ url: 'https://legacy.example.test/some/page' })
      .expect(200);
    expect(find.body.matches.map((m: { sessionId: string }) => m.sessionId)).toContain(
      'session_1000_legacy',
    );

    const none = await request(http)
      .get('/api/storage-state/find')
      .query({ url: 'https://unrelated.example.test/' })
      .expect(200);
    expect(none.body.matches).toHaveLength(0);
  });

  it('404s the SSE stream for unknown sessions, streams for known ones', async () => {
    await request(http).get('/api/sessions/definitely-unknown/events').expect(404);
  });
});
