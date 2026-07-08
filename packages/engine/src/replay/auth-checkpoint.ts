/**
 * Pause-for-login state machine for replay (docs/rewrite-plan.md §6).
 *
 * Pure logic: no Playwright, no timers. The replayer/analyzer drives it and
 * maps its transitions onto `replay.auth_*` events; the clock is injected so
 * timeout behaviour is fully unit-testable.
 *
 * State graph (ReplayAuthState from @waa/shared):
 *
 *   running ── pause() ──▶ auth_required ── beginValidation() ──▶ validating
 *      ▲                        ▲   │                                 │
 *      │                        │   └─ expireIfTimedOut() ─▶ timed_out (terminal)
 *      │                        │                                     │
 *      └── resuming ◀── validationSucceeded() ────────────────────────┤
 *                               │                                     │
 *                auth_failed ◀── validationFailed() ──────────────────┘
 *
 *   cancel() from auth_required / validating / auth_failed ─▶ cancelled (terminal)
 *
 * `resuming` and `auth_failed` are momentary: they are emitted via
 * `onTransition` and the machine immediately moves on (to `running` /
 * `auth_required` respectively) within the same call.
 */
import type { AuthCheckpoint, ReplayAuthState } from '@waa/shared';

/**
 * Why the replay paused. Mirrors the `reason` union of the
 * `replay.auth_required` SSE event and the engine `AnalyzeEvent`
 * `auth-required` variant (no named type exists in @waa/shared for it).
 */
export type AuthPauseReason =
  | 'recorded-checkpoint'
  | 'auth-domain-navigation'
  | 'login-wall-detected';

/** Constructor options for {@link AuthCheckpointMachine}. */
export interface AuthCheckpointMachineOptions {
  /** Recorded checkpoints from RecordingV2.authCheckpoints (may be empty). */
  checkpoints: AuthCheckpoint[];
  /** How long a pause may sit in `auth_required` before it can expire. */
  authPauseTimeoutMs: number;
  /** Injectable clock (epoch ms). Defaults to Date.now. */
  now?: () => number;
  /**
   * Invoked once per state transition, in order, synchronously. Momentary
   * states (`resuming`, `auth_failed`) produce two calls from one method.
   */
  onTransition: (state: ReplayAuthState, detail?: Record<string, unknown>) => void;
}

/** Input for {@link AuthCheckpointMachine.pause}. */
export interface AuthPauseInput {
  reason: AuthPauseReason;
  /** Recorded checkpoint URL or the live page URL at pause time. */
  loginUrl: string;
  /** Step index the replay stopped at; replay resumes from here on success. */
  pausedAtStep: number;
  /** Recorded checkpoint being honoured, when reason is 'recorded-checkpoint'. */
  checkpointId?: string;
}

const TERMINAL_STATES: ReadonlySet<ReplayAuthState> = new Set(['cancelled', 'timed_out']);
const CANCELLABLE_STATES: ReadonlySet<ReplayAuthState> = new Set([
  'auth_required',
  'validating',
  'auth_failed',
]);

/**
 * Tracks the replay's authentication pause lifecycle. One instance lives for
 * the whole replay and may go through several pause→resume cycles (one per
 * checkpoint); recorded checkpoints are consumed on successful resume so the
 * same `afterStep` never pauses the replay twice.
 *
 * Invariants:
 *  - `cancelled` and `timed_out` are terminal: every mutator throws there.
 *  - A failed validation loops back to `auth_required` WITHOUT resetting the
 *    timeout deadline — the clock keeps running from the original pause().
 */
export class AuthCheckpointMachine {
  #state: ReplayAuthState = 'running';
  readonly #checkpoints: AuthCheckpoint[];
  readonly #consumedCheckpointIds = new Set<string>();
  readonly #authPauseTimeoutMs: number;
  readonly #now: () => number;
  readonly #onTransition: (state: ReplayAuthState, detail?: Record<string, unknown>) => void;

  #pausedAtStep: number | undefined;
  #pauseReason: AuthPauseReason | undefined;
  #activeCheckpointId: string | undefined;
  #loginUrl: string | undefined;
  /** Epoch ms after which the current pause counts as timed out. */
  #deadlineEpochMs: number | undefined;

  constructor(opts: AuthCheckpointMachineOptions) {
    this.#checkpoints = [...opts.checkpoints];
    this.#authPauseTimeoutMs = opts.authPauseTimeoutMs;
    this.#now = opts.now ?? Date.now;
    this.#onTransition = opts.onTransition;
  }

