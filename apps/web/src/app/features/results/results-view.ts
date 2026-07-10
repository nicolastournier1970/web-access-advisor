/**
 * Pure view-model logic for the results page: merges LLM component findings
 * with axe violations into one findings list, applies the legacy
 * axe-vs-LLM duplicate fingerprint (wcag guideline + selector), hides
 * auth-step findings, and provides severity filtering — all side-effect free
 * and unit-tested in isolation from the component.
 */
import type {
  AnalysisResult,
  AxeNode,
  AxeViolation,
  ComponentIssue,
  Impact,
  SessionManifest,
} from '@waa/shared';

export interface FindingNode {
  html: string;
  selector: string;
  failureSummary?: string;
}

/** One row of the merged findings list (LLM component issue or axe violation). */
export interface Finding {
  key: string;
  source: 'llm' | 'axe';
  severity: Impact;
  /** componentName (LLM) or axe help text (fallback: rule id). */
  title: string;
  issue: string;
  explanation: string;
  /** LLM relevantHtml; axe findings carry per-node HTML in `nodes`. */
  offendingHtml: string;
  nodes: FindingNode[];
  correctedCode: string;
  codeChangeSummary: string;
  /** LLM-enriched recommendation on axe violations. */
  recommendation: string;
  selector: string;
  wcagLabel: string;
  wcagUrl: string;
  step?: number;
  url?: string;
  /** Axe violation whose (wcag + selector) fingerprint matches an LLM finding. */
  isDuplicate: boolean;
}

export interface ResultsView {
  /** Auth-step findings removed; duplicates included but flagged. */
  findings: Finding[];
  duplicateCount: number;
  authHiddenCount: number;
}

export const SEVERITIES: readonly Impact[] = ['critical', 'serious', 'moderate', 'minor'];

const SEVERITY_ORDER: Record<Impact, number> = { critical: 0, serious: 1, moderate: 2, minor: 3 };

const WCAG_FALLBACK_URL = 'https://www.w3.org/WAI/WCAG21/Understanding/';

/** URL of a manifest step (used for step attribution when the finding has none). */
export function stepUrl(manifest: SessionManifest, step: number | undefined): string | undefined {
  if (step === undefined) return undefined;
  return manifest.stepDetails.find((s) => s.step === step)?.url;
}

/**
 * Legacy selector normalization: reduce a compound selector to its most
 * specific segment so ".Frame-body" and "body > .Frame > .Frame-body"
 * fingerprint identically.
 */
export function normalizeSelector(selector: string): string {
  if (!selector) return 'no-selector';
  const segments = selector.split(/\s*>\s*|\s+/);
  const mostSpecific = segments[segments.length - 1];
  return mostSpecific.includes('.') || mostSpecific.includes('#') ? mostSpecific : selector;
}

/** "wcag142" tag → "1.4.2" (legacy AxeResults tag parsing). */
export function wcagGuidelineFromTags(tags: string[]): string | null {
  const tag = tags.find((t) => /^wcag\d{3,}$/.test(t));
  if (!tag) return null;
  const numbers = tag.slice(4);
  return `${numbers[0]}.${numbers[1]}.${numbers.slice(2)}`;
}

/** First selector of an axe node; shadow-DOM chains (string[]) are joined. */
function nodeSelector(node: AxeNode): string {
  const first = node.target[0];
  if (first === undefined) return '';
  return Array.isArray(first) ? first.join(' ') : first;
}

/** WCAG guideline number of an axe violation ("1.4.2"), if resolvable. */
function axeGuideline(violation: AxeViolation): string | null {
  if (violation.wcagReference?.guideline) return violation.wcagReference.guideline;
  return wcagGuidelineFromTags(violation.tags);
}

/** Steps flagged auth-related by the replay manifest (login pages). */
function authSteps(manifest: SessionManifest): Set<number> {
  return new Set(manifest.stepDetails.filter((s) => s.isAuthRelated).map((s) => s.step));
}

function llmFinding(component: ComponentIssue, manifest: SessionManifest, index: number): Finding {
  return {
    key: `llm-${index}`,
    source: 'llm',
    severity: component.impact,
    title: component.componentName,
    issue: component.issue,
    explanation: component.explanation,
    offendingHtml: component.relevantHtml,
    nodes: [],
    correctedCode: component.correctedCode,
    codeChangeSummary: component.codeChangeSummary,
    recommendation: '',
    selector: component.selector ?? '',
    wcagLabel: component.wcagRule,
    wcagUrl: component.wcagRule ? (component.wcagUrl ?? WCAG_FALLBACK_URL) : '',
    ...(component.step !== undefined ? { step: component.step } : {}),
    ...(resolveUrl(component.url, component.step, manifest) !== undefined
      ? { url: resolveUrl(component.url, component.step, manifest) }
      : {}),
    isDuplicate: false,
  };
}

function axeFinding(
  violation: AxeViolation,
  manifest: SessionManifest,
  index: number,
  isDuplicate: boolean,
): Finding {
  const wcag = violation.wcagReference;
  const wcagLabel = wcag
    ? [wcag.guideline, wcag.level, wcag.title && `— ${wcag.title}`].filter(Boolean).join(' ')
    : '';
  return {
    key: `axe-${violation.id}-${index}`,
    source: 'axe',
    severity: violation.impact ?? 'moderate',
    title: violation.help || violation.id,
    issue: violation.description,
    explanation: violation.explanation ?? '',
    offendingHtml: '',
    nodes: violation.nodes.map((node) => ({
      html: node.html,
      selector: nodeSelector(node),
      ...(node.failureSummary !== undefined ? { failureSummary: node.failureSummary } : {}),
    })),
    correctedCode: violation.correctedCode ?? '',
    codeChangeSummary: violation.codeChangeSummary ?? '',
    recommendation: violation.recommendation ?? '',
    selector: nodeSelector(violation.nodes[0] ?? { html: '', target: [] }),
    wcagLabel,
    wcagUrl: wcag?.url || violation.helpUrl,
    ...(violation.step !== undefined ? { step: violation.step } : {}),
    ...(resolveUrl(violation.url, violation.step, manifest) !== undefined
      ? { url: resolveUrl(violation.url, violation.step, manifest) }
      : {}),
    isDuplicate,
  };
}

