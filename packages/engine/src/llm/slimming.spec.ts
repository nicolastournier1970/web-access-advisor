import { describe, it, expect } from 'vitest';
import { Buffer } from 'node:buffer';
import type { AxeViolation } from '@waa/shared';
import { slimAxeViolations, truncateHtml } from './slimming.js';

function violation(overrides: Partial<AxeViolation> = {}): AxeViolation {
  return {
    id: 'label',
    impact: 'serious',
    description: 'Form elements must have labels',
    help: 'help text',
    helpUrl: 'https://dequeuniversity.com/rules/axe/4.10/label',
    tags: ['wcag2a'],
    nodes: [
      { html: '<input id="a">', target: ['#a'], failureSummary: 'fix it' },
    ],
    ...overrides,
  };
}

describe('slimAxeViolations', () => {
  it('caps nodes at 5 per violation', () => {
    const nodes = Array.from({ length: 9 }, (_, i) => ({
      html: `<input id="n${i}">`,
      target: [`#n${i}`],
    }));
    const [slim] = slimAxeViolations([violation({ nodes })]);
    expect(slim!.nodes).toHaveLength(5);
    expect(slim!.nodes[0]!.target).toEqual(['#n0']);
  });

  it('truncates node html to 500 chars', () => {
    const long = '<div>' + 'x'.repeat(700) + '</div>';
    const [slim] = slimAxeViolations([violation({ nodes: [{ html: long, target: ['div'] }] })]);
    expect(slim!.nodes[0]!.html).toHaveLength(500);
  });

  it('drops violations without impact or without nodes (passes/incomplete equivalents)', () => {
    const kept = violation();
    const noImpact = violation({ id: 'no-impact', impact: null });
    const noNodes = violation({ id: 'no-nodes', nodes: [] });
    const slim = slimAxeViolations([kept, noImpact, noNodes]);
    expect(slim.map((v) => v.id)).toEqual(['label']);
  });

  it('strips extra properties but keeps the LLM-relevant core fields', () => {
    const enriched = {
      ...violation(),
      explanation: 'llm enrichment',
      stepOccurrences: [1, 2],
    } as AxeViolation;
    const [slim] = slimAxeViolations([enriched]);
    expect(slim).not.toHaveProperty('explanation');
    expect(slim).not.toHaveProperty('stepOccurrences');
    expect(slim!.id).toBe('label');
    expect(slim!.impact).toBe('serious');
    expect(slim!.helpUrl).toContain('dequeuniversity');
    expect(slim!.nodes[0]!.failureSummary).toBe('fix it');
  });

  it('tolerates non-array input', () => {
    expect(slimAxeViolations(undefined as unknown as AxeViolation[])).toEqual([]);
  });
});

describe('truncateHtml', () => {
  it('returns input unchanged when it fits', () => {
    const html = '<p>hello</p>';
    expect(truncateHtml(html, 1000)).toBe(html);
  });

  it('appends the truncation marker and respects the byte budget', () => {
    const html = '<div><span>abcdefghij</span></div>'.repeat(50);
    const out = truncateHtml(html, 300);
    expect(out.endsWith('<!-- truncated -->')).toBe(true);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(300);
  });

  it('cuts at a tag boundary so no half-open tag remains', () => {
    const html = '<div class="aaaaaaaaaaaaaaaaaaaa">text</div>'.repeat(100);
    const out = truncateHtml(html, 500);
    const body = out.slice(0, out.length - '<!-- truncated -->'.length);
    // The retained content must not end inside an open tag.
    expect(body.lastIndexOf('<')).toBeLessThan(body.lastIndexOf('>'));
  });

  it('is byte-aware for multibyte content and never splits a code point', () => {
    const html = '✓'.repeat(500); // 3 bytes each in UTF-8
    const out = truncateHtml(html, 100);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(100);
    expect(out).not.toContain('�');
    // Round-trips through UTF-8 without loss (no split surrogate).
    expect(Buffer.from(out, 'utf8').toString('utf8')).toBe(out);
  });

  it('handles degenerate budgets', () => {
    expect(truncateHtml('<p>x</p>', 0)).toBe('');
    const tiny = truncateHtml('<p>abcdefgh</p>', 5);
    expect(Buffer.byteLength(tiny, 'utf8')).toBeLessThanOrEqual(5);
    expect(tiny).not.toContain('truncated');
  });
});
