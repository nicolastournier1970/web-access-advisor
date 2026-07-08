import { describe, expect, it } from 'vitest';
import {
  llmAnalysisSchema,
  sessionManifestSchema,
  type ActionV2,
  type AuthDomainsConfig,
  type RecordingV2,
} from '@waa/shared';
import type { DomChangeDetails } from '../snapshot/dom-change-detector.js';
import {
  buildManifest,
  consolidateAxeViolations,
  type ActionOutcomeRecord,
  type AnalyzerSnapshot,
} from './manifest-builder.js';

const SESSION_URL = 'https://app.example/start';

const AUTH_CONFIG: AuthDomainsConfig = {
  authDomains: ['login.example'],
  clientDomains: [],
  authPathPatterns: ['/signin'],
};

function act(step: number, type: ActionV2['type'], over: Partial<ActionV2> = {}): ActionV2 {
  return {
    type,
    step,
    timestamp: `2026-07-08T00:00:0${step}.000Z`,
    redacted: false,
    ...over,
  };
}

function makeRecording(actions: ActionV2[], over: Partial<RecordingV2> = {}): RecordingV2 {
  return {
    formatVersion: 2,
    sessionId: 'session_test',
    url: SESSION_URL,
    startTime: '2026-07-08T00:00:00.000Z',
    actions,
    authCheckpoints: [],
    browserType: 'chromium',
    useProfile: false,
    ...over,
  };
}

function change(over: Partial<DomChangeDetails> = {}): DomChangeDetails {
  return {
    type: 'navigation',
    significant: true,
    elementsAdded: 12,
    elementsRemoved: 0,
    urlChanged: true,
    titleChanged: false,
    description: 'Navigation to new page',
    ...over,
  };
}

function snap(step: number, url: string, over: Partial<AnalyzerSnapshot> = {}): AnalyzerSnapshot {
  const dir = `step_${String(step).padStart(3, '0')}`;
  return {
    step,
    url,
    title: `Page ${step}`,
    elementCount: 50,
    scrubbedHtml: `<html><body>step ${step}</body></html>`,
    axeViolations: [],
    files: {
      html: `${dir}/snapshot.html`,
      axeResults: `${dir}/axe_results.json`,
      axeContext: `${dir}/axe_context.json`,
    },
    change: change(),
    capturedAt: '2026-07-08T00:01:00.000Z',
    ...over,
  };
}

function axeViolation(
  id: string,
  impact: string | null,
  targets: string[],
): Record<string, unknown> {
  return {
    id,
    impact,
    description: `${id} description`,
    help: `${id} help`,
    helpUrl: `https://dequeuniversity.com/rules/axe/${id}`,
    tags: ['wcag2a'],
    nodes: targets.map((target) => ({ html: `<${target}>`, target: [target] })),
  };
}