function resolveUrl(
  own: string | undefined,
  step: number | undefined,
  manifest: SessionManifest,
): string | undefined {
  return own || stepUrl(manifest, step) || manifest.url || undefined;
}

function byStepThenSeverity(a: Finding, b: Finding): number {
  const stepA = a.step ?? 0;
  const stepB = b.step ?? 0;
  if (stepA !== stepB) return stepA - stepB;
  return SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
}

/**
 * Build the merged findings view:
 *  1. LLM enrichment (enhancedAxeViolations) folded onto matching axe rules;
 *  2. auth-step findings excluded (counted, not shown);
 *  3. within-source dedup (legacy keys);
 *  4. axe-vs-LLM duplicate flag via the (wcag + selector) fingerprint;
 *  5. sorted by step (capture order), then severity.
 */
export function buildResultsView(result: AnalysisResult): ResultsView {
  const manifest = result.manifest;
  const hiddenSteps = authSteps(manifest);
  let authHiddenCount = 0;

  // --- LLM component findings ---
  const components = result.analysis?.components ?? [];
  const seenComponentKeys = new Set<string>();
  const llmFindings: Finding[] = [];
  for (const component of components) {
    if (component.step !== undefined && hiddenSteps.has(component.step)) {
      authHiddenCount += 1;
      continue;
    }
    const dedupKey = [
      resolveUrl(component.url, component.step, manifest) ?? 'no-url',
      normalizeSelector(component.selector ?? ''),
      component.wcagRule || 'no-wcag',
    ].join('::');
    if (seenComponentKeys.has(dedupKey)) continue;
    seenComponentKeys.add(dedupKey);
    llmFindings.push(llmFinding(component, manifest, llmFindings.length));
  }

  // LLM fingerprints for the axe duplicate check: "wcagNumber::selector".
  const llmFingerprints = new Set<string>();
  for (const component of components) {
    if (!component.wcagRule || !component.selector) continue;
    const wcagNumber = component.wcagRule.split(' ')[0];
    llmFingerprints.add(`${wcagNumber}::${component.selector}`);
    llmFingerprints.add(`${wcagNumber}::${normalizeSelector(component.selector)}`);
  }

  // --- Axe violations (with enhancedAxeViolations enrichment merged in) ---
  const enhancements = new Map(
    (result.analysis?.enhancedAxeViolations ?? []).map((e) => [e.id, e]),
  );
  const seenAxeKeys = new Set<string>();
  const axeFindings: Finding[] = [];
  for (const raw of result.axeResults) {
    const enhanced = enhancements.get(raw.id);
    const violation: AxeViolation = enhanced
      ? {
          ...raw,
          explanation: raw.explanation ?? enhanced.explanation,
          recommendation: raw.recommendation ?? enhanced.recommendation,
          correctedCode: raw.correctedCode ?? enhanced.correctedCode,
          codeChangeSummary: raw.codeChangeSummary ?? enhanced.codeChangeSummary,
          wcagReference: raw.wcagReference ?? enhanced.wcag,
        }
      : raw;

    if (violation.step !== undefined && hiddenSteps.has(violation.step)) {
      authHiddenCount += 1;
      continue;
    }
    const dedupKey = [
      violation.step ?? 0,
      violation.id,
      nodeSelector(violation.nodes[0] ?? { html: '', target: [] }) || 'no-selector',
    ].join('::');
    if (seenAxeKeys.has(dedupKey)) continue;
    seenAxeKeys.add(dedupKey);

    const guideline = axeGuideline(violation);
    const isDuplicate =
      guideline !== null &&
      violation.nodes.some((node) => {
        const selector = nodeSelector(node);
        return (
          selector !== '' &&
          (llmFingerprints.has(`${guideline}::${selector}`) ||
            llmFingerprints.has(`${guideline}::${normalizeSelector(selector)}`))
        );
      });
    axeFindings.push(axeFinding(violation, manifest, axeFindings.length, isDuplicate));
  }

  const findings = [...llmFindings, ...axeFindings].sort(byStepThenSeverity);
  return {
    findings,
    duplicateCount: findings.filter((f) => f.isDuplicate).length,
    authHiddenCount,
  };
}

/** Severity chips + duplicates toggle applied to the merged list. */
export function filterFindings(
  findings: readonly Finding[],
  activeSeverities: ReadonlySet<Impact>,
  showDuplicates: boolean,
): Finding[] {
  return findings.filter(
    (finding) =>
      activeSeverities.has(finding.severity) && (showDuplicates || !finding.isDuplicate),
  );
}

/** Counts for the severity filter chips (over non-duplicate findings). */
export function countBySeverity(findings: readonly Finding[]): Record<Impact, number> {
  const counts: Record<Impact, number> = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const finding of findings) {
    if (!finding.isDuplicate) counts[finding.severity] += 1;
  }
  return counts;
}
