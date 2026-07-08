/**
 * Signal store for the live recording flow (docs/rewrite-plan.md §4).
 *
 * Wires ApiClient (commands) + SseClient (server→client events):
 *  - `recording.action`        → appended to `actions`
 *  - `recording.auth_segment`  → toggles `authSegmentActive`
 *  - `recording.auth_suspected`→ surfaces `authSuspected` prompt data (once
 *    per URL — a dismissed URL never re-prompts)
 *  - `session.status`          → tracks status; 'interrupted' (browser closed
 *    by the user) raises the `interrupted` flag for the page to toast+redirect.
 *
 * All state is signals; logic is plain class methods over injected clients so
 * the store is unit-testable with fakes (no DOM, no HTTP).
 */
import { Injectable, inject, signal } from '@angular/core';
import type { Subscription } from 'rxjs';
import type {
  ActionV2,
  SessionStatus,
  SessionSummary,
  SseEvent,
  StartRecordingResponse,
  StopRecordingResponse,
} from '@waa/shared';
import { ApiClient, type StartRecordingRequestInput } from '../api/api-client';
import { SseClient } from '../api/sse-client';
import { AnnouncerService } from '../a11y/announcer.service';

export type RecordingPhase = 'idle' | 'starting' | 'recording' | 'stopping';

export interface AuthSuspectedPrompt {
  reason: 'auth-domain-navigation' | 'password-field';
  url: string;
  suspectedAtStep: number;
}

/**
 * Maps a `recording.auth_suspected` event to the `fromStep` sent when the user
 * confirms a retroactive login segment (rewrite-plan "Open items", decided
 * here for Phase 4, to be re-validated end-to-end in Phase 6):
 *
 *  - `password-field`: the trigger is a focus event that was never recorded as
 *    an action, so `suspectedAtStep` is already the last legitimate recorded
 *    step — the segment starts after it → `fromStep = suspectedAtStep`.
 *  - `auth-domain-navigation`: the trigger IS a recorded step (the navigation
 *    onto the auth domain) and must itself be folded into the segment →
 *    `fromStep = suspectedAtStep - 1`, clamped to >= 0 (a first-step
 *    navigation means the whole recording so far is the login).
 */
export function authSuspectedFromStep(prompt: AuthSuspectedPrompt): number {
  return prompt.reason === 'password-field'
    ? prompt.suspectedAtStep
    : Math.max(0, prompt.suspectedAtStep - 1);
}

@Injectable({ providedIn: 'root' })
export class RecordingStore {
  private readonly api = inject(ApiClient);
  private readonly sse = inject(SseClient);
  private readonly announcer = inject(AnnouncerService);

  private readonly phaseState = signal<RecordingPhase>('idle');
  private readonly sessionIdState = signal<string | null>(null);
  private readonly urlState = signal<string | null>(null);
  private readonly actionsState = signal<ActionV2[]>([]);
  private readonly authSegmentActiveState = signal(false);
  private readonly authSuspectedState = signal<AuthSuspectedPrompt | null>(null);
  private readonly sessionStatusState = signal<SessionStatus | null>(null);
  private readonly interruptedState = signal(false);

  readonly phase = this.phaseState.asReadonly();
  readonly sessionId = this.sessionIdState.asReadonly();
  readonly url = this.urlState.asReadonly();
  readonly actions = this.actionsState.asReadonly();
  readonly authSegmentActive = this.authSegmentActiveState.asReadonly();
  readonly authSuspected = this.authSuspectedState.asReadonly();
  readonly sessionStatus = this.sessionStatusState.asReadonly();
  readonly interrupted = this.interruptedState.asReadonly();
  readonly connectionState = this.sse.connectionState;

  /** URLs whose auth-suspected prompt the user declined — never re-prompt. */
  private readonly dismissedAuthUrls = new Set<string>();
  private eventsSubscription: Subscription | null = null;

  /** POST /api/sessions, then attach the SSE stream for the live feed. */
  async start(request: StartRecordingRequestInput): Promise<StartRecordingResponse> {
    this.reset();
    this.phaseState.set('starting');
    try {
      const response = await this.api.startRecording(request);
      this.attach(response.sessionId, response.url);
      this.sessionStatusState.set(response.status);
      this.announcer.announce('Recording started');
      return response;
    } catch (error) {
      this.phaseState.set('idle');
      throw error;
    }
  }