describe('buildManifest', () => {
  it('REGRESSION: joins actions to snapshots on STEP, never on array index', () => {
    // Six recorded actions but only three captured snapshots (1, 4, 6): the
    // legacy index join would pair snapshots[1] (step 4) with actions[1]
    // (step 2, a fill on '#b'); the fix pairs it with the step-4 click.
    const recording = makeRecording([
      act(1, 'navigate', { url: SESSION_URL }),
      act(2, 'fill', { selector: '#b', value: 'text' }),
      act(3, 'click', { selector: '#mid' }),
      act(4, 'click', {
        selector: '#c',
        target: { candidates: [{ strategy: 'css', value: '#c' }], description: 'Save button' },
      }),
      act(5, 'fill', { selector: '#d', value: 'more' }),
      act(6, 'click', { selector: '#e' }),
    ]);
    const snapshots = [snap(1, SESSION_URL), snap(4, SESSION_URL), snap(6, SESSION_URL)];

    const manifest = buildManifest({
      recording,
      snapshots,
      outcomes: [],
      sessionUrl: SESSION_URL,
      authConfig: AUTH_CONFIG,
    });

    expect(manifest.stepDetails.map((s) => s.step)).toEqual([1, 4, 6]);
    const middle = manifest.stepDetails[1]!;
    // The step-4 action — NOT actions[1] (step-2 fill).
    expect(middle.action).toBe('click');
    expect(middle.actionType).toBe('interaction');
    expect(middle.interactionTarget).toBe('Save button');
    // Legacy would have produced the step-2 attribution:
    expect(middle.action).not.toBe('fill');
    expect(middle.interactionTarget).not.toBe('#b');
    expect(middle.timestamp).toBe('2026-07-08T00:00:04.000Z');
  });

  it('chains parentStep/previousStep/nextStep over SNAPSHOT steps', () => {
    const recording = makeRecording([
      act(1, 'navigate', { url: SESSION_URL }),
      act(2, 'click', { selector: '#a' }),
      act(3, 'click', { selector: '#b' }),
      act(4, 'click', { selector: '#c' }),
    ]);
    const snapshots = [snap(1, SESSION_URL), snap(3, SESSION_URL), snap(4, SESSION_URL)];
    const manifest = buildManifest({
      recording,
      snapshots,
      outcomes: [],
      sessionUrl: SESSION_URL,
      authConfig: AUTH_CONFIG,
    });

    const [first, second, third] = manifest.stepDetails as [
      (typeof manifest.stepDetails)[number],
      (typeof manifest.stepDetails)[number],
      (typeof manifest.stepDetails)[number],
    ];
    expect(first.parentStep).toBeNull();
    expect(first.previousStep).toBeUndefined();
    expect(first.nextStep).toBe(3);
    expect(second.parentStep).toBe(1);
    expect(second.previousStep).toBe(1);
    expect(second.nextStep).toBe(4);
    expect(third.parentStep).toBe(3);
    expect(third.previousStep).toBe(3);
    expect(third.nextStep).toBeUndefined();
  });

  it('joins replay outcomes by step and classifies flow types from URLs', () => {
    const recording = makeRecording([
      act(1, 'navigate', { url: SESSION_URL }),
      act(2, 'click', { selector: '#login' }),
      act(3, 'click', { selector: '#oops' }),
    ]);
    const snapshots = [
      snap(1, SESSION_URL),
      snap(2, 'https://login.example/signin'),
      snap(3, 'https://app.example/error/500'),
    ];
    const outcomes: ActionOutcomeRecord[] = [
      { step: 1, outcome: 'executed' },
      { step: 3, outcome: 'failed', detail: 'target-not-resolved' },
    ];

    const manifest = buildManifest({
      recording,
      snapshots,
      outcomes,
      sessionUrl: SESSION_URL,
      authConfig: AUTH_CONFIG,
    });

    const [main, auth, error] = manifest.stepDetails as [
      (typeof manifest.stepDetails)[number],
      (typeof manifest.stepDetails)[number],
      (typeof manifest.stepDetails)[number],
    ];
    expect(main.flowType).toBe('main_app');
    expect(main.actionOutcome).toBe('executed');
    expect(main.excludeFromAnalysis).toBe(false);

    expect(auth.flowType).toBe('auth_flow');
    expect(auth.isAuthRelated).toBe(true);
    expect(auth.excludeFromAnalysis).toBe(true);
    expect(auth.skipReason).toContain('Authentication flow');
    expect(auth.actionOutcome).toBeUndefined();

    expect(error.flowType).toBe('error_flow');
    expect(error.excludeFromAnalysis).toBe(true);
    expect(error.actionOutcome).toBe('failed');
    expect(error.actionOutcomeDetail).toBe('target-not-resolved');
  });

  it('fills dom-change fields, token estimate and file names; validates against the schema', () => {
    const recording = makeRecording([act(1, 'navigate', { url: SESSION_URL })]);
    const html = '<html><body>' + 'a'.repeat(390) + '</body></html>'; // 416 chars
    const snapshots = [
      snap(1, SESSION_URL, {
        scrubbedHtml: html,
        change: change({ type: 'content', significant: true, elementsAdded: 7, elementsRemoved: 2, description: 'Significant content change (+5 elements)' }),
        files: {
          html: 'step_001/snapshot.html',
          axeResults: 'step_001/axe_results.json',
          axeContext: 'step_001/axe_context.json',
          screenshot: 'step_001/screenshot.png',
        },
      }),
    ];
    const manifest = buildManifest({
      recording,
      snapshots,
      outcomes: [{ step: 1, outcome: 'executed' }],
      sessionUrl: SESSION_URL,
      authConfig: AUTH_CONFIG,
      truncated: true,
      truncationReason: 'testing truncation',
    });

    const detail = manifest.stepDetails[0]!;
    expect(detail.domChangeType).toBe('content');
    expect(detail.domChanges).toContain('Significant content change');
    expect(detail.domChangeSummary).toMatchObject({
      elementsAdded: 7,
      elementsRemoved: 2,
      significantChange: true,
    });
    expect(detail.tokenEstimate).toBe(Math.ceil(html.length / 4));
    expect(detail.htmlFile).toBe('snapshot.html');
    expect(detail.axeFile).toBe('axe_context.json');
    expect(detail.axeResultsFile).toBe('axe_results.json');
    expect(detail.screenshotFile).toBe('screenshot.png');

    expect(manifest.truncated).toBe(true);
    expect(manifest.truncationReason).toBe('testing truncation');
    expect(manifest.totalSteps).toBe(1);
    expect(manifest.recordingContext?.recordingNote).toContain('clean browser session');

    // Round-trips through the shared schema without loss of required fields.
    const parsed = sessionManifestSchema.parse(manifest);
    expect(parsed.stepDetails).toHaveLength(1);
  });
});

