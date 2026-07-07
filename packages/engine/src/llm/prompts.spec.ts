import { describe, it, expect } from 'vitest';
import { llmAnalysisSchema, type LlmAnalysis } from '@waa/shared';
import type { LlmBatchRequest } from '../engine-types.js';
import { buildComponentAnalysisPrompt, buildConsolidationNote } from './prompts.js';

function request(overrides: Partial<LlmBatchRequest> = {}): LlmBatchRequest {
  return {
    batchId: 'batch-1',
    snapshots: [
      {
        step: 1,
        url: 'https://example.com/',
        html: '<main id="unique-main-marker"><h1>Home</h1></main>',
        axeViolationsJson: '[{"id":"landmark-one-main"}]',
        domChangeDescription: 'initial page load',
      },
      {
        step: 2,
        url: 'https://example.com/form',
        html: '<form id="unique-form-marker"><input></form>',
        axeViolationsJson: '[{"id":"label"}]',
        domChangeDescription: 'navigated to form',
      },
    ],
    staticSectionMode: 'include',
    ...overrides,
  };
}

function analysis(summary: string, score = 50): LlmAnalysis {
  return llmAnalysisSchema.parse({ summary, components: [], recommendations: [], score });
}

describe('buildComponentAnalysisPrompt', () => {
  it('frames the role and embeds every snapshot section (step, url, html, axe JSON)', () => {
    const prompt = buildComponentAnalysisPrompt(request());
    expect(prompt).toMatch(/expert screen-reader accessibility auditor/i);
    expect(prompt).toContain('step 1');
    expect(prompt).toContain('step 2');
    expect(prompt).toContain('https://example.com/form');
    expect(prompt).toContain('unique-main-marker');
    expect(prompt).toContain('unique-form-marker');
    expect(prompt).toContain('"landmark-one-main"');
    expect(prompt).toContain('initial page load');
  });

  it('states the JSON contract fields and the componentName naming rules', () => {
    const prompt = buildComponentAnalysisPrompt(request());
    for (const field of [
      '"componentName"',
      '"issue"',
      '"explanation"',
      '"relevantHtml"',
      '"correctedCode"',
      '"codeChangeSummary"',
      '"impact"',
      '"wcagRule"',
      '"wcagUrl"',
      '"selector"',
      '"recommendations"',
      '"score"',
    ]) {
      expect(prompt).toContain(field);
    }
    expect(prompt).toMatch(/NEVER use "Ensure\.\.\." phrasing/);
    expect(prompt).toContain('https://www.w3.org/WAI/WCAG21/Understanding/');
  });

  it('adapts to each staticSectionMode', () => {
    expect(buildComponentAnalysisPrompt(request({ staticSectionMode: 'ignore' }))).toContain(
      'STATIC SECTIONS: IGNORE',
    );
    expect(buildComponentAnalysisPrompt(request({ staticSectionMode: 'separate' }))).toContain(
      'STATIC SECTIONS: ANALYZE ONCE',
    );
    expect(buildComponentAnalysisPrompt(request({ staticSectionMode: 'include' }))).toContain(
      'STATIC SECTIONS: INCLUDE',
    );
  });

  it('includes the progressive summary only when present', () => {
    const withSummary = buildComponentAnalysisPrompt(
      request({ progressiveSummary: 'Previously: missing landmarks on the home page.' }),
    );
    expect(withSummary).toContain('PREVIOUS BATCH CONTEXT');
    expect(withSummary).toContain('missing landmarks on the home page');

    const without = buildComponentAnalysisPrompt(request());
    expect(without).not.toContain('PREVIOUS BATCH CONTEXT');
  });

  it('switches before/after guidance on snapshot count', () => {
    const multi = buildComponentAnalysisPrompt(request());
    expect(multi).toContain('BEFORE/AFTER DOM-STATE AWARENESS');

    const single = buildComponentAnalysisPrompt(
      request({ snapshots: request().snapshots.slice(0, 1) }),
    );
    expect(single).toContain('SINGLE-SNAPSHOT ANALYSIS');
    expect(single).not.toContain('BEFORE/AFTER DOM-STATE AWARENESS');
  });
});

describe('buildConsolidationNote', () => {
  it('names the session URL and batch count and joins batch summaries', () => {
    const note = buildConsolidationNote(
      [analysis('Batch one findings.'), analysis('Batch two findings.')],
      'https://example.com',
    );
    expect(note).toContain('https://example.com');
    expect(note).toContain('2 batch(es)');
    expect(note).toContain('Batch one findings.');
    expect(note).toContain('Batch two findings.');
  });

  it('caps the joined summaries', () => {
    const long = analysis('y'.repeat(5000));
    const note = buildConsolidationNote([long, long], 'https://example.com');
    expect(note.length).toBeLessThan(1800);
    expect(note).toContain('...');
  });

  it('omits the findings clause when no batch has a summary', () => {
    const note = buildConsolidationNote([analysis('  ')], 'https://example.com');
    expect(note).not.toContain('Key findings');
    expect(note).toContain('1 batch(es)');
  });
});
