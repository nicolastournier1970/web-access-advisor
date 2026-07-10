/**
 * Results page ('/sessions/:id/results'): summary header (score meter,
 * snapshots, warnings, provider), merged LLM+axe findings with severity
 * filters and duplicate/auth-step handling (results-view.ts), step
 * screenshots, and print/CSV export.
 */
import {
  ChangeDetectionStrategy,
  Component,
  Injector,
  OnInit,
  afterNextRender,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import type { AnalysisResult, Impact, SessionSummary, StepDetail } from '@waa/shared';
import { AnalysisStore } from '../../core/stores/analysis.store';
import { ApiClient, ApiError } from '../../core/api/api-client';
import { ToastService } from '../../shared/ui/toast.service';
import { ButtonDirective } from '../../shared/ui/button.directive';
import { CardComponent } from '../../shared/ui/card.component';
import { SpinnerComponent } from '../../shared/ui/spinner.component';
import { FindingCardComponent } from './finding-card.component';
import { PhaseBoardComponent, aiSkippedFromWarnings, idlePhaseBoard, type PhaseBoardItem } from '../../shared/ui/phase-board.component';
import {
  SEVERITIES,
  buildResultsView,
  countBySeverity,
  filterFindings,
  type ResultsView,
} from './results-view';
import { buildCsv, csvFilename, downloadCsv } from './csv-export';

type PageState = 'loading' | 'ready' | 'legacy' | 'not-analyzed' | 'error';

/** Sessions in these states have a live analysis → bounce to the analyze page. */
const LIVE_STATUSES = new Set(['replaying', 'awaiting-auth', 'analyzing']);

@Component({
  selector: 'waa-results-page',
  templateUrl: './results-page.html',
  imports: [RouterLink, ButtonDirective, CardComponent, SpinnerComponent, FindingCardComponent, PhaseBoardComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ResultsPage implements OnInit {
  /** Route param via withComponentInputBinding. */
  readonly id = input.required<string>();

  /** v1 ThreePhaseStatus, pinned above the report: all phases complete. */
  protected readonly boardPhases = computed<PhaseBoardItem[]>(() => {
    const result = this.result();
    const board = idlePhaseBoard();
    if (!result) return board;
    const actionCount = result.manifest.actionOutcomes?.length;
    board[0] = {
      key: 'recording',
      status: 'completed',
      message: 'Recording complete',
      ...(actionCount !== undefined ? { details: `${actionCount} actions captured` } : {}),
    };
    board[1] = {
      key: 'replay',
      status: 'completed',
      message: 'Replay complete',
      details: `${result.snapshotCount} snapshots captured`,
    };
    const aiRan = result.analysis !== undefined && !aiSkippedFromWarnings(result.warnings ?? []);
    board[2] = aiRan
      ? { key: 'ai', status: 'completed', message: 'Analysis complete', details: 'Report generated' }
      : { key: 'ai', status: 'skipped', message: 'AI analysis skipped', details: 'Axe results only' };
    return board;
  });

  private readonly store = inject(AnalysisStore);
  private readonly api = inject(ApiClient);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  private readonly injector = inject(Injector);

  protected readonly severities = SEVERITIES;

  protected readonly state = signal<PageState>('loading');
  protected readonly errorMessage = signal<string | null>(null);
  protected readonly result = signal<AnalysisResult | null>(null);
  protected readonly summary = signal<SessionSummary | null>(null);

  protected readonly activeSeverities = signal<ReadonlySet<Impact>>(new Set(SEVERITIES));
  protected readonly showDuplicates = signal(false);
  protected readonly expandedKeys = signal<ReadonlySet<string>>(new Set());

  protected readonly view = computed<ResultsView | null>(() => {
    const result = this.result();
    return result ? buildResultsView(result) : null;
  });

  protected readonly filteredFindings = computed(() => {
    const view = this.view();
    if (!view) return [];
    return filterFindings(view.findings, this.activeSeverities(), this.showDuplicates());
  });

  protected readonly severityCounts = computed(() => {
    const view = this.view();
    return view
      ? countBySeverity(view.findings)
      : ({ critical: 0, serious: 0, moderate: 0, minor: 0 } as Record<Impact, number>);
  });

  protected readonly score = computed(() => this.result()?.analysis?.score ?? null);

  /** Manifest steps with a screenshot on disk (thumbnail strip). */
  protected readonly screenshotSteps = computed<StepDetail[]>(
    () => this.result()?.manifest.stepDetails.filter((s) => s.screenshotFile) ?? [],
  );

  ngOnInit(): void {
    void this.init();
  }

  private async init(): Promise<void> {
    const id = this.id();
    try {
      const result = await this.store.loadResult(id);
      this.result.set(result);
      this.state.set('ready');
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        await this.handleNoAnalysis(id);
      } else {
        this.errorMessage.set(
          error instanceof ApiError ? error.message : 'Could not load the analysis result.',
        );
        this.state.set('error');
      }
    }
  }

  /**
   * GET /analysis 404s: either a live/never-run analysis, or a LEGACY session
   * (manifest.json from the v1 app but no analysis.json) — show the re-run
   * empty state for those.
   */
  private async handleNoAnalysis(id: string): Promise<void> {
    try {
      const summary = await this.api.getSession(id);
      this.summary.set(summary);
      if (LIVE_STATUSES.has(summary.status)) {
        await this.router.navigate(['/sessions', id, 'analyze']);
        return;
      }
      this.state.set(summary.hasAnalysis ? 'legacy' : 'not-analyzed');
    } catch {
      this.toast.show('Session not found.', 'error');
      await this.router.navigate(['/sessions']);
    }
  }

  // ---- Filters ----

  protected toggleSeverity(severity: Impact): void {
    this.activeSeverities.update((current) => {
      const next = new Set(current);
      if (next.has(severity)) next.delete(severity);
      else next.add(severity);
      return next;
    });
  }

  protected toggleDuplicates(): void {
    this.showDuplicates.update((value) => !value);
  }

  // ---- Card expansion ----

  protected isExpanded(key: string): boolean {
    return this.expandedKeys().has(key);
  }

  protected toggleExpanded(key: string): void {
    this.expandedKeys.update((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  protected readonly allExpanded = computed(() => {
    const findings = this.filteredFindings();
    return findings.length > 0 && findings.every((f) => this.expandedKeys().has(f.key));
  });

  protected toggleExpandAll(): void {
    if (this.allExpanded()) {
      this.expandedKeys.set(new Set());
    } else {
      this.expandedKeys.set(new Set(this.filteredFindings().map((f) => f.key)));
    }
  }

  // ---- Export ----

  /** Print / Save as PDF: expand every visible card first so it all prints. */
  protected print(): void {
    this.expandedKeys.set(new Set(this.filteredFindings().map((f) => f.key)));
    afterNextRender(() => window.print(), { injector: this.injector });
  }

  protected exportCsv(): void {
    const view = this.view();
    const result = this.result();
    if (!view || !result) return;
    downloadCsv(buildCsv(view.findings), csvFilename(result));
    this.toast.show('CSV exported.', 'success');
  }

  // ---- Helpers ----

  protected screenshotUrl(step: StepDetail): string {
    return `/api/sessions/${encodeURIComponent(this.id())}/snapshots/${step.step}/screenshot.png`;
  }

  protected severityPressed(severity: Impact): boolean {
    return this.activeSeverities().has(severity);
  }
}
