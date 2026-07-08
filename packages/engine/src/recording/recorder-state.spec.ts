import { describe, expect, it } from 'vitest';
import { recordingV2Schema } from '@waa/shared';
import { RecorderState, type Clock } from './recorder-state.js';

/** Deterministic clock advancing 1s per call, starting 2026-01-01T00:00:00Z. */
function makeClock(startMs = Date.UTC(2026, 0, 1)): { clock: Clock; calls: () => number } {
  let n = 0;
  return {
    clock: () => new Date(startMs + n++ * 1_000),
    calls: () => n,
  };
}

function stateWithActions(count: number): RecorderState {
  const state = new RecorderState(makeClock().clock);
  for (let i = 0; i < count; i++) {
    state.addAction({ type: 'click', value: `v${i + 1}` });
  }
  return state;
}

describe('RecorderState.addAction', () => {
  it('assigns monotonic steps and ISO timestamps from the injected clock', () => {
    const { clock } = makeClock();
    const state = new RecorderState(clock);
    const a1 = state.addAction({ type: 'navigate', url: 'https://a.example/' });
    const a2 = state.addAction({ type: 'click' });
    expect(a1).toMatchObject({ step: 1, type: 'navigate', url: 'https://a.example/' });
    expect(a2).toMatchObject({ step: 2, type: 'click', redacted: false });
    // constructor consumed tick 0 → actions get ticks 1 and 2
    expect(a1?.timestamp).toBe('2026-01-01T00:00:01.000Z');
    expect(a2?.timestamp).toBe('2026-01-01T00:00:02.000Z');
  });

  it('carries target/selector/value/redacted/metadata through untouched', () => {
    const state = new RecorderState(makeClock().clock);
    const action = state.addAction({
      type: 'fill',
      target: { candidates: [{ strategy: 'id', value: 'email' }], description: '#email' },
      selector: '#email',
      value: 'a@b.c',
      redacted: true,
      metadata: { tag: 'input' },
    });
    expect(action).toMatchObject({
      selector: '#email',
      value: 'a@b.c',
      redacted: true,
      metadata: { tag: 'input' },
    });
    expect(action?.target?.candidates).toHaveLength(1);
  });

  it('returns null and records nothing while an auth segment is active', () => {
    const state = stateWithActions(2);
    state.startSegment('user-marked');
    expect(state.addAction({ type: 'fill', value: 'hunter2' })).toBeNull();
    expect(state.addAction({ type: 'click' })).toBeNull();
    expect(state.actionCount).toBe(2);
    expect(JSON.stringify(state.getActions())).not.toContain('hunter2');
  });

  it('uses navigations during a segment only to derive postLoginUrl', () => {
    const state = stateWithActions(1);
    state.startSegment('auto-detected');
    expect(state.addAction({ type: 'navigate', url: 'https://idp.example/login' })).toBeNull();
    expect(state.addAction({ type: 'navigate', url: 'https://app.example/home' })).toBeNull();
    const { checkpoint } = state.endSegment();
    expect(checkpoint.postLoginUrl).toBe('https://app.example/home');
    expect(state.actionCount).toBe(1);
  });

  it('getActions returns copies that do not alias internal state', () => {
    const state = stateWithActions(1);
    const copy = state.getActions();
    copy[0]!.step = 999;
    expect(state.getActions()[0]!.step).toBe(1);
  });
});

describe('RecorderState.startSegment', () => {
  it('anchors afterStep at the current last step by default', () => {
    const state = stateWithActions(3);
    const { checkpoint, discardedActions } = state.startSegment('user-marked');
    expect(checkpoint.afterStep).toBe(3);
    expect(discardedActions).toBe(0);
    expect(checkpoint.id).toBe('acp_1');
    expect(checkpoint.storageStateSaved).toBe(false);
  });

  it('afterStep is 0 when no actions were recorded yet', () => {
    const state = new RecorderState(makeClock().clock);
    const { checkpoint } = state.startSegment('user-marked');
    expect(checkpoint.afterStep).toBe(0);
  });

  it('retroactively discards actions after fromStep without renumbering survivors', () => {
    const state = stateWithActions(5);
    const { checkpoint, discardedActions } = state.startSegment('auto-detected', 2);
    expect(discardedActions).toBe(3);
    expect(checkpoint.afterStep).toBe(2);
    expect(state.getActions().map((a) => a.step)).toEqual([1, 2]);
    // next action after the segment continues from the surviving last step
    state.endSegment();
    expect(state.addAction({ type: 'click' })?.step).toBe(3);
  });

  it('fromStep 0 discards everything', () => {
    const state = stateWithActions(3);
    const { checkpoint, discardedActions } = state.startSegment('auto-detected', 0);
    expect(discardedActions).toBe(3);
    expect(checkpoint.afterStep).toBe(0);
    expect(state.actionCount).toBe(0);
  });

  it('clamps an out-of-range fromStep to the last step', () => {
    const state = stateWithActions(2);
    const { checkpoint, discardedActions } = state.startSegment('user-marked', 99);
    expect(checkpoint.afterStep).toBe(2);
    expect(discardedActions).toBe(0);
  });

  it('records the loginUrl on the checkpoint and numbers checkpoints acp_<n>', () => {
    const state = new RecorderState(makeClock().clock);
    const first = state.startSegment('user-marked', undefined, 'https://idp.example/login');
    expect(first.checkpoint.loginUrl).toBe('https://idp.example/login');
    state.endSegment();
    const second = state.startSegment('auto-detected');
    expect(second.checkpoint.id).toBe('acp_2');
    expect(second.checkpoint.loginUrl).toBeUndefined();
  });

  it('throws when a segment is already active', () => {
    const state = new RecorderState(makeClock().clock);
    state.startSegment('user-marked');
    expect(() => state.startSegment('user-marked')).toThrow(/already active/);
  });
});

