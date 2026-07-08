import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SseEvent } from '@waa/shared';
import { ApiClient, ApiError } from '../api/api-client';
import { SseClient, type SseConnectionState } from '../api/sse-client';
import { AnnouncerService } from '../a11y/announcer.service';
import { AnalysisStore, boardPhaseFor } from './analysis.store';

const AUTH_REQUIRED: SseEvent = {
  type: 'replay.auth_required',
  reason: 'login-wall-detected',
  loginUrl: 'https://login.example.com/signin',
  pausedAtStep: 3,
  timeoutAt: '2026-07-08T10:10:00.000Z',
};

describe('AnalysisStore', () => {
  let events: Subject<SseEvent>;
  let api: {
    startAnalysis: ReturnType<typeof vi.fn>;
    getAnalysis: ReturnType<typeof vi.fn>;
    continueReplayAuth: ReturnType<typeof vi.fn>;
    cancelReplayAuth: ReturnType<typeof vi.fn>;
  };
  let sse: { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> };
  let announce: ReturnType<typeof vi.fn>;
  let store: AnalysisStore;

  beforeEach(() => {
    events = new Subject<SseEvent>();
    api = {
      startAnalysis: vi.fn(async () => ({
        sessionId: 'sess-1',
        analysisId: 'sess-1',
        status: 'analyzing' as const,
        phase: 'replaying-actions' as const,
      })),
      getAnalysis: vi.fn(async () => ({
        success: true,
        sessionId: 'sess-1',
        snapshotCount: 2,
        manifest: {
          sessionId: 'sess-1',
          url: 'https://example.com',
          timestamp: '2026-07-08T10:00:00.000Z',
          totalSteps: 2,
          stepDetails: [],
        },
        axeResults: [],
        warnings: [],
      })),
      continueReplayAuth: vi.fn(async () => ({ sessionId: 'sess-1', state: 'resuming' as const })),
      cancelReplayAuth: vi.fn(async () => ({ sessionId: 'sess-1', state: 'cancelled' as const })),
    };
    const connectionState = signal<SseConnectionState>('closed');
    sse = { connect: vi.fn(), disconnect: vi.fn() };
    announce = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        { provide: ApiClient, useValue: api },
        {
          provide: SseClient,
          useValue: {
            connect: sse.connect,
            disconnect: sse.disconnect,
            events$: events.asObservable(),
            connectionState: connectionState.asReadonly(),
          },
        },
        { provide: AnnouncerService, useValue: { announce } },
      ],
    });
    store = TestBed.inject(AnalysisStore);
  });

  async function startAnalysis(): Promise<void> {
    await store.start('sess-1', { llmProvider: 'stub' });
  }

  it('start(): POSTs the options, attaches SSE, seeds the phase', async () => {
    await startAnalysis();
    expect(api.startAnalysis).toHaveBeenCalledWith('sess-1', { llmProvider: 'stub' });
    expect(sse.connect).toHaveBeenCalledWith('sess-1');
    expect(store.running()).toBe(true);
    expect(store.phase()).toBe('replaying-actions');
    expect(store.sessionId()).toBe('sess-1');
  });

  it('start(): failure leaves the store idle and rethrows', async () => {
    api.startAnalysis.mockRejectedValueOnce(new ApiError(409, 'Conflict', 'live worker'));
    await expect(store.start('sess-1')).rejects.toThrow('live worker');
    expect(store.running()).toBe(false);
    expect(sse.connect).not.toHaveBeenCalled();
  });

  it('a progress sequence drives phase, message and counters', async () => {
    await startAnalysis();
    events.next({
      type: 'analysis.progress',
      phase: 'replaying-actions',
      message: 'Replaying action 2 of 6',
      currentStep: 2,
      totalSteps: 6,
    });
    expect(store.phase()).toBe('replaying-actions');
    expect(store.message()).toBe('Replaying action 2 of 6');
    expect(store.currentStep()).toBe(2);
    expect(store.totalSteps()).toBe(6);

    events.next({
      type: 'analysis.progress',
      phase: 'capturing-snapshots',
      message: 'Captured 3 snapshots',
      snapshotCount: 3,
    });
    expect(store.snapshotCount()).toBe(3);
    // Counters from earlier events survive sparse updates.
    expect(store.totalSteps()).toBe(6);

    events.next({
      type: 'analysis.progress',
      phase: 'processing-with-ai',
      message: 'Processing batch 1/2',
      batchCurrent: 1,
      batchTotal: 2,
    });
    expect(store.phase()).toBe('processing-with-ai');
    expect(store.batchCurrent()).toBe(1);
    expect(store.batchTotal()).toBe(2);
  });

  it('announces board-phase transitions once (replay → ai), politely', async () => {
    await startAnalysis();
    events.next({ type: 'analysis.progress', phase: 'replaying-actions', message: 'a' });
    events.next({ type: 'analysis.progress', phase: 'capturing-snapshots', message: 'b' });
    events.next({ type: 'analysis.progress', phase: 'processing-with-ai', message: 'c' });
    const messages = announce.mock.calls.map((call) => call[0] as string);
    expect(messages.filter((m) => m === 'Replay and capture started')).toHaveLength(1);
    expect(messages.filter((m) => m === 'AI analysis started')).toHaveLength(1);
  });

  it('replay.auth_required raises the pause banner and announces it', async () => {
    await startAnalysis();
    events.next(AUTH_REQUIRED);
    expect(store.authPause()).toEqual({
      reason: 'login-wall-detected',
      loginUrl: 'https://login.example.com/signin',
      pausedAtStep: 3,
      timeoutAt: '2026-07-08T10:10:00.000Z',
    });
    expect(announce).toHaveBeenCalledWith(
      'Analysis paused — waiting for you to sign in in the browser window',
    );
  });

  it('continueAuth(): ok keeps validating until auth_resolved clears the banner', async () => {
    await startAnalysis();
    events.next(AUTH_REQUIRED);
    await store.continueAuth();
    expect(api.continueReplayAuth).toHaveBeenCalledWith('sess-1');
    // No reason in the response → still validating, banner still up.
    expect(store.authValidating()).toBe(true);
    expect(store.authPause()).not.toBeNull();

    events.next({ type: 'replay.auth_resolved', resumedAtStep: 3, storageStateSaved: true });
    expect(store.authPause()).toBeNull();
    expect(store.authValidating()).toBe(false);
    expect(store.authFailedReason()).toBeNull();
    expect(announce).toHaveBeenCalledWith('Signed in — analysis resumed');
  });

  it('continueAuth(): !ok keeps the banner up with the failure reason', async () => {
    await startAnalysis();
    events.next(AUTH_REQUIRED);
    api.continueReplayAuth.mockResolvedValueOnce({
      sessionId: 'sess-1',
      state: 'auth_required',
      reason: 'still-on-auth-domain',
    });
    await store.continueAuth();
    expect(store.authValidating()).toBe(false);
    expect(store.authFailedReason()).toBe('still-on-auth-domain');
    expect(store.authPause()).not.toBeNull();
  });

  it('replay.auth_failed (server-pushed) surfaces the reason and keeps the banner', async () => {
    await startAnalysis();
    events.next(AUTH_REQUIRED);
    events.next({ type: 'replay.auth_validating' });
    expect(store.authValidating()).toBe(true);
    events.next({ type: 'replay.auth_failed', reason: 'login-wall-still-present' });
    expect(store.authValidating()).toBe(false);
    expect(store.authFailedReason()).toBe('login-wall-still-present');
    expect(store.authPause()).not.toBeNull();
  });

  it('continueAuth(): transport error surfaces as a failure reason and rethrows', async () => {
    await startAnalysis();
    events.next(AUTH_REQUIRED);
    api.continueReplayAuth.mockRejectedValueOnce(new ApiError(409, 'Conflict', 'no live analysis'));
    await expect(store.continueAuth()).rejects.toThrow('no live analysis');
    expect(store.authValidating()).toBe(false);
    expect(store.authFailedReason()).toBe('no live analysis');
  });

  it('cancelAuth(): POSTs cancel and drops the banner', async () => {
    await startAnalysis();
    events.next(AUTH_REQUIRED);
    await store.cancelAuth();
    expect(api.cancelReplayAuth).toHaveBeenCalledWith('sess-1');
    expect(store.authPause()).toBeNull();
  });

  it('analysis.complete flags completion and stops running', async () => {
    await startAnalysis();
    events.next({
      type: 'analysis.complete',
      analysisId: 'sess-1',
      snapshotCount: 4,
      warnings: [],
    });
    expect(store.completed()).toBe(true);
    expect(store.phase()).toBe('completed');
    expect(store.snapshotCount()).toBe(4);
    expect(store.running()).toBe(false);
    expect(announce).toHaveBeenCalledWith('Analysis complete');
  });

  it('analysis.error sets the error state and clears any pause', async () => {
    await startAnalysis();
    events.next(AUTH_REQUIRED);
    events.next({ type: 'analysis.error', message: 'Replay browser crashed' });
    expect(store.error()).toBe('Replay browser crashed');
    expect(store.running()).toBe(false);
    expect(store.authPause()).toBeNull();
  });

  it('loadResult(): GETs once and caches per session', async () => {
    const result = await store.loadResult('sess-1');
    expect(result.sessionId).toBe('sess-1');
    expect(store.result()).toBe(result);
    await store.loadResult('sess-1');
    expect(api.getAnalysis).toHaveBeenCalledTimes(1);
  });

  it('resume(): attaches SSE without POSTing; no-op when already attached', async () => {
    store.resume('sess-9');
    expect(api.startAnalysis).not.toHaveBeenCalled();
    expect(sse.connect).toHaveBeenCalledWith('sess-9');
    store.resume('sess-9');
    expect(sse.connect).toHaveBeenCalledTimes(1);
  });
});

describe('boardPhaseFor', () => {
  it('maps the engine phase vocabulary onto the three-phase board', () => {
    expect(boardPhaseFor('replaying-actions')).toBe('replay');
    expect(boardPhaseFor('capturing-snapshots')).toBe('replay');
    expect(boardPhaseFor('running-accessibility-checks')).toBe('replay');
    expect(boardPhaseFor('processing-with-ai')).toBe('ai');
    expect(boardPhaseFor('generating-report')).toBe('ai');
    expect(boardPhaseFor('completed')).toBe('done');
  });
});
