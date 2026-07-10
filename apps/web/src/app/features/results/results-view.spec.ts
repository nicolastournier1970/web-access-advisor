import { describe, expect, it } from 'vitest';
import type { AnalysisResult, AxeViolation, ComponentIssue, SessionManifest } from '@waa/shared';
import { analysisResultSchema } from '@waa/shared';
import {
  buildResultsView,
  countBySeverity,
  filterFindings,
  normalizeSelector,
  wcagGuidelineFromTags,
} from './results-view';

/** Loose manifest fixture — normalized by analysisResultSchema.parse below. */
function manifest(overrides: Record<string, unknown> = {}): SessionManifest {
  return {
    sessionId: 'sess-1',
    url: 'https://example.com',
    timestamp: '2026-07-08T10:00:00.000Z',
    totalSteps: 2,
    stepDetails: [],
    ...overrides,
  } as unknown as SessionManifest;
}

function component(overrides: Partial<ComponentIssue> = {}): ComponentIssue {
  return {
    componentName: 'Nav menu',
    issue: 'Menu button has no accessible name',
    explanation: 'Screen readers announce it as just "button".',
    relevantHtml: '<button class="menu"></button>',
    correctedCode: '<button class="menu" aria-label="Menu"></button>',
    codeChangeSummary: 'Add aria-label',
    impact: 'serious',
    wcagRule: '4.1.2 Name, Role, Value',
    wcagUrl: 'https://www.w3.org/WAI/WCAG21/Understanding/name-role-value',
    selector: '.menu',
    step: 1,
    url: 'https://example.com/page',
    ...overrides,
  } as ComponentIssue;
}

function violation(overrides: Partial<AxeViolation> = {}): AxeViolation {
  return {
    id: 'button-name',
    impact: 'serious',
    description: 'Buttons must have discernible text',
    help: 'Buttons must have discernible text',
    helpUrl: 'https://dequeuniversity.com/rules/axe/4.7/button-name',
    tags: ['wcag2a', 'wcag412'],
    nodes: [{ html: '<button class="menu"></button>', target: ['.menu'] }],
    step: 1,
    ...overrides,
  } as AxeViolation;
}

function analysisResult(overrides: Record<string, unknown> = {}): AnalysisResult {
  return analysisResultSchema.parse({
    success: true,
    sessionId: 'sess-1',
    snapshotCount: 2,
    manifest: manifest(),
    axeResults: [],
    warnings: [],
    ...overrides,
  });
}

