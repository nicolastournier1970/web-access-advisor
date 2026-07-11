import { describe, expect, it } from 'vitest';
import {
  llmAnalysisSchema,
  stepDetailSchema,
  type FlowType,
  type LlmAnalysis,
  type StepDetail,
} from '@waa/shared';
import type { LlmBatchRequest, LlmProvider } from '../engine-types.js';
import type { DomChangeDetails } from '../snapshot/dom-change-detector.js';
import type { AnalyzerSnapshot } from './manifest-builder.js';
import {
  createBatches,
  groupSnapshotsForAnalysis,
  runLlmAnalysis,
  type AnalysisBatch,
} from './batching.js';

const SESSION_URL = 'https://app.example/start';

function change(): DomChangeDetails {
  return {
    type: 'navigation',
    significant: true,
    elementsAdded: 10,
    elementsRemoved: 0,
    urlChanged: true,
    titleChanged: false,
    description: 'Navigation to new page',
  };
}

function snap(step: number, over: Partial<AnalyzerSnapshot> = {}): AnalyzerSnapshot {
  return {
    step,
    url: `https://app.example/page${step}`,
    title: `Page ${step}`,
    elementCount: 40,
    scrubbedHtml: `<html><body>step ${step}</body></html>`,
    axeViolations: [],
    files: {
      html: 'step/snapshot.html',
      axeResults: 'step/axe_results.json',
      axeContext: 'step/axe_context.json',
    },
    change: change(),
    capturedAt: '2026-07-08T00:00:00.000Z',
    ...over,
  };
}

function stepDetail(step: number, flowType: FlowType, excludeFromAnalysis = false): StepDetail {
  return stepDetailSchema.parse({
    step,
    action: 'click',
    timestamp: '2026-07-08T00:00:00.000Z',
    htmlFile: 'snapshot.html',
    axeFile: 'axe_context.json',
    axeResultsFile: 'axe_results.json',
    url: `https://app.example/page${step}`,
    flowType,
    excludeFromAnalysis,
    isAuthRelated: flowType === 'auth_flow',
  });
}

/** Deterministic provider that records every request it receives. */
class CapturingProvider implements LlmProvider {
  readonly name = 'capturing';
  readonly requests: LlmBatchRequest[] = [];
  consolidated: { batches: LlmAnalysis[]; sessionUrl: string } | null = null;
  /** Per-call summaries (and optional components/throws), consumed in order. */
  constructor(
    private readonly plans: Array<{
      summary: string;
      components?: Array<Record<string, unknown>>;
      throws?: boolean;
    }>,
  ) {}

  async analyzeBatch(request: LlmBatchRequest, _timeoutMs: number): Promise<LlmAnalysis> {
    const plan = this.plans[this.requests.length] ?? { summary: '' };
    this.requests.push(request);
    if (plan.throws === true) throw new Error('batch exploded');
    return llmAnalysisSchema.parse({
      summary: plan.summary,
      components: plan.components ?? [],
      recommendations: [],
      score: 50,
    });
  }

  async consolidate(batches: LlmAnalysis[], sessionUrl: string): Promise<LlmAnalysis> {
    this.consolidated = { batches, sessionUrl };
    return llmAnalysisSchema.parse({
      summary: `consolidated ${batches.length} batches`,
      components: batches.flatMap((b) => b.components),
      recommendations: [],
      score: 42,
    });
  }
}

function component(name: string, step?: number): Record<string, unknown> {
  return {
    componentName: name,
    issue: `${name} issue`,
    explanation: '',
    relevantHtml: '',
    correctedCode: '',
    codeChangeSummary: '',
    impact: 'moderate',
    wcagRule: '4.1.2',
    ...(step !== undefined ? { step } : {}),
  };
}

function batchOf(step: number, url: string, flowType: FlowType = 'main_app'): AnalysisBatch {
  return {
    batchId: `${flowType}_batch_${step}`,
    flowType,
    snapshots: [
      {
        step,
        url,
        html: `<html><body>step ${step}</body></html>`,
        axeViolations: [],
        domChangeDescription: 'Navigation to new page',
      },
    ],
    tokenCount: 10,
  };
}

