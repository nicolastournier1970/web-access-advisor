/**
 * Deterministic no-network LlmProvider for unit tests, e2e and CI
 * (LLM_PROVIDER=stub — see docs/adr/0006). Output is derived purely from the
 * request so identical inputs always yield identical, schema-valid analyses.
 */
import { llmAnalysisSchema, type ComponentIssue, type LlmAnalysis } from '@waa/shared';
import type { LlmBatchRequest, LlmProvider } from '../engine-types.js';

/** Fixed score so downstream score plumbing is observable in tests. */
const STUB_SCORE = 42;

type EnhancedAxeEntry = NonNullable<LlmAnalysis['enhancedAxeViolations']>[number];

/** Minimal view of one slimmed axe violation from a snapshot's JSON payload. */
interface ViolationView {
  id: string;
  firstNodeHtml: string;
  firstNodeSelector?: string;
}

/**
 * Best-effort parse of a snapshot's slimmed axe violations JSON into
 * {@link ViolationView}s (shadow-DOM target chains are joined with ' >> ').
 * Malformed JSON or entries without a string id yield an empty list / are
 * dropped, mirroring how lenient real providers must be with their input.
 */
function parseViolations(axeViolationsJson: string): ViolationView[] {
  try {
    const parsed: unknown = JSON.parse(axeViolationsJson);
    const violations = Array.isArray(parsed)
      ? parsed
      : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { violations?: unknown }).violations)
        ? (parsed as { violations: unknown[] }).violations
        : [];
    const views: ViolationView[] = [];
    for (const raw of violations) {
      if (typeof raw !== 'object' || raw === null) continue;
      const { id, nodes } = raw as { id?: unknown; nodes?: Array<{ html?: unknown; target?: unknown[] }> };
      if (typeof id !== 'string' || id.length === 0) continue;
      const firstNode = Array.isArray(nodes) ? nodes[0] : undefined;
      const target = firstNode?.target?.[0];
      const selector =
        typeof target === 'string' && target.length > 0
          ? target
          : Array.isArray(target)
            ? target.filter((t): t is string => typeof t === 'string').join(' >> ') || undefined
            : undefined;
      views.push({
        id,
        firstNodeHtml: typeof firstNode?.html === 'string' ? firstNode.html : '',
        ...(selector !== undefined ? { firstNodeSelector: selector } : {}),
      });
    }
    return views;
  } catch {
    return [];
  }
}

/**
 * Canned provider: one moderate ComponentIssue per snapshot, one enhanced
 * entry (with corrected code) per distinct axe violation id, summary counting
 * the snapshots, fixed score. Everything is validated through
 * llmAnalysisSchema before being returned, exactly like real providers.
 */
export class StubProvider implements LlmProvider {
  readonly name = 'stub';

  /** Deterministic canned analysis; `timeoutMs` is accepted but irrelevant. */
  async analyzeBatch(request: LlmBatchRequest, _timeoutMs: number): Promise<LlmAnalysis> {
    const enhancedById = new Map<string, EnhancedAxeEntry>();
    const components = request.snapshots.map((snapshot) => {
      const violations = parseViolations(snapshot.axeViolationsJson);
      for (const violation of violations) {
        if (enhancedById.has(violation.id)) continue;
        enhancedById.set(violation.id, {
          id: violation.id,
          explanation: `Stub explanation for axe rule '${violation.id}'.`,
          recommendation: `Stub recommendation for axe rule '${violation.id}'. Reference: https://dequeuniversity.com/rules/axe/${violation.id}`,
          correctedCode: `${violation.firstNodeHtml}<!-- stub fix: ${violation.id} -->`,
          codeChangeSummary: `Stub fix for '${violation.id}'.`,
          wcag: {
            guideline: '4.1.2',
            level: 'A',
            title: 'Name, Role, Value',
            url: 'https://www.w3.org/WAI/WCAG21/Understanding/name-role-value.html',
          },
        });
      }
      const selector = violations[0]?.firstNodeSelector;
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
      ...(enhancedById.size > 0 ? { enhancedAxeViolations: [...enhancedById.values()] } : {}),
      recommendations: [
        'Stub provider output: configure a real LLM provider for genuine analysis.',
      ],
      score: STUB_SCORE,
    });
  }

  /**
   * Local merge: concatenates batch components deduplicating by componentName
   * (first occurrence wins), merges enhanced axe violations by id (first
   * wins), merges recommendations, keeps the fixed score.
   */
  async consolidate(batches: LlmAnalysis[], sessionUrl: string): Promise<LlmAnalysis> {
    const byName = new Map<string, ComponentIssue>();
    const enhancedById = new Map<string, EnhancedAxeEntry>();
    for (const batch of batches) {
      for (const component of batch.components) {
        if (!byName.has(component.componentName)) byName.set(component.componentName, component);
      }
      for (const enhanced of batch.enhancedAxeViolations ?? []) {
        if (!enhancedById.has(enhanced.id)) enhancedById.set(enhanced.id, enhanced);
      }
    }
    const recommendations = [...new Set(batches.flatMap((b) => b.recommendations))];

    return llmAnalysisSchema.parse({
      summary: `Stub consolidation of ${batches.length} batch(es) for ${sessionUrl}: ${byName.size} unique component(s).`,
      components: [...byName.values()],
      ...(enhancedById.size > 0 ? { enhancedAxeViolations: [...enhancedById.values()] } : {}),
      recommendations,
      score: STUB_SCORE,
    });
  }
}
