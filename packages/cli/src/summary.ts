/**
 * Pure findings-summary formatter over an AnalysisResult: axe rule/issue
 * counts by impact, LLM component count + score, warnings and output paths.
 */
import type { AnalysisResult, Impact } from '@waa/shared';
import { renderTable } from './table.js';

export interface SummaryPaths {
  root: string;
  manifest: string;
  analysis: string;
}

const IMPACT_ORDER: readonly Impact[] = ['critical', 'serious', 'moderate', 'minor'];

function indent(block: string, prefix: string): string {
  return block
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

/** Aggregate axe violations into unique-rule and issue counts per impact. */
function axeTable(result: AnalysisResult): string {
  const buckets = new Map<string, { rules: Set<string>; issues: number }>();
  for (const violation of result.axeResults) {
    const impact = violation.impact ?? 'unknown';
    const bucket = buckets.get(impact) ?? { rules: new Set<string>(), issues: 0 };
    bucket.rules.add(violation.id);
    bucket.issues += 1;
    buckets.set(impact, bucket);
  }

  const rows: string[][] = IMPACT_ORDER.map((impact) => {
    const bucket = buckets.get(impact);
    return [impact, String(bucket?.rules.size ?? 0), String(bucket?.issues ?? 0)];
  });
  const unknown = buckets.get('unknown');
  if (unknown !== undefined) {
    rows.push(['(unknown)', String(unknown.rules.size), String(unknown.issues)]);
  }
  const totalRules = new Set(result.axeResults.map((violation) => violation.id)).size;
  rows.push(['TOTAL', String(totalRules), String(result.axeResults.length)]);

  return renderTable(['IMPACT', 'RULES', 'ISSUES'], rows, ['l', 'r', 'r']);
}

/** Human-readable summary printed after every analyze/replay run. */
export function formatSummary(result: AnalysisResult, paths: SummaryPaths): string {
  const lines: string[] = [];

  lines.push(`Analysis summary — session ${result.sessionId}`);
  lines.push(
    result.success
      ? 'Status : success'
      : `Status : FAILED${result.error !== undefined ? ` — ${result.error}` : ''}`,
  );
  lines.push(
    `Steps  : ${result.snapshotCount} snapshot(s) captured, ${result.manifest.totalSteps} manifest step(s)`,
  );
  lines.push('');

  lines.push('Axe violations by impact');
  lines.push(indent(axeTable(result), '  '));
  lines.push('');

  if (result.analysis !== undefined) {
    lines.push(`LLM analysis (provider: ${result.llmProvider ?? 'unknown'})`);
    lines.push(`  Component findings : ${result.analysis.components.length}`);
    lines.push(`  Score              : ${result.analysis.score}/100`);
  } else {
    lines.push('LLM analysis : none (provider disabled or the LLM phase was not reached)');
  }

  if (result.warnings.length > 0) {
    lines.push('');
    lines.push(`Warnings (${result.warnings.length})`);
    for (const warning of result.warnings) {
      lines.push(`  - ${warning}`);
    }
  }

  lines.push('');
  lines.push('Output');
  lines.push(`  session dir : ${paths.root}`);
  lines.push(`  manifest    : ${paths.manifest}`);
  lines.push(`  analysis    : ${paths.analysis}`);

  return lines.join('\n');
}
