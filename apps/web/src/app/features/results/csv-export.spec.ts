import { describe, expect, it } from 'vitest';
import type { AnalysisResult } from '@waa/shared';
import { CSV_HEADER, buildCsv, cleanTextForCsv, csvFilename, escapeCsvField } from './csv-export';
import type { Finding } from './results-view';

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    key: 'llm-0',
    source: 'llm',
    severity: 'serious',
    title: 'Nav menu',
    issue: 'Menu button has no accessible name',
    explanation: 'Announced as just "button".',
    offendingHtml: '<button></button>',
    nodes: [],
    correctedCode: '<button aria-label="Menu"></button>',
    codeChangeSummary: 'Add aria-label',
    recommendation: '',
    selector: '.menu',
    wcagLabel: '4.1.2 Name, Role, Value',
    wcagUrl: 'https://www.w3.org/WAI/WCAG21/Understanding/name-role-value',
    step: 1,
    url: 'https://example.com/page',
    isDuplicate: false,
    ...overrides,
  };
}

describe('buildCsv', () => {
  it('emits the unified header and one row per finding', () => {
    const csv = buildCsv([finding(), finding({ key: 'axe-0', source: 'axe', step: 2 })]);
    const lines = csv.split('\n');
    expect(lines[0]).toBe(CSV_HEADER);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('SERIOUS');
    expect(lines[1]).toContain('Nav menu');
    expect(lines[1]).toContain('4.1.2 Name');
    expect(lines[1]).toContain('.menu');
    expect(lines[2]).toContain(',2,');
  });

  it('escapes commas and quotes; strips HTML from text fields', () => {
    const csv = buildCsv([
      finding({
        title: 'Widget, the "best" one',
        issue: 'Uses <b>bold</b> markup\nacross lines',
        explanation: '',
      }),
    ]);
    const row = csv.split('\n')[1];
    expect(row).toContain('"Widget, the ""best"" one"');
    expect(row).toContain('Uses bold markup across lines');
    expect(row).not.toContain('<b>');
  });

  it('handles empty findings (header only) and missing step/url', () => {
    expect(buildCsv([])).toBe(CSV_HEADER);
    const csvRow = buildCsv([finding({ step: undefined, url: undefined, selector: '' })]).split('\n')[1];
    expect(csvRow.endsWith(',,')).toBe(true);
    expect(csvRow).toContain('Not specified');
  });
});

describe('csv text helpers', () => {
  it('cleanTextForCsv decodes entities and collapses whitespace', () => {
    expect(cleanTextForCsv('a &amp; b &lt;c&gt;\r\n  d')).toBe('a & b <c> d');
    expect(cleanTextForCsv('')).toBe('');
  });

  it('escapeCsvField quotes only when needed', () => {
    expect(escapeCsvField('plain')).toBe('plain');
    expect(escapeCsvField('a,b')).toBe('"a,b"');
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
  });
});

describe('csvFilename', () => {
  it('derives the domain and a sortable timestamp', () => {
    const result = {
      manifest: { url: 'https://www.example.com/app' },
    } as unknown as AnalysisResult;
    const name = csvFilename(result, new Date('2026-07-08T10:20:30.000Z'));
    expect(name).toBe('accessibility-analysis-example-com-2026-07-08T10-20-30.csv');
  });

  it('falls back to a sanitized slug for unparseable URLs', () => {
    const result = { manifest: { url: 'not a url' } } as unknown as AnalysisResult;
    expect(csvFilename(result, new Date('2026-07-08T10:20:30.000Z'))).toContain('not-a-url');
  });
});
