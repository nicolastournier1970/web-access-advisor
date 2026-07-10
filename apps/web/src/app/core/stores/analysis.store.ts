/**
 * Signal store for the analysis flow (docs/rewrite-plan.md §4 + §6).
 *
 * Wires ApiClient (commands) + SseClient (server→client events):
 *  - `analysis.progress`      → phase/message/step + snapshot/batch counters
 *  - `analysis.complete`      → `completed` (page navigates to results)
 *  - `analysis.error`         → `error` (page shows retry)
 *  - `replay.auth_required`   → `authPause` (pause-for-login banner)
 *  - `replay.auth_validating` → `authValidating` (Continue button spinner)
 *  - `replay.auth_resolved`   → clears the pause (banner closes)
 *  - `replay.auth_failed`     → `authFailedReason` (banner stays up)
 *
 * Mirrors the RecordingStore pattern: all state is signals, logic is plain
 * class methods over injected clients — unit-testable with fakes.
 */
import { Injectable, inject, signal } from '@angular/core';
import type { Subscription } from 'rxjs';
import type {
  AnalysisPhase,
  AnalysisResult,
  SessionStatus,
  SseEvent,
  StartAnalysisResponse,
} from '@waa/shared';
import { ApiClient, ApiError, type StartAnalysisRequestInput } from '../api/api-client';
import { SseClient } from '../api/sse-client';
import { AnnouncerService } from '../a11y/announcer.service';

/** Replay pause-for-login banner data (from the replay.auth_required event). */
export interface AuthPause {
  reason: 'recorded-checkpoint' | 'auth-domain-navigation' | 'login-wall-detected';
  loginUrl: string;
  pausedAtStep: number;
  /** ISO timestamp when the paused replay times out (countdown target). */
  timeoutAt: string;
}

/** Coarse board phase derived from the engine's progress-phase vocabulary. */
export type BoardPhase = 'replay' | 'ai' | 'done';

/** v1 ThreePhaseStatus mapping: which board column an engine phase lights up. */
export function boardPhaseFor(phase: AnalysisPhase): BoardPhase {
  switch (phase) {
    case 'replaying-actions':
    case 'capturing-snapshots':
    case 'running-accessibility-checks':
      return 'replay';
    case 'processing-with-ai':
    case 'generating-report':
      return 'ai';
    case 'completed':
      return 'done';
  }
}

const BOARD_ANNOUNCEMENTS: Record<BoardPhase, string> = {
  replay: 'Replay and capture started',
  ai: 'AI analysis started',
  done: 'Analysis complete',
};

@Injectable({ providedIn: 'root' })
export class AnalysisStore {
  private readonly api = inject(ApiClient);
  private readonly sse = inject(SseClient);
  private readonly announcer = inject(AnnouncerService);

  private readonly sessionIdState = signal<string | null>(null);
  private readonly runningState = signal(false);
  private readonly phaseState = signal<AnalysisPhase | null>(null);
  private readonly messageState = signal('');
  private readonly currentStepState = signal<number | null>(null);
  private readonly totalStepsState = signal<number | null>(null);
  private readonly snapshotCountState = signal<number | null>(null);
  private readonly batchCurrentState = signal<number | null>(null);
  private readonly batchTotalState = signal<number | null>(null);
  private readonly authPauseState = signal<AuthPause | null>(null);
  private readonly authValidatingState = signal(false);
  private readonly authFailedReasonState = signal<string | null>(null);
  private readonly completedState = signal(false);
  private readonly warningsState = signal<string[]>([]);
  private readonly resultState = signal<AnalysisResult | null>(null);
  private readonly errorState = signal<string | null>(null);
  private readonly sessionStatusState = signal<SessionStatus | null>(null);

  readonly sessionId = this.sessionIdState.asReadonly();
  /** True while an analysis run is live on this session (SSE attached). */
  readonly running = this.runningState.asReadonly();
  readonly phase = this.phaseState.asReadonly();
  readonly message = this.messageState.asReadonly();
  readonly currentStep = this.currentStepState.asReadonly();
  readonly totalSteps = this.totalStepsState.asReadonly();
  readonly snapshotCount = this.snapshotCountState.asReadonly();
  readonly batchCurrent = this.batchCurrentState.asReadonly();
  readonly batchTotal = this.batchTotalState.asReadonly();
  readonly authPause = this.authPauseState.asReadonly();
  readonly authValidating = this.authValidatingState.asReadonly();
  readonly authFailedReason = this.authFailedReasonState.asReadonly();
  /** Set by analysis.complete — the page navigates to results on this. */
  readonly completed = this.completedState.asReadonly();
  /** Warnings carried by analysis.complete (AI-skipped detection, v1 parity). */
  readonly warnings = this.warningsState.asReadonly();
  readonly result = this.resultState.asReadonly();
  readonly error = this.errorState.asReadonly();
  readonly sessionStatus = this.sessionStatusState.asReadonly();
  readonly connectionState = this.sse.connectionState;

  private eventsSubscription: Subscription | null = null;
  private announcedBoardPhase: BoardPhase | null = null;

  /** POST /api/sessions/:id/analysis, then attach the SSE progress stream. */
  async start(
    sessionId: string,
    options: StartAnalysisRequestInput = {},
  ): Promise<StartAnalysisResponse> {
    this.reset();
    this.sessionIdState.set(sessionId);
    const response = await this.api.startAnalysis(sessionId, options);
    this.attach(sessionId);
    this.phaseState.set(response.phase);
    return response;
  }

