/**
 * Pure session bookkeeping for a live recording. No Playwright, no I/O —
 * everything (step numbering, auth-segment discarding, checkpoint lifecycle,
 * RecordingV2 assembly) is deterministic given the injected clock, so the
 * credential-protection behaviour is fully unit-testable.
 *
 * Credential protection: while an auth segment is active {@link addAction}
 * returns null and records NOTHING — only the AuthCheckpoint marker persists
 * in the recording (docs/adr/0005). Navigations during the segment merely
 * update the segment's last-seen URL so `postLoginUrl` can be derived.
 */
import type {
  ActionTarget,
  ActionType,
  ActionV2,
  AuthCheckpoint,
  BrowserType,
  RecordingV2,
} from '@waa/shared';
import type { StartAuthSegmentResult } from '../engine-types.js';

/** Injectable time source; defaults to `() => new Date()`. */
export type Clock = () => Date;

/** Action fields supplied by the recorder; step/timestamp are assigned here. */
export interface AddActionInput {
  type: ActionType;
  url?: string;
  target?: ActionTarget;
  /** Legacy single-selector mirror of the best CSS-like candidate. */
  selector?: string;
  value?: string;
  /** Must already be true for sensitive values — the state never re-checks. */
  redacted?: boolean;
  metadata?: Record<string, unknown>;
}

/** Session metadata merged into the assembled RecordingV2 at stop time. */
export interface RecordingMeta {
  sessionId: string;
  sessionName?: string;
  url: string;
  browserType?: BrowserType;
  browserName?: string;
  useProfile?: boolean;
  metadata?: Record<string, unknown>;
}

interface ActiveSegment {
  checkpoint: AuthCheckpoint;
  /** Last main-frame URL seen while the segment was active. */
  lastUrl?: string;
}

/**
 * Mutable state of one recording session. Steps are monotonic
 * (last step + 1); a retroactive segment start may truncate the action tail
 * but never renumbers surviving actions, so numbering stays collision-free.
 */
export class RecorderState {
  private readonly clock: Clock;
  private readonly startedAt: Date;
  private actions: ActionV2[] = [];
  private readonly checkpoints: AuthCheckpoint[] = [];
  private segment: ActiveSegment | null = null;

  constructor(clock: Clock = () => new Date()) {
    this.clock = clock;
    this.startedAt = this.clock();
  }

  /** Step of the last recorded action; 0 before any action exists. */
  get lastStep(): number {
    const last = this.actions[this.actions.length - 1];
    return last === undefined ? 0 : last.step;
  }

  get actionCount(): number {
    return this.actions.length;
  }

  /** True while a login segment is open (actions are being discarded). */
  get isSegmentActive(): boolean {
    return this.segment !== null;
  }

  /** Shallow copies — callers cannot corrupt internal numbering. */
  getActions(): ActionV2[] {
    return this.actions.map((action) => ({ ...action }));
  }

  getAuthCheckpoints(): AuthCheckpoint[] {
    return this.checkpoints.map((checkpoint) => ({ ...checkpoint }));
  }

  /**
   * Record an action. Returns the completed ActionV2 (step + ISO timestamp
   * assigned), or null when an auth segment is active — the action is then
   * DISCARDED entirely (credential protection). A discarded navigation still
   * updates the segment's last URL so endSegment can derive `postLoginUrl`.
   */
  addAction(input: AddActionInput): ActionV2 | null {
    if (this.segment !== null) {
      if (input.type === 'navigate' && input.url !== undefined) {
        this.segment.lastUrl = input.url;
      }
      return null;
    }
    const action: ActionV2 = {
      type: input.type,
      step: this.lastStep + 1,
      timestamp: this.clock().toISOString(),
      ...(input.url !== undefined ? { url: input.url } : {}),
      ...(input.target !== undefined ? { target: input.target } : {}),
      ...(input.selector !== undefined ? { selector: input.selector } : {}),
      ...(input.value !== undefined ? { value: input.value } : {}),
      redacted: input.redacted ?? false,
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    };
    this.actions.push(action);
    return action;
  }

