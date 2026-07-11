/**
 * Hierarchical LLM batching, ported from the legacy analyzer's
 * `groupSnapshotsByFlowType` / `createAnalysisBatches` /
 * `performHierarchicalAnalysis` (packages/core/src/analyzer.ts §1460-1734).
 *
 * BUG FIX vs. legacy: the legacy progressive-summary update APPENDED the whole
 * previous summary inside itself (`summary += "...${summary}...${latest}"`,
 * lines 1600-1601), doubling the context every batch. Here the summary is SET
 * to previous + latest, then trimmed to the last 2000 characters.
 */
import {
  type AxeViolation,
  type FlowType,
  type LlmAnalysis,
  type StaticSectionMode,
  type StepDetail,
} from '@waa/shared';
import type { LlmBatchRequest, LlmProvider } from '../engine-types.js';
import { slimAxeViolations, truncateHtml } from '../llm/slimming.js';
import type { AnalyzerSnapshot } from './manifest-builder.js';

/**
 * Default per-batch token budget (reserves space for the rolling summary).
 * The legacy value (8000, ~32KB of HTML) predates million-token contexts: it
 * forced every real-world page into its own TRUNCATED single-snapshot batch
 * (10 snapshots = 10 sequential LLM calls, each seeing a cut-off DOM). 100k
 * keeps a typical session in one or two batches with whole pages, well under
 * current Flash context (1M) and free-tier per-minute token limits.
 */
export const DEFAULT_MAX_BATCH_TOKENS = 100_000;
/** Rolling-summary cap forwarded to the next batch (legacy value). */
const PROGRESSIVE_SUMMARY_MAX_CHARS = 2000;
/** HTML floor for a snapshot that alone exceeds the batch budget. */
const MIN_OVERSIZED_HTML_CHARS = 2000;

/** Snapshots of one flow type, in capture order (main_app groups sort first). */
export interface SnapshotFlowGroup {
  flowType: FlowType;
  snapshots: AnalyzerSnapshot[];
  tokenEstimate: number;
}

/** One prompt-ready snapshot inside a batch (HTML already budget-truncated). */
export interface BatchSnapshot {
  step: number;
  url: string;
  /** Scrubbed HTML; truncated via truncateHtml when the snapshot was oversized. */
  html: string;
  /** Raw axe violations for this step (slimmed at request-build time). */
  axeViolations: unknown[];
  domChangeDescription: string;
}

/** One LLM analysis batch. */
export interface AnalysisBatch {
  batchId: string;
  flowType: FlowType;
  snapshots: BatchSnapshot[];
  tokenCount: number;
}

/** chars/4 heuristic over what the prompt will carry: HTML + axe JSON. */
function estimateSnapshotTokens(html: string, axeViolations: unknown[]): number {
  return Math.ceil(html.length / 4) + Math.ceil(JSON.stringify(axeViolations ?? []).length / 4);
}

/**
 * Group snapshots by their manifest flow type for hierarchical analysis.
 * Steps flagged `excludeFromAnalysis` (auth/error flows) are dropped entirely;
 * a snapshot without a manifest entry defaults to main_app. Groups are sorted
 * main_app first, then alphabetically (legacy order).
 */
export function groupSnapshotsForAnalysis(
  snapshots: AnalyzerSnapshot[],
  manifestSteps: StepDetail[],
): SnapshotFlowGroup[] {
  const groups = new Map<FlowType, SnapshotFlowGroup>();

  for (const snapshot of snapshots) {
    const stepDetail = manifestSteps.find((s) => s.step === snapshot.step);
    if (stepDetail?.excludeFromAnalysis === true) continue;
    const flowType: FlowType = stepDetail?.flowType ?? 'main_app';
    let group = groups.get(flowType);
    if (group === undefined) {
      group = { flowType, snapshots: [], tokenEstimate: 0 };
      groups.set(flowType, group);
    }
    group.snapshots.push(snapshot);
    group.tokenEstimate += estimateSnapshotTokens(snapshot.scrubbedHtml, snapshot.axeViolations);
  }

  return [...groups.values()].sort((a, b) => {
    if (a.flowType === 'main_app') return -1;
    if (b.flowType === 'main_app') return 1;
    return a.flowType.localeCompare(b.flowType);
  });
}

/** Prompt-ready view of one snapshot (no truncation). */
function toBatchSnapshot(snapshot: AnalyzerSnapshot): BatchSnapshot {
  return {
    step: snapshot.step,
    url: snapshot.url,
    html: snapshot.scrubbedHtml,
    axeViolations: snapshot.axeViolations,
    domChangeDescription: snapshot.change.description,
  };
}

/**
 * Split flow groups into batches capped at `maxTokens` (default 100k). A
 * group that fits becomes one batch; larger groups accumulate snapshots until
 * the cap. A SINGLE snapshot whose own estimate exceeds the cap gets a batch
 * of its own with the HTML truncated (tag-boundary-aware, marker appended) so
 * even a monster page still reaches the model in bounded form.
 */