describe('groupSnapshotsForAnalysis', () => {
  it('puts main_app first and drops excluded steps entirely', () => {
    const snapshots = [
      snap(1), // external_redirect per manifest below
      snap(2), // auth_flow, excluded
      snap(3), // main_app
      snap(4), // main_app
    ];
    const manifestSteps = [
      stepDetail(1, 'external_redirect'),
      stepDetail(2, 'auth_flow', true),
      stepDetail(3, 'main_app'),
      stepDetail(4, 'main_app'),
    ];

    const groups = groupSnapshotsForAnalysis(snapshots, manifestSteps);
    expect(groups.map((g) => g.flowType)).toEqual(['main_app', 'external_redirect']);
    expect(groups[0]!.snapshots.map((s) => s.step)).toEqual([3, 4]);
    expect(groups[1]!.snapshots.map((s) => s.step)).toEqual([1]);
    // The excluded auth snapshot appears nowhere.
    expect(groups.flatMap((g) => g.snapshots.map((s) => s.step))).not.toContain(2);
    expect(groups[0]!.tokenEstimate).toBeGreaterThan(0);
  });

  it('defaults snapshots without a manifest entry to main_app', () => {
    const groups = groupSnapshotsForAnalysis([snap(9)], []);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.flowType).toBe('main_app');
  });
});

describe('createBatches', () => {
  it('keeps a group that fits the budget in a single batch', () => {
    const groups = groupSnapshotsForAnalysis(
      [snap(1), snap(2)],
      [stepDetail(1, 'main_app'), stepDetail(2, 'main_app')],
    );
    const batches = createBatches(groups, 8000);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.snapshots.map((s) => s.step)).toEqual([1, 2]);
  });

  it('splits an oversized group at the token cap', () => {
    // ~55 tokens each (200-char html / 4 + '[]' json); cap of 100 → 2 + 1.
    const html = '<html><body>' + 'x'.repeat(188);
    const snapshots = [1, 2, 3].map((step) => snap(step, { scrubbedHtml: html }));
    const manifestSteps = snapshots.map((s) => stepDetail(s.step, 'main_app'));

    const batches = createBatches(groupSnapshotsForAnalysis(snapshots, manifestSteps), 100);
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      expect(batch.tokenCount).toBeLessThanOrEqual(100);
      expect(batch.snapshots.length).toBeGreaterThan(0);
    }
    expect(batches.flatMap((b) => b.snapshots.map((s) => s.step))).toEqual([1, 2, 3]);
  });

  it('gives a single oversized snapshot its own batch with truncated html', () => {
    const monster = snap(2, { scrubbedHtml: '<html><body>' + '<p>pad</p>'.repeat(1000) }); // ~10k chars
    const small = snap(1);
    const manifestSteps = [stepDetail(1, 'main_app'), stepDetail(2, 'main_app')];

    const batches = createBatches(groupSnapshotsForAnalysis([small, monster], manifestSteps), 100);
    const monsterBatch = batches.find((b) => b.snapshots.some((s) => s.step === 2))!;
    expect(monsterBatch.snapshots).toHaveLength(1); // isolated
    const truncatedHtml = monsterBatch.snapshots[0]!.html;
    expect(truncatedHtml.endsWith('<!-- truncated -->')).toBe(true);
    expect(truncatedHtml.length).toBeLessThanOrEqual(2000);
    // The small snapshot still ships untruncated in another batch.
    const smallBatch = batches.find((b) => b.snapshots.some((s) => s.step === 1))!;
    expect(smallBatch.snapshots[0]!.html).toBe(small.scrubbedHtml);
  });
});

