/**
 * Provider-neutral LLM plumbing: the provider contract (re-exported from
 * engine-types) plus the tolerant response parser every provider funnels raw
 * model output through.
 *
 * Leniency policy (mirrors @waa/shared): individual sloppy ITEMS degrade
 * (dropped/defaulted), but a response that cannot be turned into an analysis
 * at all THROWS — the batch then fails visibly through runLlmAnalysis's
 * onBatchError → analysis warning. The previous fabricate-an-empty-analysis
 * fallback let a garbled batch pollute the consolidated summary with its own
 * error text and drag the score mean, with no warning anywhere.
 */
import { componentIssueSchema, llmAnalysisSchema, type LlmAnalysis } from '@waa/shared';

export type { LlmProvider, LlmBatchRequest } from '../engine-types.js';

/**
 * Strips markdown code fences and any prose surrounding the outermost JSON
 * object. Returns null when no `{ ... }` span exists at all.
 */
function extractJsonObject(text: string): string | null {
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return cleaned.slice(start, end + 1);
}

/** True for plain-object values (not arrays, not null). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Per-item validation of the components array: items missing a meaningful
 * componentName/issue (or failing the item schema outright) are dropped so one
 * sloppy entry cannot sink the whole analysis.
 */
function sanitizeComponents(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  const kept: unknown[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const name = item['componentName'];
    const issue = item['issue'];
    if (typeof name !== 'string' || name.trim().length === 0) continue;
    if (typeof issue !== 'string' || issue.trim().length === 0) continue;
    const parsed = componentIssueSchema.safeParse(item);
    if (parsed.success) kept.push(parsed.data);
  }
  return kept;
}

/**
 * Keeps only enhanced-violation entries with a usable string id; a non-object
 * `wcag` value is removed rather than allowed to fail validation.
 */
function sanitizeEnhancedViolations(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const kept: unknown[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    if (typeof item['id'] !== 'string' || item['id'].trim().length === 0) continue;
    const copy: Record<string, unknown> = { ...item };
    if (copy['wcag'] !== undefined && !isRecord(copy['wcag'])) delete copy['wcag'];
    kept.push(copy);
  }
  return kept;
}

/**
 * Parses raw LLM text into a schema-valid LlmAnalysis:
 *  - strips markdown fences and prose around the outermost `{ ... }`;
 *  - JSON.parses, then pre-sanitizes LLM-origin arrays item-by-item;
 *  - validates through llmAnalysisSchema (whose .catch()/defaults absorb
 *    remaining sloppiness, e.g. off-vocabulary impact, out-of-range score);
 *  - THROWS on unrecoverable input (no JSON, invalid JSON, wrong shape) so
 *    the batch fails loudly instead of consolidating an empty fake analysis.
 */
export function parseLlmJsonResponse(text: string): LlmAnalysis {
  const jsonText = extractJsonObject(text);
  if (jsonText === null) {
    throw new Error('LLM analysis failed to parse: no JSON object was found in the model response.');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch {
    throw new Error('LLM analysis failed to parse: the model response was not valid JSON.');
  }
  if (!isRecord(raw)) {
    throw new Error('LLM analysis failed to parse: the model response was not a JSON object.');
  }

  const candidate: Record<string, unknown> = {
    ...raw,
    components: sanitizeComponents(raw['components']),
  };
  if (typeof candidate['summary'] !== 'string') delete candidate['summary'];
  if (Array.isArray(raw['recommendations'])) {
    candidate['recommendations'] = raw['recommendations'].filter(
      (r): r is string => typeof r === 'string',
    );
  } else {
    delete candidate['recommendations'];
  }
  const enhanced = sanitizeEnhancedViolations(raw['enhancedAxeViolations']);
  if (enhanced === undefined) delete candidate['enhancedAxeViolations'];
  else candidate['enhancedAxeViolations'] = enhanced;
  if (!isRecord(candidate['debug'])) delete candidate['debug'];

  const result = llmAnalysisSchema.safeParse(candidate);
  if (!result.success) {
    throw new Error(
      'LLM analysis failed schema validation despite parsing as JSON; the response was discarded.',
    );
  }
  return result.data;
}
