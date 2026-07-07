/**
 * Unit tests for the pause-for-login state machine. Fully synchronous: the
 * clock is a mutable local, transitions are collected into an array.
 */
import { describe, expect, it } from 'vitest';
import type { AuthCheckpoint, ReplayAuthState } from '@waa/shared';
import { AuthCheckpointMachine } from './auth-checkpoint.js';

const TIMEOUT_MS = 600_000; // 10 min default

interface TransitionCall {
  state: ReplayAuthState;
  detail?: Record<string, unknown>;
}

function makeCheckpoint(id: string, afterStep: number): AuthCheckpoint {
  return {
    id,
    afterStep,
    reason: 'user-marked',
    loginUrl: 'https://idp.example.test/login',
    storageStateSaved: true,
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:01:00.000Z',
  };
}

/** Build a machine with a fake clock and a transition log. */
function makeMachine(checkpoints: AuthCheckpoint[] = []) {
  const clock = { now: 1_000_000 };
  const transitions: TransitionCall[] = [];
  const machine = new AuthCheckpointMachine({
    checkpoints,
    authPauseTimeoutMs: TIMEOUT_MS,
    now: () => clock.now,
    onTransition: (state, detail) => transitions.push({ state, detail }),
  });
  return { machine, clock, transitions };
}

const PAUSE_INPUT = {
  reason: 'login-wall-detected' as const,
  loginUrl: 'https://idp.example.test/login',
  pausedAtStep: 4,
};

describe('AuthCheckpointMachine — initial state', () => {
  it("starts in 'running' with no pause context and emits no transition", () => {
    const { machine, transitions } = makeMachine();
    expect(machine.state).toBe('running');
    expect(machine.pausedAtStep).toBeUndefined();
    expect(machine.pauseReason).toBeUndefined();
    expect(machine.activeCheckpointId).toBeUndefined();
    expect(machine.loginUrl).toBeUndefined();
    expect(machine.timeoutAt).toBeUndefined();
    expect(transitions).toEqual([]);
  });
});

describe('checkpointDueAt', () => {
  it('returns the checkpoint whose afterStep matches and undefined otherwise', () => {
    const { machine } = makeMachine([makeCheckpoint('acp_1', 3)]);
    expect(machine.checkpointDueAt(3)?.id).toBe('acp_1');
    expect(machine.checkpointDueAt(2)).toBeUndefined();
    expect(machine.checkpointDueAt(4)).toBeUndefined();
  });

  it('does not offer the same checkpoint twice after a successful resume', () => {
    const { machine } = makeMachine([makeCheckpoint('acp_1', 3)]);
    machine.pause({ ...PAUSE_INPUT, reason: 'recorded-checkpoint', pausedAtStep: 3, checkpointId: 'acp_1' });
    machine.beginValidation();
    machine.validationSucceeded();
    expect(machine.checkpointDueAt(3)).toBeUndefined();
  });

  it('consumes by paused step when pause() got no checkpointId', () => {
    const { machine } = makeMachine([makeCheckpoint('acp_1', 3)]);
    machine.pause({ ...PAUSE_INPUT, pausedAtStep: 3 });
    machine.beginValidation();
    machine.validationSucceeded();
    expect(machine.checkpointDueAt(3)).toBeUndefined();
  });

  it('leaves other checkpoints at the same afterStep due after one is consumed', () => {
    const { machine } = makeMachine([makeCheckpoint('acp_1', 3), makeCheckpoint('acp_2', 3)]);
    machine.pause({ ...PAUSE_INPUT, reason: 'recorded-checkpoint', pausedAtStep: 3, checkpointId: 'acp_1' });
    machine.beginValidation();
    machine.validationSucceeded();
    expect(machine.checkpointDueAt(3)?.id).toBe('acp_2');
  });
});

describe('pause', () => {
  it("transitions running → auth_required, records context, returns ISO timeoutAt = now + timeout", () => {
    const { machine, clock, transitions } = makeMachine();
    const { timeoutAt } = machine.pause({ ...PAUSE_INPUT, checkpointId: 'acp_9' });

    expect(machine.state).toBe('auth_required');
    expect(timeoutAt).toBe(new Date(clock.now + TIMEOUT_MS).toISOString());
    expect(machine.timeoutAt).toBe(timeoutAt);
    expect(machine.pausedAtStep).toBe(4);
    expect(machine.pauseReason).toBe('login-wall-detected');
    expect(machine.activeCheckpointId).toBe('acp_9');
    expect(machine.loginUrl).toBe(PAUSE_INPUT.loginUrl);

    expect(transitions).toHaveLength(1);
    expect(transitions[0]!.state).toBe('auth_required');
    expect(transitions[0]!.detail).toMatchObject({
      reason: 'login-wall-detected',
      loginUrl: PAUSE_INPUT.loginUrl,
      pausedAtStep: 4,
      checkpointId: 'acp_9',
      timeoutAt,
    });
  });

  it('throws from any state other than running', () => {
    const { machine } = makeMachine();
    machine.pause(PAUSE_INPUT);
    expect(() => machine.pause(PAUSE_INPUT)).toThrow(/pause.*'auth_required'/);
    machine.beginValidation();
    expect(() => machine.pause(PAUSE_INPUT)).toThrow(/pause.*'validating'/);
  });
});

