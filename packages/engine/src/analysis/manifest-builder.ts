/**
 * Session manifest assembly + axe-violation consolidation, ported from the
 * legacy analyzer's `generateManifest` / `createEnhancedStepDetails` /
 * `consolidateAxeResults` (packages/core/src/analyzer.ts).
 *
 * BUG FIX vs. legacy: `createEnhancedStepDetails` joined `actions[i]` with
 * `snapshots[i]` BY ARRAY INDEX, so any skipped snapshot shifted every later
 * step's action attribution (a snapshot captured at step 4 was described with
 * the step-2 action). Here every join — action, replay outcome — is ON THE
 * STEP NUMBER, never on array position.
 */
import path from 'node:path';
import {
  axeViolationSchema,
  type ActionV2,
  type AuthDomainsConfig,
  type AxeViolation,
  type FlowType,
  type LlmAnalysis,
  type RecordingV2,
  type SessionManifest,
  type StepDetail,
} from '@waa/shared';
import { classifyFlowType } from '../auth/login-detection.js';
import type { DomChangeDetails } from '../snapshot/dom-change-detector.js';
import type { SnapshotRecord } from '../snapshot/snapshotter.js';
import type { ActionOutcome } from '../replay/replayer.js';

/**
 * One captured snapshot enriched with the replay context the manifest needs:
 * the classified DOM change that triggered the capture and the capture time.
 * Produced by the analyzer loop; consumed here and by analysis/batching.ts.
 */
export interface AnalyzerSnapshot extends SnapshotRecord {
  /** Classified DOM diff computed just before this snapshot was captured. */
  change: DomChangeDetails;
  /** ISO timestamp of the capture. */
  capturedAt: string;
}

/** Replay outcome of one action, keyed by its STEP (not its array index). */
export interface ActionOutcomeRecord extends ActionOutcome {
  step: number;
}

/** Input for {@link buildManifest}. */
export interface BuildManifestInput {
  recording: RecordingV2;
  snapshots: AnalyzerSnapshot[];
  outcomes: ActionOutcomeRecord[];
  /** The session's start URL — the same-site anchor for flow classification. */
  sessionUrl: string;
  authConfig: AuthDomainsConfig;
  /** True when the replay was aborted (auth cancel/timeout, fatal error). */
  truncated?: boolean;
  truncationReason?: string;
}

/** Legacy action-type → StepDetail.actionType category mapping. */
const ACTION_TYPE_MAP: Record<string, StepDetail['actionType']> = {
  navigate: 'navigation',
  click: 'interaction',
  fill: 'form_input',
  select: 'form_input',
  scroll: 'navigation',
  hover: 'interaction',
};

/** Legacy human-readable flow descriptions (actionGroups). */
function flowDescription(flowType: FlowType): string {
  switch (flowType) {
    case 'main_app':
      return 'Primary application functionality';
    case 'auth_flow':
      return 'Authentication and authorization flow';
    case 'error_flow':
      return 'Error handling and error pages';
    case 'external_redirect':
      return 'External site redirects and third-party services';
  }
}

/** chars/4 token heuristic (legacy estimateTokens, applied to the HTML). */
function estimateHtmlTokens(htmlLength: number): number {
  return Math.ceil(htmlLength / 4);
}

/**
 * Build the session manifest from the replay's snapshots and outcomes.
 *
 * Every snapshot's action is `recording.actions.find(a => a.step ===
 * snapshot.step)` and its outcome is looked up by the same step, so gated
 * (skipped) snapshots can never shift attribution. The
 * parentStep/previousStep/nextStep chain runs over the SNAPSHOT steps in
 * capture order (a snapshot's neighbours are the adjacent captures, not the
 * adjacent recorded actions).
 */