describe('runLlmAnalysis', () => {
  it('accumulates the progressive summary ONCE per batch (no double concatenation)', async () => {
    const provider = new CapturingProvider([
      { summary: 'S1' },
      { summary: 'S2' },
      { summary: 'S3' },
    ]);
    const batches = [batchOf(1, 'https://a/1'), batchOf(2, 'https://a/2'), batchOf(3, 'https://a/3')];

    await runLlmAnalysis({
      batches,
      provider,
      sessionUrl: SESSION_URL,
      staticSectionMode: 'ignore',
      timeoutMs: 1000,
    });

    expect(provider.requests).toHaveLength(3);
    expect(provider.requests[0]!.progressiveSummary).toBeUndefined();
    // Legacy bug re-embedded the whole previous summary inside itself; the
    // fixed accumulator carries each batch summary exactly once.
    expect(provider.requests[1]!.progressiveSummary).toBe('S1');
    expect(provider.requests[2]!.progressiveSummary).toBe(
      'S1\n\n--- Latest Batch Summary ---\nS2',
    );
    const occurrences = provider.requests[2]!.progressiveSummary!.split('S1').length - 1;
    expect(occurrences).toBe(1);
  });

  it('trims the progressive summary to its trailing 2000 characters', async () => {
    const provider = new CapturingProvider([{ summary: 'y'.repeat(3000) }, { summary: 'z' }]);
    const batches = [batchOf(1, 'https://a/1'), batchOf(2, 'https://a/2')];

    await runLlmAnalysis({
      batches,
      provider,
      sessionUrl: SESSION_URL,
      staticSectionMode: 'ignore',
      timeoutMs: 1000,
    });

    const forwarded = provider.requests[1]!.progressiveSummary!;
    expect(forwarded.startsWith('...(previous context truncated)...')).toBe(true);
    expect(forwarded.length).toBeLessThanOrEqual(2050); // 2000 + marker line
    expect(forwarded.endsWith('y'.repeat(100))).toBe(true);
  });

  it('re-anchors component URLs via the batch step map (fallback: first snapshot)', async () => {
    const provider = new CapturingProvider([
      {
        summary: 'S1',
        components: [component('Mapped', 7), component('Unmapped'), component('WrongStep', 99)],
      },
    ]);
    const batch = batchOf(7, 'https://app.example/step7');

    const analysis = await runLlmAnalysis({
      batches: [batch],
      provider,
      sessionUrl: SESSION_URL,
      staticSectionMode: 'ignore',
      timeoutMs: 1000,
    });

    const byName = new Map(analysis.components.map((c) => [c.componentName, c]));
    expect(byName.get('Mapped')?.url).toBe('https://app.example/step7');
    expect(byName.get('Unmapped')?.url).toBe('https://app.example/step7'); // fallback
    expect(byName.get('Unmapped')?.step).toBe(7); // fallback step assigned
    expect(byName.get('WrongStep')?.url).toBe('https://app.example/step7'); // fallback
  });

  it('skips failed batches, slims axe violations, and consolidates the rest', async () => {
    const provider = new CapturingProvider([
      { summary: 'first', throws: true },
      { summary: 'second', components: [component('Survivor', 2)] },
    ]);
    const violation = {
      id: 'image-alt',
      impact: 'critical',
      description: 'd',
      help: 'h',
      helpUrl: 'u',
      tags: [],
      nodes: Array.from({ length: 9 }, (_, n) => ({ html: `<img id="i${n}">`, target: [`#i${n}`] })),
      passesNotNeeded: 'extra-prop',
    };
    const failing = batchOf(1, 'https://a/1');
    const surviving: AnalysisBatch = {
      ...batchOf(2, 'https://a/2'),
      snapshots: [{ ...batchOf(2, 'https://a/2').snapshots[0]!, axeViolations: [violation] }],
    };

    const analysis = await runLlmAnalysis({
      batches: [failing, surviving],
      provider,
      sessionUrl: SESSION_URL,
      staticSectionMode: 'ignore',
      timeoutMs: 1000,
    });

    // Batch 1 threw AFTER being requested; batch 2 still ran and consolidated.
    expect(provider.requests).toHaveLength(2);
    expect(provider.consolidated?.batches).toHaveLength(1);
    expect(provider.consolidated?.sessionUrl).toBe(SESSION_URL);
    expect(analysis.components.map((c) => c.componentName)).toEqual(['Survivor']);

    // Slimming: max 5 nodes survive into the request JSON.
    const sent = JSON.parse(provider.requests[1]!.snapshots[0]!.axeViolationsJson) as Array<{
      nodes: unknown[];
    }>;
    expect(sent[0]!.nodes).toHaveLength(5);
  });

  it('reports failed batches through onBatchError', async () => {
    const provider = new CapturingProvider([
      { summary: 'first', throws: true },
      { summary: 'second' },
    ]);
    const failing = batchOf(1, 'https://a/1');
    const surviving = batchOf(2, 'https://a/2');
    const failures: Array<[string, unknown]> = [];

    await runLlmAnalysis({
      batches: [failing, surviving],
      provider,
      sessionUrl: SESSION_URL,
      staticSectionMode: 'ignore',
      timeoutMs: 1000,
      onBatchError: (batchId, error) => failures.push([batchId, error]),
    });

    expect(failures).toHaveLength(1);
    expect(failures[0]![0]).toBe(failing.batchId);
    expect(failures[0]![1]).toBeInstanceOf(Error);
  });

  it('reports batch progress through onBatch', async () => {
    const provider = new CapturingProvider([{ summary: 'a' }, { summary: 'b' }]);
    const calls: Array<[number, number, string]> = [];
    await runLlmAnalysis({
      batches: [batchOf(1, 'https://a/1'), batchOf(2, 'https://a/2', 'external_redirect')],
      provider,
      sessionUrl: SESSION_URL,
      staticSectionMode: 'ignore',
      timeoutMs: 1000,
      onBatch: (current, total, flowType) => calls.push([current, total, flowType]),
    });
    expect(calls).toEqual([
      [1, 2, 'main_app'],
      [2, 2, 'external_redirect'],
    ]);
  });
});