  /** Current state. Starts at 'running'; no transition is emitted for it. */
  get state(): ReplayAuthState {
    return this.#state;
  }

  /** Step the replay paused at; undefined while running (cleared on resume). */
  get pausedAtStep(): number | undefined {
    return this.#pausedAtStep;
  }

  /** Reason for the current/last pause; undefined while running. */
  get pauseReason(): AuthPauseReason | undefined {
    return this.#pauseReason;
  }

  /** Recorded checkpoint id the current pause honours, when there is one. */
  get activeCheckpointId(): string | undefined {
    return this.#activeCheckpointId;
  }

  /** Login URL supplied to pause(); undefined while running. */
  get loginUrl(): string | undefined {
    return this.#loginUrl;
  }

  /** ISO deadline of the current pause; undefined while running. */
  get timeoutAt(): string | undefined {
    return this.#deadlineEpochMs === undefined
      ? undefined
      : new Date(this.#deadlineEpochMs).toISOString();
  }

  /**
   * The unconsumed recorded checkpoint the replay is about to CROSS when it
   * executes the action with this step number. A checkpoint "sits after"
   * `afterStep`, so it is due before the first action with `step > afterStep`
   * — NOT before re-executing `afterStep` itself (that would replay the
   * pre-login bounce navigation again after sign-in and land the browser back
   * on the login page; caught by the Phase 6 fixture-site gate). Pure query —
   * valid in any state. A checkpoint after the final action is never due:
   * there is nothing left to replay behind it.
   */
  checkpointDueAt(step: number): AuthCheckpoint | undefined {
    return this.#checkpoints.find(
      (cp) => cp.afterStep < step && !this.#consumedCheckpointIds.has(cp.id),
    );
  }