describe('buildResultsView', () => {
  it('merges LLM components and axe violations, sorted by step then severity', () => {
    const result = analysisResult({
      analysis: { components: [component({ step: 2, impact: 'critical' })], score: 50 },
      axeResults: [
        violation({ id: 'landmark-one-main', step: 2, impact: 'minor', tags: ['wcag242'], nodes: [{ html: '<html>', target: ['html'] }] }),
        violation({ id: 'image-alt', step: 1, impact: 'critical', tags: ['wcag111'], nodes: [{ html: '<img>', target: ['img'] }] }),
      ],
    });
    const view = buildResultsView(result);
    expect(view.findings.map((f) => [f.source, f.step, f.severity])).toEqual([
      ['axe', 1, 'critical'],
      ['llm', 2, 'critical'],
      ['axe', 2, 'minor'],
    ]);
  });

  it('flags axe violations whose wcag+selector fingerprint matches an LLM finding', () => {
    const result = analysisResult({
      analysis: { components: [component()], score: 50 },
      axeResults: [
        violation(), // same wcag 4.1.2 + selector .menu → duplicate
        violation({
          id: 'image-alt',
          tags: ['wcag111'],
          nodes: [{ html: '<img>', target: ['img'] }],
        }),
      ],
    });
    const view = buildResultsView(result);
    const axe = view.findings.filter((f) => f.source === 'axe');
    expect(axe.find((f) => f.key.startsWith('axe-button-name'))?.isDuplicate).toBe(true);
    expect(axe.find((f) => f.key.startsWith('axe-image-alt'))?.isDuplicate).toBe(false);
    expect(view.duplicateCount).toBe(1);
  });

  it('matches fingerprints on normalized selectors ("body > .x > .menu" ≙ ".menu")', () => {
    const result = analysisResult({
      analysis: { components: [component({ selector: '.menu' })], score: 50 },
      axeResults: [violation({ nodes: [{ html: '<button>', target: ['body > .x > .menu'] }] })],
    });
    const view = buildResultsView(result);
    expect(view.findings.find((f) => f.source === 'axe')?.isDuplicate).toBe(true);
  });

  it('excludes findings on auth-related steps and counts them', () => {
    const result = analysisResult({
      manifest: manifest({
        stepDetails: [
          { step: 1, isAuthRelated: true, action: 'navigate', timestamp: 't', htmlFile: 'h', axeFile: 'a', axeResultsFile: 'a', url: 'https://login.example.com', parentStep: null },
          { step: 2, isAuthRelated: false, action: 'click', timestamp: 't', htmlFile: 'h', axeFile: 'a', axeResultsFile: 'a', url: 'https://example.com/app', parentStep: null },
        ],
      }),
      analysis: { components: [component({ step: 1 }), component({ step: 2, selector: '.other' })], score: 50 },
      axeResults: [violation({ step: 1 }), violation({ id: 'image-alt', step: 2, tags: ['wcag111'], nodes: [{ html: '<img>', target: ['img'] }] })],
    });
    const view = buildResultsView(result);
    expect(view.authHiddenCount).toBe(2);
    expect(view.findings).toHaveLength(2);
    expect(view.findings.every((f) => f.step === 2)).toBe(true);
  });

  it('dedups LLM components by url + normalized selector + wcag rule', () => {
    const result = analysisResult({
      analysis: {
        components: [
          component({ selector: '.menu' }),
          component({ selector: 'body > nav > .menu' }), // same normalized fingerprint
          component({ selector: '.menu', wcagRule: '1.1.1 Non-text Content' }), // different rule
        ],
        score: 50,
      },
    });
    const view = buildResultsView(result);
    expect(view.findings.filter((f) => f.source === 'llm')).toHaveLength(2);
  });

  it('dedups axe violations by step + rule id + first node selector', () => {
    const result = analysisResult({
      axeResults: [violation(), violation(), violation({ step: 2 })],
    });
    const view = buildResultsView(result);
    expect(view.findings).toHaveLength(2);
  });

  it('merges enhancedAxeViolations enrichment (explanation, wcag object form)', () => {
    const result = analysisResult({
      analysis: {
        components: [],
        enhancedAxeViolations: [
          {
            id: 'button-name',
            explanation: 'Buttons without names are unusable with a screen reader.',
            recommendation: 'Add an aria-label.',
            wcag: {
              guideline: '4.1.2',
              level: 'A',
              title: 'Name, Role, Value',
              url: 'https://www.w3.org/WAI/WCAG21/Understanding/name-role-value',
            },
          },
        ],
        score: 50,
      },
      axeResults: [violation()],
    });
    const [finding] = buildResultsView(result).findings;
    expect(finding.explanation).toContain('unusable with a screen reader');
    expect(finding.recommendation).toBe('Add an aria-label.');
    expect(finding.wcagLabel).toBe('4.1.2 A — Name, Role, Value');
    expect(finding.wcagUrl).toContain('w3.org');
  });

  it('carries corrected code onto axe findings (own field or enrichment)', () => {
    const result = analysisResult({
      analysis: {
        components: [],
        enhancedAxeViolations: [
          {
            id: 'button-name',
            explanation: 'x',
            recommendation: 'y',
            correctedCode: '<button aria-label="Close">X</button>',
            codeChangeSummary: 'Added aria-label; apply to all icon buttons.',
          },
        ],
        score: 50,
      },
      axeResults: [violation()],
    });
    const [finding] = buildResultsView(result).findings;
    expect(finding.correctedCode).toBe('<button aria-label="Close">X</button>');
    expect(finding.codeChangeSummary).toBe('Added aria-label; apply to all icon buttons.');

    // Engine-side merge already stamped the violation → enrichment must not clobber it.
    const preMerged = analysisResult({
      analysis: {
        components: [],
        enhancedAxeViolations: [
          { id: 'button-name', explanation: 'x', recommendation: 'y', correctedCode: 'stale' },
        ],
        score: 50,
      },
      axeResults: [violation({ correctedCode: '<button aria-label="Menu"></button>' })],
    });
    expect(buildResultsView(preMerged).findings[0]!.correctedCode).toBe(
      '<button aria-label="Menu"></button>',
    );
  });

  it('handles the wcagReference object form already present on the violation', () => {
    const result = analysisResult({
      axeResults: [
        violation({
          wcagReference: {
            guideline: '1.1.1',
            level: 'A',
            title: 'Non-text Content',
            url: 'https://www.w3.org/WAI/WCAG21/Understanding/non-text-content',
          },
        }),
      ],
    });
    const [finding] = buildResultsView(result).findings;
    expect(finding.wcagLabel).toBe('1.1.1 A — Non-text Content');
    expect(finding.wcagUrl).toBe('https://www.w3.org/WAI/WCAG21/Understanding/non-text-content');
  });

  it('falls back to helpUrl + null impact → moderate for bare axe output', () => {
    const result = analysisResult({
      axeResults: [violation({ impact: null, wcagReference: undefined, tags: [] })],
    });
    const [finding] = buildResultsView(result).findings;
    expect(finding.severity).toBe('moderate');
    expect(finding.wcagLabel).toBe('');
    expect(finding.wcagUrl).toContain('dequeuniversity.com');
    expect(finding.isDuplicate).toBe(false);
  });

  it('attributes step URLs from the manifest when the finding has none', () => {
    const result = analysisResult({
      manifest: manifest({
        stepDetails: [
          { step: 1, isAuthRelated: false, action: 'navigate', timestamp: 't', htmlFile: 'h', axeFile: 'a', axeResultsFile: 'a', url: 'https://example.com/from-step', parentStep: null },
        ],
      }),
      axeResults: [violation({ url: undefined })],
    });
    expect(buildResultsView(result).findings[0].url).toBe('https://example.com/from-step');
  });
});