describe('RecorderState.endSegment', () => {
  it('prefers the explicit nowUrl over the last segment navigation', () => {
    const state = new RecorderState(makeClock().clock);
    state.startSegment('user-marked');
    state.addAction({ type: 'navigate', url: 'https://idp.example/callback' });
    const { checkpoint } = state.endSegment('https://app.example/dashboard');
    expect(checkpoint.postLoginUrl).toBe('https://app.example/dashboard');
    expect(checkpoint.completedAt).toBeDefined();
    expect(state.isSegmentActive).toBe(false);
  });

  it('leaves postLoginUrl unset when nothing is known', () => {
    const state = new RecorderState(makeClock().clock);
    state.startSegment('user-marked');
    const { checkpoint } = state.endSegment();
    expect(checkpoint.postLoginUrl).toBeUndefined();
  });

  it('throws when no segment is active', () => {
    const state = new RecorderState(makeClock().clock);
    expect(() => state.endSegment()).toThrow(/No active auth segment/);
  });
});

describe('RecorderState.markStorageStateSaved', () => {
  it('flips the flag only for a known checkpoint id', () => {
    const state = new RecorderState(makeClock().clock);
    const { checkpoint } = state.startSegment('user-marked');
    state.endSegment();
    expect(state.markStorageStateSaved('acp_999')).toBe(false);
    expect(checkpoint.storageStateSaved).toBe(false);
    expect(state.markStorageStateSaved(checkpoint.id)).toBe(true);
    expect(state.getAuthCheckpoints()[0]!.storageStateSaved).toBe(true);
  });
});

describe('RecorderState.toRecording', () => {
  it('assembles a schema-valid v2 recording with duration from the clock', () => {
    const { clock } = makeClock();
    const state = new RecorderState(clock);
    state.addAction({ type: 'navigate', url: 'https://app.example/' });
    state.addAction({ type: 'click', target: { candidates: [{ strategy: 'css', value: 'button.go' }] } });
    state.startSegment('user-marked');
    state.endSegment('https://app.example/home');
    state.markStorageStateSaved('acp_1');

    const recording = state.toRecording({
      sessionId: 'session_test_1',
      url: 'https://app.example/',
      browserType: 'chromium',
      useProfile: false,
    });

    const parsed = recordingV2Schema.parse(recording);
    expect(parsed.formatVersion).toBe(2);
    expect(parsed.actionCount).toBe(2);
    expect(parsed.actions).toHaveLength(2);
    expect(parsed.authCheckpoints).toHaveLength(1);
    expect(parsed.authCheckpoints[0]).toMatchObject({
      id: 'acp_1',
      afterStep: 2,
      storageStateSaved: true,
      postLoginUrl: 'https://app.example/home',
    });
    // clock ticks: 0=construct, 1..2=actions, 3=segment start, 4=segment end, 5=toRecording
    expect(parsed.startTime).toBe('2026-01-01T00:00:00.000Z');
    expect(parsed.endTime).toBe('2026-01-01T00:00:05.000Z');
    expect(parsed.duration).toBe(5_000);
  });

  it('omits optional metadata fields it was not given', () => {
    const state = new RecorderState(makeClock().clock);
    const recording = state.toRecording({ sessionId: 's', url: 'https://x.example/' });
    expect(recording).not.toHaveProperty('sessionName');
    expect(recording).not.toHaveProperty('browserType');
    expect(recording).not.toHaveProperty('browserName');
    expect(recording).not.toHaveProperty('useProfile');
    expect(recordingV2Schema.safeParse(recording).success).toBe(true);
  });
});
