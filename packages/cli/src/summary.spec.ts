import { describe, expect, it } from 'vitest';
import { analysisResultSchema, type AnalysisResult } from '@waa/shared';
import { formatSummary, type SummaryPaths } from './summary.js';

const PATHS: SummaryPaths = {
  root: '/tmp/snapshots/session_fixture',
  manifest: '/tmp/snapshots/session_fixture/manifest.json',
  analysis: '/tmp/snapshots/session_fixture/analysis.json',
};

/** Schema-valid fixture: the formatter is typed against the real contract. */
function fixture(overrides: Record<string, unknown> = {}): AnalysisResult {
  return analysisResultSchema.parse({
    success: true,
    sessionId: 'session_fixture',
    snapshotCount: 2,
    manifest: {
      sessionId: 'session_fixture',
      url: 'https://example.test/',
      timestamp: '2026-07-09T00:00:00.000Z',
      totalSteps: 2,
    },
    analysis: {
      summary: 'fixture',
      components: [
        { componentName: 'Nav', issue: 'a', impact: 'serious' },
        { componentName: 'Form', issue: 'b', impact: 'moderate' },
        { componentName: 'Img', issue: 'c', impact: 'critical' },
      ],
      recommendations: [],
      score: 42,
    },
    axeResults: [
      { id: 'image-alt', impact: 'critical' },
      { id: 'image-alt', impact: 'critical' }, // same rule twice → 1 rule, 2 issues
      { id: 'label', impact: 'serious' },
      { id: 'region', impact: null }, // nullish impact → (unknown) bucket
    ],
    warnings: ['profile fallback used'],
    llmProvider: 'stub',
    ...overrides,
  });
}

describe('formatSummary', () => {
  it('renders axe rule/issue counts by impact including totals', () => {
    const output = formatSummary(fixture(), PATHS);
    expect(output).toMatch(/critical\s+1\s+2/);
    expect(output).toMatch(/serious\s+1\s+1/);
    expect(output).toMatch(/moderate\s+0\s+0/);
    expect(output).toMatch(/minor\s+0\s+0/);
    expect(output).toMatch(/\(unknown\)\s+1\s+1/);
    expect(output).toMatch(/TOTAL\s+3\s+4/);
  });

  it('renders the LLM component count, score and provider', () => {
    const output = formatSummary(fixture(), PATHS);
    expect(output).toContain('LLM analysis (provider: stub)');
    expect(output).toContain('Component findings : 3');
    expect(output).toContain('Score              : 42/100');
  });

  it('renders status, snapshot counts, warnings and output paths', () => {
    const output = formatSummary(fixture(), PATHS);
    expect(output).toContain('session session_fixture');
    expect(output).toContain('Status : success');
    expect(output).toContain('2 snapshot(s) captured, 2 manifest step(s)');
    expect(output).toContain('Warnings (1)');
    expect(output).toContain('profile fallback used');
    expect(output).toContain(PATHS.root);
    expect(output).toContain(PATHS.manifest);
    expect(output).toContain(PATHS.analysis);
  });

  it('omits the unknown-impact row when every violation has an impact', () => {
    const output = formatSummary(
      fixture({ axeResults: [{ id: 'label', impact: 'minor' }] }),
      PATHS,
    );
    expect(output).not.toContain('(unknown)');
    expect(output).toMatch(/minor\s+1\s+1/);
    expect(output).toMatch(/TOTAL\s+1\s+1/);
  });

  it('reports a failed analysis with its error and no LLM section', () => {
    const output = formatSummary(
      fixture({ success: false, error: 'browser exploded', analysis: undefined }),
      PATHS,
    );
    expect(output).toContain('Status : FAILED — browser exploded');
    expect(output).toContain('LLM analysis : none');
    expect(output).not.toContain('Score ');
  });

  it('reports "none" when the LLM was disabled (--llm none)', () => {
    const output = formatSummary(fixture({ analysis: undefined, llmProvider: undefined }), PATHS);
    expect(output).toContain('LLM analysis : none');
  });
});