describe('filterFindings + countBySeverity', () => {
  const result = analysisResult({
    analysis: { components: [component({ impact: 'critical' })], score: 50 },
    axeResults: [
      violation(), // duplicate of the LLM finding? no — different wcag? same 4.1.2 + .menu → duplicate
      violation({ id: 'image-alt', impact: 'minor', tags: ['wcag111'], nodes: [{ html: '<img>', target: ['img'] }] }),
    ],
  });
  const view = buildResultsView(result);

  it('severity chips filter the merged list', () => {
    const onlyCritical = filterFindings(view.findings, new Set(['critical']), true);
    expect(onlyCritical).toHaveLength(1);
    expect(onlyCritical[0].source).toBe('llm');
    const none = filterFindings(view.findings, new Set(), true);
    expect(none).toHaveLength(0);
  });

  it('duplicates are hidden by default and shown on demand', () => {
    const hidden = filterFindings(view.findings, new Set(['critical', 'serious', 'moderate', 'minor']), false);
    expect(hidden.some((f) => f.isDuplicate)).toBe(false);
    const shown = filterFindings(view.findings, new Set(['critical', 'serious', 'moderate', 'minor']), true);
    expect(shown.length).toBe(hidden.length + view.duplicateCount);
  });

  it('counts by severity over non-duplicate findings', () => {
    expect(countBySeverity(view.findings)).toEqual({
      critical: 1,
      serious: 0,
      moderate: 0,
      minor: 1,
    });
  });
});

describe('selector/wcag helpers', () => {
  it('normalizeSelector reduces to the most specific classed/id segment', () => {
    expect(normalizeSelector('body > .Frame > .Frame-body')).toBe('.Frame-body');
    expect(normalizeSelector('.Frame-body')).toBe('.Frame-body');
    expect(normalizeSelector('nav ul li')).toBe('nav ul li');
    expect(normalizeSelector('')).toBe('no-selector');
  });

  it('wcagGuidelineFromTags converts axe tags to dotted guidelines', () => {
    expect(wcagGuidelineFromTags(['cat.name', 'wcag2a', 'wcag412'])).toBe('4.1.2');
    expect(wcagGuidelineFromTags(['wcag1410'])).toBe('1.4.10');
    expect(wcagGuidelineFromTags(['best-practice'])).toBeNull();
  });
});