  /**
   * Re-attach to a live session after a refresh/deep-link. The server replays
   * its SSE ring buffer to fresh connections, so the action feed is rebuilt.
   * Returns the summary so the caller can redirect when it is not recording.
   */
  async resume(sessionId: string): Promise<SessionSummary> {
    const summary = await this.api.getSession(sessionId);
    if (summary.status === 'recording') {
      this.reset();
      this.attach(sessionId, summary.url);
      this.sessionStatusState.set(summary.status);
    }
    return summary;
  }

  /** POST recording/stop; detaches from SSE on success. */
  async stop(): Promise<StopRecordingResponse> {
    const sessionId = this.requireSessionId();
    this.phaseState.set('stopping');
    try {
      const response = await this.api.stopRecording(sessionId);
      this.detach();
      this.phaseState.set('idle');
      this.authSegmentActiveState.set(false);
      this.sessionStatusState.set(response.status);
      this.announcer.announce('Recording stopped');
      return response;
    } catch (error) {
      this.phaseState.set('recording');
      throw error;
    }
  }

  /**
   * Start a login segment. `fromStep` backdates it (retroactive segment after
   * an auth-suspected prompt — see {@link authSuspectedFromStep}).
   * `authSegmentActive` flips when the recording.auth_segment event arrives.
   */
  async startAuthSegment(fromStep?: number): Promise<void> {
    const sessionId = this.requireSessionId();
    this.authSuspectedState.set(null);
    await this.api.startAuthSegment(
      sessionId,
      fromStep !== undefined ? { fromStep } : {},
    );
  }

  async endAuthSegment(): Promise<void> {
    const sessionId = this.requireSessionId();
    await this.api.endAuthSegment(sessionId);
  }

  /** Decline the auth-suspected prompt; the same URL never prompts again. */
  dismissAuthSuspected(): void {
    const prompt = this.authSuspectedState();
    if (prompt) {
      this.dismissedAuthUrls.add(prompt.url);
      this.authSuspectedState.set(null);
    }
  }

  /** Page handled the interruption (toast + redirect); clear the store. */
  acknowledgeInterrupted(): void {
    this.reset();
  }

  private attach(sessionId: string, url: string): void {
    this.sessionIdState.set(sessionId);
    this.urlState.set(url);
    this.phaseState.set('recording');
    this.eventsSubscription = this.sse.events$.subscribe((event) => this.onEvent(event));
    this.sse.connect(sessionId);
  }

  private detach(): void {
    this.eventsSubscription?.unsubscribe();
    this.eventsSubscription = null;
    this.sse.disconnect();
  }

  private reset(): void {
    this.detach();
    this.phaseState.set('idle');
    this.sessionIdState.set(null);
    this.urlState.set(null);
    this.actionsState.set([]);
    this.authSegmentActiveState.set(false);
    this.authSuspectedState.set(null);
    this.sessionStatusState.set(null);
    this.interruptedState.set(false);
  }

  private onEvent(event: SseEvent): void {
    switch (event.type) {
      case 'recording.action':
        this.actionsState.update((actions) => [...actions, event.action]);
        break;

      case 'recording.auth_segment': {
        const started = event.state === 'started';
        this.authSegmentActiveState.set(started);
        if (started) this.authSuspectedState.set(null);
        this.announcer.announce(
          started
            ? 'Login segment active — actions are not being recorded'
            : 'Login segment ended — recording resumed',
        );
        break;
      }

      case 'recording.auth_suspected':
        if (!this.authSegmentActiveState() && !this.dismissedAuthUrls.has(event.url)) {
          this.authSuspectedState.set({
            reason: event.reason,
            url: event.url,
            suspectedAtStep: event.suspectedAtStep,
          });
        }
        break;

      case 'session.status':
        this.sessionStatusState.set(event.status);
        if (event.status === 'interrupted') {
          // Browser window closed by the user — the session is over.
          this.detach();
          this.phaseState.set('idle');
          this.interruptedState.set(true);
          this.announcer.announce('Recording interrupted — the browser window was closed');
        }
        break;

      default:
        // analysis.* / replay.* events belong to Phase 5/6 pages.
        break;
    }
  }

  private requireSessionId(): string {
    const sessionId = this.sessionIdState();
    if (!sessionId) throw new Error('No active recording session');
    return sessionId;
  }
}
