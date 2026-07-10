import { describe, it, expect } from 'vitest';
import { llmAnalysisSchema } from '@waa/shared';
import type { LlmBatchRequest } from '../engine-types.js';
import { StubProvider } from './stub.provider.js';

const AXE_JSON = JSON.stringify([
  { id: 'label', nodes: [{ target: ['#search-input'] }] },
]);

function request(): LlmBatchRequest {
  return {
    batchId: 'b1',
    snapshots: [
      {
        step: 1,
        url: 'https://example.com/',
        html: '<main></main>',
        axeViolationsJson: AXE_JSON,
        domChangeDescription: 'load',
      },
      {
        step: 3,
        url: 'https://example.com/next',
        html: '<div></div>',
        axeViolationsJson: '[]',
        domChangeDescription: 'click',
      },
    ],
    staticSectionMode: 'ignore',
  };
}

describe('StubProvider.analyzeBatch', () => {
  it('emits one component per snapshot with the canned shape', async () => {
    const provider = new StubProvider();
    const analysis = await provider.analyzeBatch(request(), 1000);

    expect(analysis.components).toHaveLength(2);
    expect(analysis.components.map((c) => c.componentName)).toEqual([
      'Stub component (step 1)',
      'Stub component (step 3)',
    ]);
    for (const component of analysis.components) {
      expect(component.impact).toBe('moderate');
      expect(component.wcagRule).toBe('4.1.2');
    }
    expect(analysis.summary).toContain('2 snapshot(s)');
    expect(analysis.score).toBe(42);
  });

  it('takes the selector from the first axe violation when present', async () => {
    const analysis = await new StubProvider().analyzeBatch(request(), 1000);
    expect(analysis.components[0]!.selector).toBe('#search-input');
    expect(analysis.components[1]!.selector).toBeUndefined();
  });

  it('emits one enhanced entry with corrected code per distinct violation id', async () => {
    const analysis = await new StubProvider().analyzeBatch(request(), 1000);
    expect(analysis.enhancedAxeViolations).toHaveLength(1);
    const [enhanced] = analysis.enhancedAxeViolations!;
    expect(enhanced!.id).toBe('label');
    expect(enhanced!.correctedCode).toContain('stub fix: label');
    expect(enhanced!.codeChangeSummary).toContain('label');
    expect(enhanced!.recommendation).toMatch(/Reference: https:\/\//);
    expect(enhanced!.wcag?.guideline).toBe('4.1.2');
  });

  it('is deterministic and schema-valid', async () => {
    const provider = new StubProvider();
    const a = await provider.analyzeBatch(request(), 1000);
    const b = await provider.analyzeBatch(request(), 99999);
    expect(a).toEqual(b);
    expect(llmAnalysisSchema.safeParse(a).success).toBe(true);
  });

  it('exposes the stub name', () => {
    expect(new StubProvider().name).toBe('stub');
  });
});

describe('StubProvider.consolidate', () => {
  it('merges components and dedupes by componentName', async () => {
    const provider = new StubProvider();
    const batch1 = await provider.analyzeBatch(request(), 1000);
    const batch2 = await provider.analyzeBatch(request(), 1000); // same names again
    const merged = await provider.consolidate([batch1, batch2], 'https://example.com');

    expect(merged.components).toHaveLength(2);
    expect(new Set(merged.components.map((c) => c.componentName)).size).toBe(2);
    expect(merged.summary).toContain('https://example.com');
    expect(merged.score).toBe(42);
    expect(llmAnalysisSchema.safeParse(merged).success).toBe(true);
  });

  it('merges enhanced axe violations by id (first wins)', async () => {
    const provider = new StubProvider();
    const batch1 = await provider.analyzeBatch(request(), 1000);
    const batch2 = await provider.analyzeBatch(request(), 1000);
    const merged = await provider.consolidate([batch1, batch2], 'https://example.com');

    expect(merged.enhancedAxeViolations).toHaveLength(1);
    expect(merged.enhancedAxeViolations![0]!.id).toBe('label');
    expect(merged.enhancedAxeViolations![0]!.correctedCode).toContain('stub fix: label');
  });
});
