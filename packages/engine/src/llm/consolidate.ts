/**
 * Local (no-network) merge of per-batch LlmAnalysis results into one, shared by
 * every network provider (Gemini/Claude/OpenAI/Ollama). Extracted verbatim from
 * the original GeminiProvider.consolidate so behaviour is identical across
 * providers: components deduped by componentName+selector (longest
 * explanation/correctedCode wins), enhanced violations deduped by id, mean
 * score, and a human-readable consolidation summary.
 *
 * StubProvider deliberately keeps its own canned name-only merge — it is a test
 * fixture, not a real provider, and sharing this would churn its snapshots for
 * no product gain.
 */
import { llmAnalysisSchema, type ComponentIssue, type LlmAnalysis } from '@waa/shared';
import { buildConsolidationNote } from './prompts.js';

export function consolidateAnalyses(batches: LlmAnalysis[], sessionUrl: string): LlmAnalysis {
  const componentsByKey = new Map<string, ComponentIssue>();
  for (const batch of batches) {
    for (const component of batch.components) {
      const key = `${component.componentName}::${component.selector ?? ''}`;
      const existing = componentsByKey.get(key);
      if (!existing) {
        componentsByKey.set(key, { ...component });
      } else {
        if (component.explanation.length > existing.explanation.length) {
          existing.explanation = component.explanation;
        }
        if (component.correctedCode.length > existing.correctedCode.length) {
          existing.correctedCode = component.correctedCode;
        }
      }
    }
  }

  const enhancedById = new Map<string, NonNullable<LlmAnalysis['enhancedAxeViolations']>[number]>();
  for (const batch of batches) {
    for (const violation of batch.enhancedAxeViolations ?? []) {
      if (!enhancedById.has(violation.id)) enhancedById.set(violation.id, violation);
    }
  }

  const recommendations = [...new Set(batches.flatMap((b) => b.recommendations))];
  const scores = batches.map((b) => b.score);
  const score =
    scores.length > 0 ? Math.round(scores.reduce((sum, s) => sum + s, 0) / scores.length) : 100;

  return llmAnalysisSchema.parse({
    summary: buildConsolidationNote(batches, sessionUrl),
    components: [...componentsByKey.values()],
    ...(enhancedById.size > 0 ? { enhancedAxeViolations: [...enhancedById.values()] } : {}),
    recommendations,
    score,
  });
}