describe('beginValidation', () => {
  it('transitions auth_required → validating', () => {
    const { machine, transitions } = makeMachine();
    machine.pause(PAUSE_INPUT);
    machine.beginValidation();
    expect(machine.state).toBe('validating');
    expect(transitions.map((t) => t.state)).toEqual(['auth_required', 'validating']);
  });

  it('throws from running and from validating', () => {
    const { machine } = makeMachine();
    expect(() => machine.beginValidation()).toThrow(/beginValidation.*'running'/);
    machine.pause(PAUSE_INPUT);
    machine.beginValidation();
    expect(() => machine.beginValidation()).toThrow(/beginValidation.*'validating'/);
  });
});

describe('validationSucceeded', () => {
  it('emits resuming then running (two calls), returns pausedAtStep, clears pause context', () => {
    const { machine, transitions } = makeMachine();
    machine.pause(PAUSE_INPUT);
    machine.beginValidation();
    const result = machine.validationSucceeded();

    expect(result).toEqual({ resumedAtStep: 4 });
    expect(machine.state).toBe('running');
    expect(transitions.map((t) => t.state)).toEqual([
      'auth_required',
      'validating',
      'resuming',
      'running',
    ]);
    expect(transitions[2]!.detail).toMatchObject({ resumedAtStep: 4 });
    expect(transitions[3]!.detail).toMatchObject({ resumedAtStep: 4 });

    expect(machine.pausedAtStep).toBeUndefined();
    expect(machine.pauseReason).toBeUndefined();
    expect(machine.activeCheckpointId).toBeUndefined();
    expect(machine.loginUrl).toBeUndefined();
    expect(machine.timeoutAt).toBeUndefined();
  });

  it('throws unless validating', () => {
    const { machine } = makeMachine();
    expect(() => machine.validationSucceeded()).toThrow(/validationSucceeded.*'running'/);
    machine.pause(PAUSE_INPUT);
    expect(() => machine.validationSucceeded()).toThrow(/validationSucceeded.*'auth_required'/);
  });

  it('allows a fresh pause afterwards with a new deadline', () => {
    const { machine, clock } = makeMachine();
    machine.pause(PAUSE_INPUT);
    machine.beginValidation();
    machine.validationSucceeded();

    clock.now += 5_000_000; // long after the first deadline
    const { timeoutAt } = machine.pause({ ...PAUSE_INPUT, pausedAtStep: 9 });
    expect(timeoutAt).toBe(new Date(clock.now + TIMEOUT_MS).toISOString());
    expect(machine.pausedAtStep).toBe(9);
    expect(machine.isTimedOut()).toBe(false);
  });
});

describe('validationFailed', () => {
  it('emits auth_failed then auth_required (two calls) and preserves the pause context', () => {
    const { machine, transitions } = makeMachine();
    const { timeoutAt } = machine.pause({ ...PAUSE_INPUT, checkpointId: 'acp_1' });
    machine.beginValidation();
    machine.validationFailed('still on the login page');

    expect(machine.state).toBe('auth_required');
    expect(transitions.map((t) => t.state)).toEqual([
      'auth_required',
      'validating',
      'auth_failed',
      'auth_required',
    ]);
    expect(transitions[2]!.detail).toMatchObject({ reason: 'still on the login page' });
    expect(transitions[3]!.detail).toMatchObject({
      pausedAtStep: 4,
      timeoutAt,
      failureReason: 'still on the login page',
    });

    expect(machine.pausedAtStep).toBe(4);
    expect(machine.pauseReason).toBe('login-wall-detected');
    expect(machine.activeCheckpointId).toBe('acp_1');
    expect(machine.timeoutAt).toBe(timeoutAt);
  });

  it('keeps the ORIGINAL deadline: timeout is measured from the first pause()', () => {
    const { machine, clock } = makeMachine();
    machine.pause(PAUSE_INPUT);

    clock.now += TIMEOUT_MS - 10_000; // 10s before the original deadline
    machine.beginValidation();
    machine.validationFailed('probe unreachable');
    expect(machine.isTimedOut()).toBe(false);

    clock.now += 10_000; // exactly the original deadline — churn added no time
    expect(machine.isTimedOut()).toBe(true);
  });

  it('throws unless validating', () => {
    const { machine } = makeMachine();
    expect(() => machine.validationFailed('x')).toThrow(/validationFailed.*'running'/);
    machine.pause(PAUSE_INPUT);
    expect(() => machine.validationFailed('x')).toThrow(/validationFailed.*'auth_required'/);
  });
});