describe('consolidateAxeViolations', () => {
  it('dedupes by rule id + node targets and tracks stepOccurrences', () => {
    const snapshots = [
      snap(1, SESSION_URL, {
        axeViolations: [axeViolation('image-alt', 'critical', ['img'])],
      }),
      snap(4, 'https://app.example/page2', {
        axeViolations: [
          axeViolation('image-alt', 'critical', ['img']), // duplicate
          axeViolation('image-alt', 'critical', ['img.hero']), // different target
        ],
      }),
      snap(6, SESSION_URL, {
        axeViolations: [axeViolation('image-alt', 'critical', ['img'])], // duplicate again
      }),
    ];

    const consolidated = consolidateAxeViolations(snapshots);
    expect(consolidated).toHaveLength(2);

    const deduped = consolidated.find((v) => v.nodes[0]?.target[0] === 'img')!;
    expect(deduped.step).toBe(1);
    expect(deduped.url).toBe(SESSION_URL);
    expect(deduped.stepOccurrences).toEqual([1, 4, 6]);

    const other = consolidated.find((v) => v.nodes[0]?.target[0] === 'img.hero')!;
    expect(other.stepOccurrences).toEqual([4]);
  });

  it('merges LLM enhancements by rule id and strips a stray WCAG prefix', () => {
    const snapshots = [
      snap(1, SESSION_URL, {
        axeViolations: [
          axeViolation('image-alt', 'critical', ['img']),
          axeViolation('label', 'serious', ['input']),
        ],
      }),
    ];
    const llm = llmAnalysisSchema.parse({
      summary: 'batch summary',
      components: [],
      recommendations: [],
      score: 80,
      enhancedAxeViolations: [
        {
          id: 'image-alt',
          explanation: 'Images need alt text.',
          recommendation: 'Add alt attributes.',
          wcag: {
            guideline: 'WCAG 1.1.1',
            level: 'A',
            title: 'Non-text Content',
            url: 'https://www.w3.org/WAI/WCAG21/Understanding/non-text-content.html',
          },
        },
      ],
    });

    const consolidated = consolidateAxeViolations(snapshots, llm);
    const enhanced = consolidated.find((v) => v.id === 'image-alt')!;
    expect(enhanced.explanation).toBe('Images need alt text.');
    expect(enhanced.recommendation).toBe('Add alt attributes.');
    expect(enhanced.wcagReference?.guideline).toBe('1.1.1'); // prefix stripped
    expect(enhanced.wcagReference?.level).toBe('A');

    const untouched = consolidated.find((v) => v.id === 'label')!;
    expect(untouched.explanation).toBeUndefined();
  });

  it('sorts by impact severity and drops malformed entries without throwing', () => {
    const snapshots = [
      snap(1, SESSION_URL, {
        axeViolations: [
          axeViolation('minor-rule', 'minor', ['p']),
          axeViolation('moderate-rule', 'moderate', ['div']),
          { not: 'a violation' }, // malformed → dropped
          axeViolation('critical-rule', 'critical', ['img']),
          axeViolation('serious-rule', 'serious', ['a']),
          axeViolation('no-impact-rule', null, ['span']),
        ],
      }),
    ];

    const consolidated = consolidateAxeViolations(snapshots);
    expect(consolidated.map((v) => v.id)).toEqual([
      'critical-rule',
      'serious-rule',
      'moderate-rule',
      'minor-rule',
      'no-impact-rule',
    ]);
  });
});
