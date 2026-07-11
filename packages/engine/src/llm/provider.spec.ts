import { describe, it, expect } from 'vitest';
import { llmAnalysisSchema } from '@waa/shared';
import { parseLlmJsonResponse } from './provider.js';

const FULL_RESPONSE = {
  summary: 'One issue found.',
  components: [
    {
      componentName: 'Form elements must have labels',
      issue: 'The `input` element lacks a label.',
      explanation: 'Screen readers cannot announce the purpose of the `input`.',
      relevantHtml: '<input type="text">',
      correctedCode: '<input type="text" aria-label="Search">',
      codeChangeSummary: 'Added aria-label',
      impact: 'serious',
      wcagRule: '4.1.2 Name, Role, Value',
      wcagUrl: 'https://www.w3.org/WAI/WCAG21/Understanding/name-role-value.html',
      selector: '#search',
      step: 2,
      url: 'https://example.com',
    },
  ],
  recommendations: ['Label every form control.'],
  score: 77,
};

describe('parseLlmJsonResponse', () => {
  it('parses a clean JSON object', () => {
    const analysis = parseLlmJsonResponse(JSON.stringify(FULL_RESPONSE));
    expect(analysis.summary).toBe('One issue found.');
    expect(analysis.components).toHaveLength(1);
    expect(analysis.components[0]!.componentName).toBe('Form elements must have labels');
    expect(analysis.components[0]!.impact).toBe('serious');
    expect(analysis.score).toBe(77);
    expect(llmAnalysisSchema.safeParse(analysis).success).toBe(true);
  });

  it('strips markdown code fences', () => {
    const fenced = '```json\n' + JSON.stringify(FULL_RESPONSE) + '\n```';
    const analysis = parseLlmJsonResponse(fenced);
    expect(analysis.components).toHaveLength(1);
    expect(analysis.score).toBe(77);
  });

  it('extracts the JSON object out of surrounding prose', () => {
    const chatty = `Sure! Here is the analysis you asked for:\n${JSON.stringify(FULL_RESPONSE)}\nHope this helps!`;
    const analysis = parseLlmJsonResponse(chatty);
    expect(analysis.summary).toBe('One issue found.');
    expect(analysis.components).toHaveLength(1);
  });

  it('throws a descriptive error for unparseable text (the batch must fail loudly)', () => {
    for (const bad of ['', 'no json here', '{ "summary": broken', '[1, 2, 3]', '{{{{}}}}']) {
      expect(() => parseLlmJsonResponse(bad)).toThrowError(/failed to parse/i);
    }
  });

  it('still tolerates recoverable sloppiness without throwing', () => {
    // components: 42 → sanitized to [] (item-level leniency is unchanged).
    const analysis = parseLlmJsonResponse('{"components": 42, "summary": "ok", "score": 10}');
    expect(analysis.components).toEqual([]);
    expect(analysis.summary).toBe('ok');
  });

  it('degrades off-vocabulary impact to moderate and clamps score', () => {
    const sloppy = {
      summary: 'ok',
      components: [
        { componentName: 'Elements must have names', issue: 'x', impact: 'catastrophic' },
      ],
      score: 150,
    };
    const analysis = parseLlmJsonResponse(JSON.stringify(sloppy));
    expect(analysis.components[0]!.impact).toBe('moderate');
    expect(analysis.score).toBe(100);
  });

  it('drops components missing a meaningful name or issue', () => {
    const sloppy = {
      summary: 'ok',
      components: [
        { componentName: '  ', issue: 'x' },
        { componentName: 'Valid name', issue: '' },
        { componentName: 'Valid name', issue: 'real issue' },
        'not-an-object',
      ],
      score: 10,
    };
    const analysis = parseLlmJsonResponse(JSON.stringify(sloppy));
    expect(analysis.components).toHaveLength(1);
    expect(analysis.components[0]!.componentName).toBe('Valid name');
  });

  it('keeps enhancedAxeViolations entries with usable ids and drops the rest', () => {
    const sloppy = {
      summary: 'ok',
      components: [],
      enhancedAxeViolations: [
        { id: 'landmark-one-main', explanation: 'e', recommendation: 'r' },
        { id: '', explanation: 'dropped' },
        { id: 'bad-wcag', wcag: 'not-an-object' },
      ],
      score: 10,
    };
    const analysis = parseLlmJsonResponse(JSON.stringify(sloppy));
    const ids = (analysis.enhancedAxeViolations ?? []).map((v) => v.id);
    expect(ids).toEqual(['landmark-one-main', 'bad-wcag']);
    expect(analysis.enhancedAxeViolations![1]!.wcag).toBeUndefined();
  });
});
