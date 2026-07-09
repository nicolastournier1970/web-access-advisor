import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionV2, SseEvent } from '@waa/shared';
import { ApiClient } from '../api/api-client';
import { SseClient, type SseConnectionState } from '../api/sse-client';
import { AnnouncerService } from '../a11y/announcer.service';
import { RecordingStore, authSuspectedFromStep } from './recording.store';

function action(step: number, overrides: Partial<ActionV2> = {}): ActionV2 {
  return {
    type: 'click',
    step,
    timestamp: '2026-07-08T10:00:00.000Z',
    redacted: false,
    ...overrides,
  };
}

describe('RecordingStore', () => {
  let events: Subject<SseEvent>;
  let api: {
    startRecording: ReturnType<typeof vi.fn>;
    stopRecording: ReturnType<typeof vi.fn>;
    startAuthSegment: ReturnType<typeof vi.fn>;
    endAuthSegment: ReturnType<typeof vi.fn>;
    getSession: ReturnType<typeof vi.fn>;
  };
  let sse: { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> };
  let announce: ReturnType<typeof vi.fn>;
  let store: RecordingStore;

  beforeEach(() => {
    events = new Subject<SseEvent>();
    api = {
      startRecording: vi.fn(async () => ({
        sessionId: 'sess-1',
        status: 'recording' as const,
        url: 'https://example.com',
      })),
      stopRecording: vi.fn(async () => ({
        sessionId: 'sess-1',
        status: 'recorded' as const,
        actionCount: 2,
        actions: [action(1), action(2)],
        authCheckpoints: [],
        storageStateSaved: false,
      })),
      startAuthSegment: vi.fn(async () => ({
        checkpointId: 'cp-1',
        afterStep: 3,
        discardedActions: 0,
      })),
      endAuthSegment: vi.fn(async () => ({ checkpointId: 'cp-1', storageStateSaved: true })),
      getSession: vi.fn(),
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
    store = TestBed.inject(RecordingStore);
  });

  async function startRecording(): Promise<void> {
    await store.start({ url: 'https://example.com' });
  }

  it('start(): POSTs, transitions idle→recording, connects SSE, announces', async () => {
    expect(store.phase()).toBe('idle');
    await startRecording();
    expect(api.startRecording).toHaveBeenCalledWith({ url: 'https://example.com' });
    expect(store.phase()).toBe('recording');
    expect(store.sessionId()).toBe('sess-1');
    expect(store.url()).toBe('https://example.com');
    expect(sse.connect).toHaveBeenCalledWith('sess-1');
    expect(announce).toHaveBeenCalledWith('Recording started');
  });

  it('start(): failure returns to idle and rethrows', async () => {
    api.startRecording.mockRejectedValueOnce(new Error('boom'));
    await expect(store.start({ url: 'https://example.com' })).rejects.toThrow('boom');
    expect(store.phase()).toBe('idle');
    expect(sse.connect).not.toHaveBeenCalled();
  });

  it('recording.action events append to actions in order', async () => {
    await startRecording();
    events.next({ type: 'recording.action', action: action(1), actionCount: 1 });
    events.next({ type: 'recording.action', action: action(2, { type: 'fill' }), actionCount: 2 });
    expect(store.actions().map((a) => a.step)).toEqual([1, 2]);
    expect(store.actions()[1].type).toBe('fill');
  });

  it('recording.auth_segment toggles authSegmentActive and announces', async () => {
    await startRecording();
    events.next({ type: 'recording.auth_segment', state: 'started', checkpointId: 'cp-1' });
    expect(store.authSegmentActive()).toBe(true);
    expect(announce).toHaveBeenCalledWith('Login segment active — actions are not being recorded');
    events.next({ type: 'recording.auth_segment', state: 'ended', checkpointId: 'cp-1' });
    expect(store.authSegmentActive()).toBe(false);
  });

  it('recording.warning surfaces persistently, announces assertively, and is dismissible', async () => {
    await startRecording();
    events.next({
      type: 'recording.warning',
      message: 'Profile locked — recording with a clean browser',
      reason: 'profile-unavailable',
    });
    expect(store.recordingWarning()).toEqual({
      message: 'Profile locked — recording with a clean browser',
      reason: 'profile-unavailable',
    });
    expect(announce).toHaveBeenCalledWith(
      expect.stringContaining('Recording continues without your saved logins'),
      'assertive',
    );
    store.dismissRecordingWarning();
    expect(store.recordingWarning()).toBeNull();
  });

  it('recording.auth_suspected surfaces prompt data (unless a segment is active)', async () => {
    await startRecording();
    events.next({
      type: 'recording.auth_suspected',
      reason: 'password-field',
      url: 'https://example.com/login',
      suspectedAtStep: 4,
    });
    expect(store.authSuspected()).toEqual({
      reason: 'password-field',
      url: 'https://example.com/login',
      suspectedAtStep: 4,
    });

    // While a segment is active the prompt is suppressed.
    events.next({ type: 'recording.auth_segment', state: 'started', checkpointId: 'cp-1' });
    events.next({
      type: 'recording.auth_suspected',
      reason: 'password-field',
      url: 'https://other.com/login',
      suspectedAtStep: 5,
    });
    expect(store.authSuspected()).toBeNull();
  });

  it('a dismissed URL never re-prompts; other URLs still do', async () => {
    await startRecording();
    const suspected: SseEvent = {
      type: 'recording.auth_suspected',
      reason: 'auth-domain-navigation',
      url: 'https://login.example.com/',
      suspectedAtStep: 3,
    };
    events.next(suspected);
    store.dismissAuthSuspected();
    expect(store.authSuspected()).toBeNull();
    events.next(suspected);
    expect(store.authSuspected()).toBeNull();
    events.next({
      type: 'recording.auth_suspected',
      reason: 'auth-domain-navigation',
      url: 'https://sso.example.com/',
      suspectedAtStep: 6,
    });
    expect(store.authSuspected()?.url).toBe('https://sso.example.com/');
  });

  it('startAuthSegment forwards fromStep (retroactive) or an empty body', async () => {
    await startRecording();
    await store.startAuthSegment(3);
    expect(api.startAuthSegment).toHaveBeenCalledWith('sess-1', { fromStep: 3 });
    await store.startAuthSegment();
    expect(api.startAuthSegment).toHaveBeenLastCalledWith('sess-1', {});
    await store.endAuthSegment();
    expect(api.endAuthSegment).toHaveBeenCalledWith('sess-1');
  });

  it("session.status 'interrupted' flags the store and disconnects", async () => {
    await startRecording();
    events.next({ type: 'session.status', status: 'interrupted' });
    expect(store.interrupted()).toBe(true);
    expect(store.phase()).toBe('idle');
    expect(sse.disconnect).toHaveBeenCalled();
  });

  it('stop(): POSTs stop, detaches and returns to idle; failure restores recording', async () => {
    await startRecording();
    const response = await store.stop();
    expect(response.actionCount).toBe(2);
    expect(store.phase()).toBe('idle');
    expect(sse.disconnect).toHaveBeenCalled();
    expect(announce).toHaveBeenCalledWith('Recording stopped');

    await startRecording();
    api.stopRecording.mockRejectedValueOnce(new Error('nope'));
    await expect(store.stop()).rejects.toThrow('nope');
    expect(store.phase()).toBe('recording');
  });
});

describe('authSuspectedFromStep', () => {
  it('password-field: the focus was never recorded → fromStep = suspectedAtStep', () => {
    expect(
      authSuspectedFromStep({ reason: 'password-field', url: 'u', suspectedAtStep: 4 }),
    ).toBe(4);
  });

  it('auth-domain-navigation: the navigation IS a recorded step → suspectedAtStep - 1', () => {
    expect(
      authSuspectedFromStep({ reason: 'auth-domain-navigation', url: 'u', suspectedAtStep: 4 }),
    ).toBe(3);
  });

  it('clamps to >= 0 when the first recorded step is already the login', () => {
    expect(
      authSuspectedFromStep({ reason: 'auth-domain-navigation', url: 'u', suspectedAtStep: 0 }),
    ).toBe(0);
  });
});