export function buildManifest(input: BuildManifestInput): SessionManifest {
  const { recording, snapshots, outcomes, sessionUrl, authConfig } = input;

  const stepDetails: StepDetail[] = snapshots.map((snapshot, index) => {
    // THE FIX: join on step, never on array index.
    const action: ActionV2 | undefined = recording.actions.find((a) => a.step === snapshot.step);
    const outcome = outcomes.find((o) => o.step === snapshot.step);
    const previous = index > 0 ? snapshots[index - 1] : undefined;
    const next = index < snapshots.length - 1 ? snapshots[index + 1] : undefined;

    const flowType = classifyFlowType(snapshot.url, sessionUrl, authConfig);
    const isAuthRelated = flowType === 'auth_flow';
    const excludeFromAnalysis = isAuthRelated || flowType === 'error_flow';
    const skipReason = isAuthRelated
      ? 'Authentication flow - not relevant for UI accessibility'
      : flowType === 'error_flow'
        ? 'Error page - not part of main user flow'
        : undefined;

    const interactionTarget = action?.target?.description ?? action?.selector;

    const detail: StepDetail = {
      step: snapshot.step,
      parentStep: previous?.step ?? null,
      action: action?.type ?? 'unknown',
      actionType: action !== undefined ? (ACTION_TYPE_MAP[action.type] ?? 'other') : 'other',
      flowContext: 'main_flow',
      uiState: 'default',
      timestamp: action?.timestamp ?? snapshot.capturedAt,
      htmlFile: path.basename(snapshot.files.html),
      axeFile: path.basename(snapshot.files.axeContext),
      axeResultsFile: path.basename(snapshot.files.axeResults),
      url: snapshot.url,
      domChangeType: snapshot.change.type,
      domChanges: snapshot.change.description,
      tokenEstimate: estimateHtmlTokens(snapshot.scrubbedHtml.length),
      isAuthRelated,
      excludeFromAnalysis,
      flowType,
      domChangeSummary: {
        elementsAdded: snapshot.change.elementsAdded,
        elementsRemoved: snapshot.change.elementsRemoved,
        ariaChanges: [],
        liveRegionUpdates: [],
        significantChange: snapshot.change.significant,
      },
    };
    if (interactionTarget !== undefined) detail.interactionTarget = interactionTarget;
    if (snapshot.files.screenshot !== undefined) {
      detail.screenshotFile = path.basename(snapshot.files.screenshot);
    }
    if (previous !== undefined) detail.previousStep = previous.step;
    if (next !== undefined) detail.nextStep = next.step;
    if (skipReason !== undefined) detail.skipReason = skipReason;
    if (outcome !== undefined) {
      detail.actionOutcome = outcome.outcome;
      if (outcome.detail !== undefined) detail.actionOutcomeDetail = outcome.detail;
    }
    return detail;
  });

  const manifest: SessionManifest = {
    sessionId: recording.sessionId,
    url: sessionUrl,
    timestamp: new Date().toISOString(),
    totalSteps: snapshots.length,
    stepDetails,
    // Every recorded action's replay outcome — stepDetails only cover snapshot
    // steps, so failed/skipped/unreached actions would otherwise be invisible.
    actionOutcomes: recording.actions.map((action) => {
      const outcome = outcomes.find((o) => o.step === action.step);
      return {
        step: action.step,
        type: action.type,
        outcome: outcome?.outcome ?? ('skipped' as const),
        ...(outcome?.detail !== undefined
          ? { detail: outcome.detail }
          : outcome === undefined
            ? { detail: 'not-reached' }
            : {}),
        ...(outcome?.resolvedBy !== undefined ? { resolvedBy: outcome.resolvedBy } : {}),
      };
    }),
    actionGroups: buildActionGroups(stepDetails),
    flowStatistics: {
      totalSteps: stepDetails.length,
      authSteps: stepDetails.filter((s) => s.flowType === 'auth_flow').length,
      mainAppSteps: stepDetails.filter((s) => s.flowType === 'main_app').length,
      errorSteps: stepDetails.filter((s) => s.flowType === 'error_flow').length,
      significantDOMChanges: stepDetails.filter((s) => s.domChangeSummary?.significantChange === true)
        .length,
      accessibilityEvents: 0,
    },
    llmOptimizations: {
      authStepsFiltered: stepDetails.filter((s) => s.isAuthRelated).length,
      relevantStepsForAnalysis: stepDetails.filter((s) => !s.excludeFromAnalysis).length,
      totalTokenEstimate: stepDetails.reduce((sum, s) => sum + s.tokenEstimate, 0),
    },
    recordingContext: {
      useProfile: recording.useProfile ?? false,
      authenticationState: 'unknown',
      recordingNote: recording.useProfile
        ? `Recorded with ${recording.browserName ?? recording.browserType ?? 'browser'} profile - may include saved logins`
        : 'Recorded without profile - clean browser session',
      ...(recording.browserType !== undefined ? { browserType: recording.browserType } : {}),
      ...(recording.browserName !== undefined ? { browserName: recording.browserName } : {}),
    },
  };
  if (input.truncated === true) {
    manifest.truncated = true;
    if (input.truncationReason !== undefined) manifest.truncationReason = input.truncationReason;
  }
  return manifest;
}