  /**
   * Open a login segment. The checkpoint sits after `fromStep` when given
   * (clamped to [0, lastStep]) else after the current last step. A `fromStep`
   * RETROACTIVELY discards every recorded action with step > fromStep (the
   * auto-detect confirmation flow: "the login actually started N steps ago");
   * surviving actions keep their step numbers. Throws if a segment is already
   * active.
   */
  startSegment(
    reason: AuthCheckpoint['reason'],
    fromStep?: number,
    loginUrl?: string,
  ): StartAuthSegmentResult {
    if (this.segment !== null) {
      throw new Error('An auth segment is already active; end it before starting another');
    }
    let discardedActions = 0;
    let afterStep = this.lastStep;
    if (fromStep !== undefined) {
      afterStep = Math.max(0, Math.min(Math.floor(fromStep), this.lastStep));
      const kept = this.actions.filter((action) => action.step <= afterStep);
      discardedActions = this.actions.length - kept.length;
      this.actions = kept;
    }
    const checkpoint: AuthCheckpoint = {
      id: `acp_${this.checkpoints.length + 1}`,
      afterStep,
      reason,
      ...(loginUrl !== undefined ? { loginUrl } : {}),
      storageStateSaved: false,
      startedAt: this.clock().toISOString(),
    };
    this.checkpoints.push(checkpoint);
    this.segment = { checkpoint };
    return { checkpoint, discardedActions };
  }

  /**
   * Close the active login segment: stamps `completedAt` and derives
   * `postLoginUrl` from `nowUrl` (preferred) or the last URL navigated to
   * during the segment. `storageStateSaved` stays false — the caller flips it
   * via {@link markStorageStateSaved} only AFTER the save actually succeeded.
   * Throws when no segment is active.
   */
  endSegment(nowUrl?: string): { checkpoint: AuthCheckpoint } {
    const segment = this.segment;
    if (segment === null) {
      throw new Error('No active auth segment to end');
    }
    segment.checkpoint.completedAt = this.clock().toISOString();
    const postLoginUrl = nowUrl ?? segment.lastUrl;
    if (postLoginUrl !== undefined) {
      segment.checkpoint.postLoginUrl = postLoginUrl;
    }
    this.segment = null;
    return { checkpoint: segment.checkpoint };
  }

  /** Flip a checkpoint's storageStateSaved AFTER a successful save; false when the id is unknown. */
  markStorageStateSaved(checkpointId: string): boolean {
    const checkpoint = this.checkpoints.find((c) => c.id === checkpointId);
    if (checkpoint === undefined) return false;
    checkpoint.storageStateSaved = true;
    return true;
  }

  /**
   * Assemble the final RecordingV2 (formatVersion 2, actionCount, duration
   * from the injected clock). Pure assembly — schema validation happens in
   * `saveRecording`, which refuses to persist an invalid recording.
   */
  toRecording(meta: RecordingMeta): RecordingV2 {
    const endedAt = this.clock();
    return {
      formatVersion: 2,
      sessionId: meta.sessionId,
      ...(meta.sessionName !== undefined ? { sessionName: meta.sessionName } : {}),
      url: meta.url,
      startTime: this.startedAt.toISOString(),
      endTime: endedAt.toISOString(),
      duration: endedAt.getTime() - this.startedAt.getTime(),
      actionCount: this.actions.length,
      actions: this.getActions(),
      authCheckpoints: this.getAuthCheckpoints(),
      ...(meta.browserType !== undefined ? { browserType: meta.browserType } : {}),
      ...(meta.browserName !== undefined ? { browserName: meta.browserName } : {}),
      ...(meta.useProfile !== undefined ? { useProfile: meta.useProfile } : {}),
      ...(meta.metadata !== undefined ? { metadata: meta.metadata } : {}),
    };
  }
}