  /**
   * The first unconsumed checkpoint at or beyond this step — i.e. the login
   * boundary the action at `step` leads INTO. Used by the replay to recognise
   * recorded auth-redirect navigations (their URL matches this checkpoint's
   * loginUrl) that must not be replayed when a saved login already covers the
   * session. Pure query — valid in any state.
   */
  pendingCheckpointCovering(step: number): AuthCheckpoint | undefined {
    return this.#checkpoints.find(
      (cp) => cp.afterStep >= step && !this.#consumedCheckpointIds.has(cp.id),
    );
  }

  /**
   * Mark a recorded checkpoint consumed WITHOUT a pause/resume cycle. Used by
   * the replay when a VALIDATED saved login already covers the session
   * (docs/rewrite-plan.md §6 pause condition 1 not met): the checkpoint is
   * skipped, and consuming it keeps {@link checkpointDueAt} truthful so a
   * re-query of the same boundary offers the next unconsumed checkpoint (or
   * nothing) instead of looping. Pure bookkeeping — no state transition,
   * unknown ids are ignored, valid in any state.
   */
  consumeCheckpoint(checkpointId: string): void {
    this.#consumedCheckpointIds.add(checkpointId);
  }

  /**
   * Pause the replay for login. Only legal from 'running'. Computes the
   * timeout deadline from the injected clock (now + authPauseTimeoutMs) and
   * transitions to 'auth_required'. The returned `timeoutAt` (ISO 8601) is
   * what the adapter should surface in the `replay.auth_required` event.
   */
  pause(input: AuthPauseInput): { timeoutAt: string } {
    this.#assertMutable('pause');
    if (this.#state !== 'running') {
      throw new Error(
        `AuthCheckpointMachine.pause: invalid in state '${this.#state}' (requires 'running')`,
      );
    }
    this.#pausedAtStep = input.pausedAtStep;
    this.#pauseReason = input.reason;
    this.#activeCheckpointId = input.checkpointId;
    this.#loginUrl = input.loginUrl;
    this.#deadlineEpochMs = this.#now() + this.#authPauseTimeoutMs;
    const timeoutAt = new Date(this.#deadlineEpochMs).toISOString();
    this.#transition('auth_required', {
      reason: input.reason,
      loginUrl: input.loginUrl,
      pausedAtStep: input.pausedAtStep,
      checkpointId: input.checkpointId,
      timeoutAt,
    });
    return { timeoutAt };
  }

  /** User clicked "I've logged in": 'auth_required' → 'validating'. */
  beginValidation(): void {
    this.#assertMutable('beginValidation');
    if (this.#state !== 'auth_required') {
      throw new Error(
        `AuthCheckpointMachine.beginValidation: invalid in state '${this.#state}' (requires 'auth_required')`,
      );
    }
    this.#transition('validating');
  }

  /**
   * Validation passed: emits 'resuming' then immediately 'running' (two
   * onTransition calls). Marks the checkpoint tied to this pause consumed —
   * by `checkpointId` when pause() received one, otherwise whichever
   * unconsumed checkpoint is due at the paused step — so it is never due
   * again. Clears the pause context and returns the step to resume from.
   */
  validationSucceeded(): { resumedAtStep: number } {
    this.#assertMutable('validationSucceeded');
    if (this.#state !== 'validating') {
      throw new Error(
        `AuthCheckpointMachine.validationSucceeded: invalid in state '${this.#state}' (requires 'validating')`,
      );
    }
    // pausedAtStep is always set here: 'validating' is only reachable via pause().
    const resumedAtStep = this.#pausedAtStep as number;
    const checkpoint = this.#activeCheckpointId
      ? this.#checkpoints.find((cp) => cp.id === this.#activeCheckpointId)
      : this.checkpointDueAt(resumedAtStep);
    if (checkpoint) {
      this.#consumedCheckpointIds.add(checkpoint.id);
    }
    this.#transition('resuming', { resumedAtStep });
    this.#clearPauseContext();
    this.#transition('running', { resumedAtStep });
    return { resumedAtStep };
  }

  /**
   * Validation failed: emits 'auth_failed' then loops straight back to
   * 'auth_required' (two onTransition calls). The pause context — paused
   * step, reason, checkpoint, login URL AND the timeout deadline — is
   * preserved: the clock keeps running from the original pause().
   */
  validationFailed(reason: string): void {
    this.#assertMutable('validationFailed');
    if (this.#state !== 'validating') {
      throw new Error(
        `AuthCheckpointMachine.validationFailed: invalid in state '${this.#state}' (requires 'validating')`,
      );
    }
    this.#transition('auth_failed', { reason });
    this.#transition('auth_required', {
      reason: this.#pauseReason,
      loginUrl: this.#loginUrl,
      pausedAtStep: this.#pausedAtStep,
      checkpointId: this.#activeCheckpointId,
      timeoutAt: this.timeoutAt,
      failureReason: reason,
    });
  }

  /**
   * Abort the pause: 'auth_required' | 'validating' | 'auth_failed' →
   * 'cancelled' (terminal). Throws from 'running' — there is nothing to
   * cancel — and from terminal states. ('auth_failed' is accepted for spec
   * completeness even though the machine never rests there.)
   */
  cancel(): void {
    this.#assertMutable('cancel');
    if (!CANCELLABLE_STATES.has(this.#state)) {
      throw new Error(
        `AuthCheckpointMachine.cancel: invalid in state '${this.#state}' ` +
          `(requires 'auth_required', 'validating' or 'auth_failed')`,
      );
    }
    const fromState = this.#state;
    this.#transition('cancelled', { fromState, pausedAtStep: this.#pausedAtStep });
  }

  /**
   * True only while sitting in 'auth_required' with the injected clock at or
   * past the deadline set by the ORIGINAL pause() (failed validations do not
   * extend it). Never true in 'validating' or any other state.
   */
  isTimedOut(): boolean {
    return (
      this.#state === 'auth_required' &&
      this.#deadlineEpochMs !== undefined &&
      this.#now() >= this.#deadlineEpochMs
    );
  }

  /**
   * Transition to 'timed_out' (terminal) iff {@link isTimedOut} — returns
   * true when it expired, false otherwise. Deliberately non-throwing so
   * callers can poll it from any state without guarding.
   */
  expireIfTimedOut(): boolean {
    if (!this.isTimedOut()) {
      return false;
    }
    this.#transition('timed_out', {
      pausedAtStep: this.#pausedAtStep,
      timeoutAt: this.timeoutAt,
    });
    return true;
  }

  /** Set the new state and notify. Never called with the machine terminal. */
  #transition(state: ReplayAuthState, detail?: Record<string, unknown>): void {
    this.#state = state;
    this.#onTransition(state, detail);
  }

  /** Reset per-pause bookkeeping after a successful resume. */
  #clearPauseContext(): void {
    this.#pausedAtStep = undefined;
    this.#pauseReason = undefined;
    this.#activeCheckpointId = undefined;
    this.#loginUrl = undefined;
    this.#deadlineEpochMs = undefined;
  }

  /** Reject every mutator once the machine is terminal. */
  #assertMutable(method: string): void {
    if (TERMINAL_STATES.has(this.#state)) {
      throw new Error(
        `AuthCheckpointMachine.${method}: machine is in terminal state '${this.#state}'; no further transitions are allowed`,
      );
    }
  }
}