/** Legacy generateActionGroups: consecutive stepDetails sharing a flowType. */
function buildActionGroups(stepDetails: StepDetail[]): SessionManifest['actionGroups'] {
  const groups: NonNullable<SessionManifest['actionGroups']> = [];
  let currentSteps: StepDetail[] = [];
  let currentFlowType: FlowType | null = null;
  let groupCounter = 0;

  const flush = (): void => {
    if (currentSteps.length === 0 || currentFlowType === null) return;
    groupCounter++;
    groups.push({
      groupId: `${currentFlowType}_${groupCounter}`,
      steps: currentSteps.map((s) => s.step),
      description: flowDescription(currentFlowType),
      flowType: currentFlowType,
      relevantForAnalysis: currentFlowType === 'main_app',
      tokenEstimate: currentSteps.reduce((sum, s) => sum + s.tokenEstimate, 0),
    });
  };

  for (const step of stepDetails) {
    if (step.flowType !== currentFlowType) {
      flush();
      currentSteps = [step];
      currentFlowType = step.flowType;
    } else {
      currentSteps.push(step);
    }
  }
  flush();
  return groups;
}

// ---------------------------------------------------------------------------
// Axe consolidation
// ---------------------------------------------------------------------------

/** Sort order used for the consolidated violation list (legacy-preserved). */
const IMPACT_ORDER: Record<string, number> = { critical: 0, serious: 1, moderate: 2, minor: 3 };

/** Stable identity of a violation: rule id + SORTED node target selectors. */
function violationKey(violation: AxeViolation): string {
  const targets = violation.nodes
    .map((node) =>
      node.target.map((entry) => (Array.isArray(entry) ? entry.join(' >> ') : entry)).join(' '),
    )
    .sort()
    .join('|');
  return `${violation.id}:${targets}`;
}

/**
 * Port of the legacy `consolidateAxeResults`:
 *  - collect each snapshot's violations, deduplicating by rule id + sorted
 *    node targets; the first occurrence keeps its step/url and every further
 *    occurrence only appends to `stepOccurrences`;
 *  - merge the LLM's `enhancedAxeViolations` by rule id (explanation,
 *    recommendation, `wcag` → `wcagReference` with any stray 'WCAG ' prefix
 *    stripped from the guideline);
 *  - sort by impact severity (critical → serious → moderate → minor → none).
 *
 * Raw snapshot violations are `unknown` (they come straight from axe-core);
 * entries that fail the axe-violation schema are dropped instead of throwing.
 */
export function consolidateAxeViolations(
  snapshots: AnalyzerSnapshot[],
  llmAnalysis?: LlmAnalysis,
): AxeViolation[] {
  const byKey = new Map<string, AxeViolation>();

  for (const snapshot of snapshots) {
    for (const raw of snapshot.axeViolations) {
      const parsed = axeViolationSchema.safeParse(raw);
      if (!parsed.success) continue;
      const violation = parsed.data;
      const key = violationKey(violation);
      const existing = byKey.get(key);
      if (existing === undefined) {
        byKey.set(key, {
          ...violation,
          step: snapshot.step,
          url: snapshot.url,
          // Legacy field kept for manifest/report parity (schema catchall).
          firstSeenStep: snapshot.step,
          stepOccurrences: [snapshot.step],
        });
      } else if (!existing.stepOccurrences?.includes(snapshot.step)) {
        existing.stepOccurrences = [...(existing.stepOccurrences ?? []), snapshot.step];
      }
    }
  }

  const violations = [...byKey.values()];

  const enhanced = llmAnalysis?.enhancedAxeViolations ?? [];
  for (const violation of violations) {
    const match = enhanced.find((e) => e.id === violation.id);
    if (match === undefined) continue;
    violation.explanation = match.explanation;
    violation.recommendation = match.recommendation;
    if (match.wcag !== undefined) {
      violation.wcagReference = {
        ...match.wcag,
        guideline: match.wcag.guideline.replace(/^WCAG\s+/, ''),
      };
    }
  }

  return violations.sort(
    (a, b) => (IMPACT_ORDER[a.impact ?? ''] ?? 4) - (IMPACT_ORDER[b.impact ?? ''] ?? 4),
  );
}