describe('cancel', () => {
  it('cancels from auth_required', () => {
    const { machine, transitions } = makeMachine();
    machine.pause(PAUSE_INPUT);
    machine.cancel();
    expect(machine.state).toBe('cancelled');
    expect(transitions.at(-1)).toMatchObject({
      state: 'cancelled',
      detail: { fromState: 'auth_required', pausedAtStep: 4 },
    });
  });

  it('cancels from validating', () => {
    const { machine } = makeMachine();
    machine.pause(PAUSE_INPUT);
    machine.beginValidation();
    machine.cancel();
    expect(machine.state).toBe('cancelled');
  });

  it('cancels after a failed validation (machine rests in auth_required)', () => {
    const { machine } = makeMachine();
    machine.pause(PAUSE_INPUT);
    machine.beginValidation();
    machine.validationFailed('nope');
    machine.cancel();
    expect(machine.state).toBe('cancelled');
  });

  it('throws from running', () => {
    const { machine } = makeMachine();
    expect(() => machine.cancel()).toThrow(/cancel.*'running'/);
  });
});

describe('timeout', () => {
  it('isTimedOut is false before the deadline and true at/after it (auth_required only)', () => {
    const { machine, clock } = makeMachine();
    const pausedAt = clock.now;
    machine.pause(PAUSE_INPUT);

    clock.now = pausedAt + TIMEOUT_MS - 1;
    expect(machine.isTimedOut()).toBe(false);
    clock.now = pausedAt + TIMEOUT_MS;
    expect(machine.isTimedOut()).toBe(true);
    clock.now = pausedAt + TIMEOUT_MS + 1;
    expect(machine.isTimedOut()).toBe(true);
  });

  it('is never timed out while running or validating, even past the deadline', () => {
    const { machine, clock } = makeMachine();
    clock.now += TIMEOUT_MS * 10;
    expect(machine.isTimedOut()).toBe(false); // running, never paused

    clock.now = 1_000_000;
    machine.pause(PAUSE_INPUT);
    machine.beginValidation();
    clock.now += TIMEOUT_MS * 2;
    expect(machine.isTimedOut()).toBe(false); // validating
    expect(machine.expireIfTimedOut()).toBe(false);
  });

  it('expireIfTimedOut transitions to timed_out (terminal) exactly once', () => {
    const { machine, clock, transitions } = makeMachine();
    const { timeoutAt } = machine.pause(PAUSE_INPUT);

    expect(machine.expireIfTimedOut()).toBe(false); // not yet due
    clock.now += TIMEOUT_MS + 1;
    expect(machine.expireIfTimedOut()).toBe(true);
    expect(machine.state).toBe('timed_out');
    expect(transitions.at(-1)).toMatchObject({
      state: 'timed_out',
      detail: { pausedAtStep: 4, timeoutAt },
    });

    expect(machine.expireIfTimedOut()).toBe(false); // idempotent once terminal
    expect(machine.isTimedOut()).toBe(false); // no longer in auth_required
  });
});

describe('terminal states reject all mutators', () => {
  function expectAllMutatorsThrow(machine: AuthCheckpointMachine, terminal: string): void {
    const pattern = new RegExp(`terminal state '${terminal}'`);
    expect(() => machine.pause(PAUSE_INPUT)).toThrow(pattern);
    expect(() => machine.beginValidation()).toThrow(pattern);
    expect(() => machine.validationSucceeded()).toThrow(pattern);
    expect(() => machine.validationFailed('x')).toThrow(pattern);
    expect(() => machine.cancel()).toThrow(pattern);
  }

  it("after cancel → 'cancelled'", () => {
    const { machine } = makeMachine();
    machine.pause(PAUSE_INPUT);
    machine.cancel();
    expectAllMutatorsThrow(machine, 'cancelled');
  });

  it("after expiry → 'timed_out'", () => {
    const { machine, clock } = makeMachine();
    machine.pause(PAUSE_INPUT);
    clock.now += TIMEOUT_MS;
    expect(machine.expireIfTimedOut()).toBe(true);
    expectAllMutatorsThrow(machine, 'timed_out');
  });

  it('queries stay usable in terminal states', () => {
    const { machine } = makeMachine([makeCheckpoint('acp_1', 3)]);
    machine.pause(PAUSE_INPUT);
    machine.cancel();
    expect(machine.checkpointDueAt(3)?.id).toBe('acp_1');
    expect(machine.state).toBe('cancelled');
    expect(machine.pausedAtStep).toBe(4); // context kept for post-mortem reporting
  });
});

describe('full journey transition sequence', () => {
  it('pause → validate → fail → validate → succeed emits the exact ordered sequence', () => {
    const { machine, transitions } = makeMachine([makeCheckpoint('acp_1', 4)]);
    machine.pause({ ...PAUSE_INPUT, reason: 'recorded-checkpoint', checkpointId: 'acp_1' });
    machine.beginValidation();
    machine.validationFailed('still on idp');
    machine.beginValidation();
    const { resumedAtStep } = machine.validationSucceeded();

    expect(resumedAtStep).toBe(4);
    expect(transitions.map((t) => t.state)).toEqual([
      'auth_required',
      'validating',
      'auth_failed',
      'auth_required',
      'validating',
      'resuming',
      'running',
    ]);
    expect(machine.checkpointDueAt(4)).toBeUndefined(); // consumed despite the failed attempt
  });
});
