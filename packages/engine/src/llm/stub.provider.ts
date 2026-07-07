/**
 * Deterministic no-network LlmProvider for unit tests, e2e and CI
 * (LLM_PROVIDER=stub — see docs/adr/0006). Output is derived purely from the
 * request so identical inputs always yield identical, schema-valid analyses.
 */
import { llmAnalysisSchema, type ComponentIssue, type LlmAnalysis } from '@waa/shared';
import type { LlmBatchRequest, LlmProvider } from '../engine-types.js';

/** Fixed score so downstream score plumbing is observable in tests. */
const STUB_SCORE = 42;

/**
 * Best-effort extraction of a CSS selector from a snapshot's slimmed axe
 * violations JSON: first violation, first node, first target entry (a
 * shadow-DOM chain array is joined with ' >> '). Returns undefined when the
 * JSON is empty, malformed, or carries no usable target.
 */
function firstViolationSelector(axeViolationsJson: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(axeViolationsJson);
    const violations = Array.isArray(parsed)
      ? parsed
      : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { violations?: unknown }).violations)
        ? (parsed as { violations: unknown[] }).violations
        : [];
    const first = violations[0] as { nodes?: Array<{ target?: unknown[] }> } | undefined;
    const target = first?.nodes?.[0]?.target?.[0];
    if (typeof target === 'string' && target.length > 0) return target;
    if (Array.isArray(target) && target.length > 0) {
      return target.filter((t): t is string => typeof t === 'string').join(' >> ') || undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Canned provider: one moderate ComponentIssue per snapshot, summary counting
 * the snapshots, fixed score. Everything is validated through
 * llmAnalysisSchema before being returned, exactly like real providers.
 */
export class StubProvider implements LlmProvider {
  readonly name = 'stub';

  /** Deterministic canned analysis; `timeoutMs` is accepted but irrelevant. */
  async analyzeBatch(request: LlmBatchRequest, _timeoutMs: number): Promise<LlmAnalysis> {
    const components = request.snapshots.map((snapshot) => {
      const selector = firstViolationSelector(snapshot.axeViolationsJson);
      return {
        componentName: `Stub component (step ${snapshot.step})`,
        issue: `Deterministic stub issue reported for step ${snapshot.step}.`,
        explanation:
          'Canned finding produced by the stub LLM provider; no model was consulted.',
        relevantHtml: '',
        correctedCode: '',
        codeChangeSummary: '',
        impact: 'moderate',
        wcagRule: '4.1.2',
        wcagUrl: 'https://www.w3.org/WAI/WCAG21/Understanding/name-role-value.html',
        ...(selector !== undefined ? { selector } : {}),
        step: snapshot.step,
        url: snapshot.url,
      };
    });

    return llmAnalysisSchema.parse({
      summary: `Stub analysis of ${request.snapshots.length} snapshot(s) in batch ${request.batchId}.`,
      components,
      recommendations: [
        'Stub provider output: configure a real LLM provider for genuine analysis.',
      ],
      score: STUB_SCORE,
    });
  }

  /**
   * Local merge: concatenates batch components deduplicating by componentName
   * (first occurrence wins), merges recommendations, keeps the fixed score.
   */
  async consolidate(batches: LlmAnalysis[], sessionUrl: string): Promise<LlmAnalysis> {
    const byName = new Map<string, ComponentIssue>();
    for (const batch of batches) {
      for (const component of batch.components) {
        if (!byName.has(component.componentName)) byName.set(component.componentName, component);
      }
    }
    const recommendations = [...new Set(batches.flatMap((b) => b.recommendations))];

    return llmAnalysisSchema.parse({
      summary: `Stub consolidation of ${batches.length} batch(es) for ${sessionUrl}: ${byName.size} unique component(s).`,
      components: [...byName.values()],
      recommendations,
      score: STUB_SCORE,
    });
  }
}
