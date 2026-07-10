/**
 * Analyze page ('/sessions/:id/analyze'): start panel (options + Start), the
 * three-phase progress board driven by analysis.progress SSE events, the
 * pause-for-login banner (§6), and error/retry handling. Navigates to the
 * results page on analysis.complete.
 */
import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import type { SessionSummary, StaticSectionMode } from '@waa/shared';
import { AnalysisStore, boardPhaseFor } from '../../core/stores/analysis.store';
import { ApiClient, ApiError } from '../../core/api/api-client';
import { ToastService } from '../../shared/ui/toast.service';
import { ButtonDirective } from '../../shared/ui/button.directive';
import { CardComponent } from '../../shared/ui/card.component';
import { SpinnerComponent } from '../../shared/ui/spinner.component';
import {
  PhaseBoardComponent,
  aiSkippedFromWarnings,
  idlePhaseBoard,
  type PhaseBoardItem,
} from '../../shared/ui/phase-board.component';
import { AuthPauseBannerComponent } from './auth-pause-banner.component';

/** Sessions in these states have a live analysis to re-attach to. */
const LIVE_STATUSES = new Set(['replaying', 'awaiting-auth', 'analyzing']);

@Component({
  selector: 'waa-analyze-page',
  templateUrl: './analyze-page.html',
  imports: [
    RouterLink,
    ButtonDirective,
    CardComponent,
    SpinnerComponent,
    PhaseBoardComponent,
    AuthPauseBannerComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AnalyzePage implements OnInit, OnDestroy {
  /** Route param via withComponentInputBinding. */
  readonly id = input.required<string>();

  protected readonly store = inject(AnalysisStore);
  private readonly api = inject(ApiClient);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);

  protected readonly loading = signal(true);
  protected readonly summary = signal<SessionSummary | null>(null);
  protected readonly starting = signal(false);

  // Start-panel options ("Smart"/"All"/"None" → separate/include/ignore).
  protected readonly staticSectionMode = signal<StaticSectionMode>('separate');
  protected readonly captureScreenshots = signal(true);

  /** Show the start panel when nothing is running/failed for this session. */
  protected readonly showStartPanel = computed(
    () =>
      !this.loading() &&
      !this.store.running() &&
      !this.store.error() &&
      !this.store.completed(),
  );

  /** Three-phase board (v1 ThreePhaseStatus mapping — see boardPhaseFor). */
  protected readonly phases = computed<PhaseBoardItem[]>(() => {
    const phase = this.store.phase();
    const error = this.store.error();
    const board = phase ? boardPhaseFor(phase) : null;
    const paused = this.store.authPause() !== null;
    const snapshots = this.store.snapshotCount();
    const actionCount = this.summary()?.actionCount;

    // On this page the recording is always done; replay/ai start from v1 idle copy.
    const cards = idlePhaseBoard();
    const [recording, replay, ai] = cards;
    recording.status = 'completed';
    recording.message = 'Recording complete';
    recording.details = actionCount !== undefined ? `${actionCount} actions captured` : '';
    const snapshotDetails = snapshots !== null ? `${snapshots} snapshots captured` : '';

    if (board === 'replay') {
      replay.status = 'active';
      replay.message = paused
        ? 'Paused — waiting for sign-in'
        : this.store.message() || 'Replaying interactions...';
      replay.details = snapshotDetails || 'Processing interactions';
      ai.message = 'Waiting for replay';
      ai.details = 'Analysis will begin after replay completes';
    } else if (board === 'ai') {
      replay.status = 'completed';
      replay.message = 'Replay complete';
      replay.details = snapshotDetails;
      ai.status = 'active';
      ai.message = this.store.message() || 'AI analysis in progress...';
      const batchCurrent = this.store.batchCurrent();
      const batchTotal = this.store.batchTotal();
      ai.details =
        batchCurrent !== null && batchTotal !== null
          ? `Processing batch ${batchCurrent}/${batchTotal}`
          : 'Analyzing accessibility data';
    } else if (board === 'done') {
      replay.status = 'completed';
      replay.message = 'Replay complete';
      replay.details = snapshotDetails;
      if (snapshots === 0) {
        ai.status = 'skipped';
        ai.message = 'Analysis skipped';
        ai.details = 'No snapshots to analyze';
      } else if (aiSkippedFromWarnings(this.store.warnings())) {
        ai.status = 'skipped';
        ai.message = 'AI analysis skipped';
        ai.details = 'AI provider not configured';
      } else {
        ai.status = 'completed';
        ai.message = 'Analysis complete';
        ai.details = 'Report generated';
      }
    }

    if (error) {
      const errored = board === 'ai' || board === 'done' ? ai : replay;
      if (errored === ai) {
        replay.status = 'completed';
        replay.message = 'Replay complete';
        replay.details = snapshotDetails;
      }
      errored.status = 'error';
      errored.message = errored === ai ? 'AI analysis failed' : 'Replay failed';
      errored.details = '';
      errored.error = error;
    }
    return cards;
  });

  /** Determinate progress (replay steps or AI batches), when totals are known. */
  protected readonly progress = computed(() => {
    const phase = this.store.phase();
    if (!phase || this.store.error()) return null;
    const board = boardPhaseFor(phase);
    if (board === 'replay') {
      const max = this.store.totalSteps();
      if (max) {
        const value = Math.min(this.store.currentStep() ?? 0, max);
        return { value, max, label: `Replay progress: step ${value} of ${max}` };
      }
    } else if (board === 'ai') {
      const max = this.store.batchTotal();
      if (max) {
        const value = Math.min(this.store.batchCurrent() ?? 0, max);
        return { value, max, label: `AI analysis progress: batch ${value} of ${max}` };
      }
    }
    return null;
  });

  constructor() {
    // analysis.complete → results page.
    effect(() => {
      if (this.store.completed() && this.store.sessionId() === this.id()) {
        void this.router.navigate(['/sessions', this.id(), 'results']);
      }
    });
  }

  ngOnInit(): void {
    void this.init();
  }

  ngOnDestroy(): void {
    // The analysis keeps running server-side; a revisit re-attaches via the
    // SSE ring buffer replay.
    this.store.detach();
  }

  private async init(): Promise<void> {
    const id = this.id();
    if (this.store.sessionId() === id && this.store.running()) {
      this.loading.set(false);
      return;
    }
    try {
      const summary = await this.api.getSession(id);
      this.summary.set(summary);
      if (summary.status === 'analyzed' && (await this.hasStoredResult(id))) {
        // Already analyzed (result loads) → straight to results. Legacy
        // sessions are 'analyzed' from their manifest but have no
        // analysis.json — those fall through to the start panel (re-run).
        await this.router.navigate(['/sessions', id, 'results']);
        return;
      }
      if (summary.status === 'recording') {
        await this.router.navigate(['/sessions', id, 'record']);
        return;
      }
      if (LIVE_STATUSES.has(summary.status)) {
        this.store.resume(id);
      }
      // recorded / failed / interrupted → start panel.
    } catch {
      this.toast.show('Session not found.', 'error');
      await this.router.navigate(['/sessions']);
      return;
    } finally {
      this.loading.set(false);
    }
  }

  /** True when GET /analysis succeeds (404 = legacy manifest-only session). */
  private async hasStoredResult(id: string): Promise<boolean> {
    try {
      await this.store.loadResult(id);
      return true;
    } catch {
      return false;
    }
  }

  protected async start(): Promise<void> {
    this.starting.set(true);
    try {
      await this.store.start(this.id(), {
        staticSectionMode: this.staticSectionMode(),
        captureScreenshots: this.captureScreenshots(),
      });
    } catch (error) {
      this.toast.show(
        error instanceof ApiError ? error.message : 'Could not start the analysis.',
        'error',
      );
    } finally {
      this.starting.set(false);
    }
  }

  protected async continueAuth(): Promise<void> {
    try {
      await this.store.continueAuth();
    } catch {
      // The failure reason is surfaced inline in the banner by the store.
    }
  }

  protected async cancelAuth(): Promise<void> {
    try {
      await this.store.cancelAuth();
    } catch (error) {
      this.toast.show(
        error instanceof ApiError ? error.message : 'Could not cancel the sign-in wait.',
        'error',
      );
    }
  }

  protected onModeChange(value: string): void {
    if (value === 'separate' || value === 'include' || value === 'ignore') {
      this.staticSectionMode.set(value);
    }
  }
}