  /**
   * Re-attach to an already-running analysis after a refresh/deep-link. The
   * server replays its SSE ring buffer to fresh connections, so progress and
   * any live auth pause are rebuilt.
   */
  resume(sessionId: string): void {
    if (this.sessionIdState() === sessionId && this.runningState()) return;
    this.reset();
    this.sessionIdState.set(sessionId);
    this.attach(sessionId);
  }

  /** GET the persisted result (refresh/deep-link on the results page). */
  async loadResult(sessionId: string): Promise<AnalysisResult> {
    const cached = this.resultState();
    if (cached && cached.sessionId === sessionId) return cached;
    const result = await this.api.getAnalysis(sessionId);
    this.resultState.set(result);
    return result;
  }

  /**
   * "I've signed in" — validates the live page server-side. On success the
   * banner clears when the replay.auth_resolved event arrives; on failure the
   * banner stays up with the reason.
   */
  async continueAuth(): Promise<void> {
    const sessionId = this.requireSessionId();
    this.authValidatingState.set(true);
    this.authFailedReasonState.set(null);
    try {
      const response = await this.api.continueReplayAuth(sessionId);
      if (response.reason !== undefined) {
        this.authValidatingState.set(false);
        this.authFailedReasonState.set(response.reason);
      }
      // ok: keep validating until replay.auth_resolved clears the banner.
    } catch (error) {
      this.authValidatingState.set(false);
      this.authFailedReasonState.set(
        error instanceof ApiError ? error.message : 'Could not validate the sign-in',
      );
      throw error;
    }
  }

  /** Abort the paused replay; partial snapshots are kept server-side. */
  async cancelAuth(): Promise<void> {
    const sessionId = this.requireSessionId();
    await this.api.cancelReplayAuth(sessionId);
    this.authPauseState.set(null);
    this.authValidatingState.set(false);
    this.authFailedReasonState.set(null);
    this.announcer.announce('Sign-in cancelled — analysis is stopping');
  }

  /** Page navigated away / handled completion; drop the live subscription. */
  detach(): void {
    this.eventsSubscription?.unsubscribe();
    this.eventsSubscription = null;
    this.sse.disconnect();
    this.runningState.set(false);
  }

  private attach(sessionId: string): void {
    this.runningState.set(true);
    this.eventsSubscription = this.sse.events$.subscribe((event) => this.onEvent(event));
    this.sse.connect(sessionId);
  }

  private reset(): void {
    this.detach();
    this.sessionIdState.set(null);
    this.phaseState.set(null);
    this.messageState.set('');
    this.currentStepState.set(null);
    this.totalStepsState.set(null);
    this.snapshotCountState.set(null);
    this.batchCurrentState.set(null);
    this.batchTotalState.set(null);
    this.authPauseState.set(null);
    this.authValidatingState.set(false);
    this.authFailedReasonState.set(null);
    this.completedState.set(false);
    this.warningsState.set([]);
    this.resultState.set(null);
    this.errorState.set(null);
    this.sessionStatusState.set(null);
    this.announcedBoardPhase = null;
  }

  private onEvent(event: SseEvent): void {
    switch (event.type) {
      case 'analysis.progress':
        this.phaseState.set(event.phase);
        this.messageState.set(event.message);
        if (event.currentStep !== undefined) this.currentStepState.set(event.currentStep);
        if (event.totalSteps !== undefined) this.totalStepsState.set(event.totalSteps);
        if (event.snapshotCount !== undefined) this.snapshotCountState.set(event.snapshotCount);
        if (event.batchCurrent !== undefined) this.batchCurrentState.set(event.batchCurrent);
        if (event.batchTotal !== undefined) this.batchTotalState.set(event.batchTotal);
        this.announceBoardPhase(boardPhaseFor(event.phase));
        break;

      case 'analysis.complete':
        this.phaseState.set('completed');
        if (event.snapshotCount !== undefined) this.snapshotCountState.set(event.snapshotCount);
        this.warningsState.set(event.warnings);
        this.completedState.set(true);
        this.runningState.set(false);
        this.announceBoardPhase('done');
        break;

      case 'analysis.error':
        this.errorState.set(event.message);
        this.runningState.set(false);
        this.authPauseState.set(null);
        this.announcer.announce('Analysis failed');
        break;

      case 'replay.auth_required':
        this.authPauseState.set({
          reason: event.reason,
          loginUrl: event.loginUrl,
          pausedAtStep: event.pausedAtStep,
          timeoutAt: event.timeoutAt,
        });
        this.authValidatingState.set(false);
        this.authFailedReasonState.set(null);
        this.announcer.announce(
          'Analysis paused — waiting for you to sign in in the browser window',
        );
        break;

      case 'replay.auth_validating':
        this.authValidatingState.set(true);
        break;

      case 'replay.auth_resolved':
        this.authPauseState.set(null);
        this.authValidatingState.set(false);
        this.authFailedReasonState.set(null);
        this.announcer.announce('Signed in — analysis resumed');
        break;

      case 'replay.auth_failed':
        this.authValidatingState.set(false);
        this.authFailedReasonState.set(event.reason);
        break;

      case 'session.status':
        this.sessionStatusState.set(event.status);
        break;

      default:
        // recording.* events belong to the record page.
        break;
    }
  }

  private announceBoardPhase(board: BoardPhase): void {
    if (board === this.announcedBoardPhase) return;
    this.announcedBoardPhase = board;
    this.announcer.announce(BOARD_ANNOUNCEMENTS[board]);
  }

  private requireSessionId(): string {
    const sessionId = this.sessionIdState();
    if (!sessionId) throw new Error('No active analysis session');
    return sessionId;
  }
}