export function createBatches(
  grouped: SnapshotFlowGroup[],
  maxTokens: number = DEFAULT_MAX_BATCH_TOKENS,
): AnalysisBatch[] {
  const batches: AnalysisBatch[] = [];
  let batchIndex = 0;

  const push = (flowType: FlowType, snapshots: BatchSnapshot[], tokenCount: number): void => {
    batches.push({ batchId: `${flowType}_batch_${batchIndex}`, flowType, snapshots, tokenCount });
    batchIndex++;
  };

  for (const group of grouped) {
    if (group.snapshots.length === 0) continue;
    if (group.tokenEstimate <= maxTokens) {
      push(group.flowType, group.snapshots.map(toBatchSnapshot), group.tokenEstimate);
      continue;
    }

    let current: BatchSnapshot[] = [];
    let currentTokens = 0;
    const flush = (): void => {
      if (current.length === 0) return;
      push(group.flowType, current, currentTokens);
      current = [];
      currentTokens = 0;
    };

    for (const snapshot of group.snapshots) {
      const tokens = estimateSnapshotTokens(snapshot.scrubbedHtml, snapshot.axeViolations);
      if (tokens > maxTokens) {
        // Oversized snapshot: its own batch, HTML truncated to the remaining
        // budget after the axe JSON (floored so some markup always survives).
        flush();
        const axeTokens = Math.ceil(JSON.stringify(snapshot.axeViolations ?? []).length / 4);
        const htmlBudgetChars = Math.max(MIN_OVERSIZED_HTML_CHARS, (maxTokens - axeTokens) * 4);
        const truncated: BatchSnapshot = {
          ...toBatchSnapshot(snapshot),
          html: truncateHtml(snapshot.scrubbedHtml, htmlBudgetChars),
        };
        push(group.flowType, [truncated], estimateSnapshotTokens(truncated.html, truncated.axeViolations));
        continue;
      }
      if (currentTokens + tokens > maxTokens && current.length > 0) {
        flush();
      }
      current.push(toBatchSnapshot(snapshot));
      currentTokens += tokens;
    }
    flush();
  }

  return batches;
}

/** Options for {@link runLlmAnalysis}. */
export interface RunLlmAnalysisOptions {
  batches: AnalysisBatch[];
  provider: LlmProvider;
  /** Session start URL, forwarded to provider.consolidate. */
  sessionUrl: string;
  staticSectionMode: StaticSectionMode;
  /** Per-batch provider timeout in milliseconds. */
  timeoutMs: number;
  /** Invoked before each batch is sent (1-based `current`). */
  onBatch?: (current: number, total: number, flowType: FlowType) => void;
  /** Invoked when a batch fails (it is skipped, the others still run). */
  onBatchError?: (batchId: string, error: unknown) => void;
}

/**
 * Run the batches through the provider sequentially with a rolling summary:
 *  - each request carries the slimmed axe violations and the accumulated
 *    `progressiveSummary` of every PREVIOUS batch (correctly set once per
 *    batch — see module header — and trimmed to its last 2000 chars);
 *  - each returned component is re-anchored to its step's URL via the batch's
 *    step→url map (fallback: the batch's first snapshot);
 *  - a failed batch is skipped (the others still run), matching legacy — but
 *    unlike legacy the failure is REPORTED via `onBatchError` so an empty
 *    analysis always comes with a visible reason;
 *  - the batch analyses are merged via `provider.consolidate`.
 */
export async function runLlmAnalysis(opts: RunLlmAnalysisOptions): Promise<LlmAnalysis> {
  const { batches, provider, sessionUrl, staticSectionMode, timeoutMs } = opts;
  const batchResults: LlmAnalysis[] = [];
  let progressiveSummary = '';

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]!;
    opts.onBatch?.(i + 1, batches.length, batch.flowType);

    const request: LlmBatchRequest = {
      batchId: batch.batchId,
      snapshots: batch.snapshots.map((snapshot) => ({
        step: snapshot.step,
        url: snapshot.url,
        html: snapshot.html,
        // Raw axe entries are unknown; slimAxeViolations is defensive against
        // malformed items (drops entries without id/impact/nodes).
        axeViolationsJson: JSON.stringify(
          slimAxeViolations(snapshot.axeViolations as AxeViolation[]),
        ),
        domChangeDescription: snapshot.domChangeDescription,
      })),
      ...(progressiveSummary.length > 0 ? { progressiveSummary } : {}),
      staticSectionMode,
    };

    let result: LlmAnalysis;
    try {
      result = await provider.analyzeBatch(request, timeoutMs);
    } catch (error) {
      // One failed batch never sinks the whole analysis, but it must not be
      // silent either (a retired model once 404'd every batch and the run
      // still reported success with score 100).
      opts.onBatchError?.(batch.batchId, error);
      continue;
    }

    // Re-anchor components to the exact URL of their step (legacy step-URL map).
    const urlByStep = new Map(batch.snapshots.map((s) => [s.step, s.url]));
    const fallback = batch.snapshots[0];
    for (const component of result.components) {
      const mapped = component.step !== undefined ? urlByStep.get(component.step) : undefined;
      if (mapped !== undefined) {
        component.url = mapped;
      } else if (fallback !== undefined) {
        component.url = fallback.url;
        component.step = component.step ?? fallback.step;
      }
    }

    batchResults.push(result);

    // FIXED progressive summary: SET to previous + latest (never re-embed the
    // previous summary inside itself), then keep only the trailing 2000 chars.
    if (result.summary.length > 0) {
      progressiveSummary =
        progressiveSummary.length > 0
          ? `${progressiveSummary}\n\n--- Latest Batch Summary ---\n${result.summary}`
          : result.summary;
      if (progressiveSummary.length > PROGRESSIVE_SUMMARY_MAX_CHARS) {
        progressiveSummary =
          '...(previous context truncated)...\n' +
          progressiveSummary.slice(-PROGRESSIVE_SUMMARY_MAX_CHARS);
      }
    }
  }

  return provider.consolidate(batchResults, sessionUrl);
}
