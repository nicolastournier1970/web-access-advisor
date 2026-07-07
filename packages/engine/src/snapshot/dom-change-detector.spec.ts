import { describe, it, expect } from 'vitest';
import type { ActionV2 } from '@waa/shared';
import {
  DomChangeDetector,
  decideSnapshot,
  type DomChangeDetails,
  type PageState,
} from './dom-change-detector.js';

function state(overrides: Partial<PageState> = {}): PageState {
  return {
    url: 'https://example.com/',
    title: 'Example',
    elementCount: 100,
    bodyHtml: '<div>base</div>',
    ...overrides,
  };
}

/** Detector already primed with the base state (first call consumed). */
function primedDetector(base: PageState = state()): DomChangeDetector {
  const d = new DomChangeDetector();
  d.detectChanges(base);
  return d;
}

describe('DomChangeDetector.detectChanges', () => {
  it('classifies the first call as a significant navigation (initial load)', () => {
    const d = new DomChangeDetector();
    const result = d.detectChanges(state({ elementCount: 42 }));
    expect(result).toEqual({
      type: 'navigation',
      significant: true,
      elementsAdded: 42,
      elementsRemoved: 0,
      urlChanged: false,
      titleChanged: false,
      description: 'Initial page load',
    });
  });

  it('classifies a URL change as significant navigation', () => {
    const d = primedDetector();
    const result = d.detectChanges(
      state({ url: 'https://example.com/other', bodyHtml: '<div>new</div>' }),
    );
    expect(result.type).toBe('navigation');
    expect(result.significant).toBe(true);
    expect(result.urlChanged).toBe(true);
  });

  it('classifies identical bodyHtml as none / not significant', () => {
    const d = primedDetector();
    const result = d.detectChanges(state());
    expect(result.type).toBe('none');
    expect(result.significant).toBe(false);
    expect(result.description).toBe('No DOM changes detected');
  });

  it('treats identical bodyHtml as none even if elementCount differs', () => {
    const d = primedDetector();
    const result = d.detectChanges(state({ elementCount: 250 }));
    expect(result.type).toBe('none');
    expect(result.significant).toBe(false);
  });

  it('classifies Δ=11 as significant content change', () => {
    const d = primedDetector();
    const result = d.detectChanges(state({ elementCount: 111, bodyHtml: '<div>more</div>' }));
    expect(result.type).toBe('content');
    expect(result.significant).toBe(true);
    expect(result.elementsAdded).toBe(11);
    expect(result.elementsRemoved).toBe(0);
    expect(result.description).toBe('Significant content change (+11 elements)');
  });

  it('classifies Δ=-11 as significant content change with elementsRemoved', () => {
    const d = primedDetector();
    const result = d.detectChanges(state({ elementCount: 89, bodyHtml: '<div>less</div>' }));
    expect(result.type).toBe('content');
    expect(result.significant).toBe(true);
    expect(result.elementsAdded).toBe(0);
    expect(result.elementsRemoved).toBe(11);
  });

  it('classifies a title change as significant content even with small Δ', () => {
    const d = primedDetector();
    const result = d.detectChanges(
      state({ title: 'Changed', elementCount: 101, bodyHtml: '<div>x</div>' }),
    );
    expect(result.type).toBe('content');
    expect(result.significant).toBe(true);
    expect(result.titleChanged).toBe(true);
  });

  it('classifies Δ=3 as significant interaction', () => {
    const d = primedDetector();
    const result = d.detectChanges(state({ elementCount: 103, bodyHtml: '<div>y</div>' }));
    expect(result.type).toBe('interaction');
    expect(result.significant).toBe(true);
    expect(result.elementsAdded).toBe(3);
  });

  it('classifies Δ=2 as interaction but not significant', () => {
    const d = primedDetector();
    const result = d.detectChanges(state({ elementCount: 102, bodyHtml: '<div>z</div>' }));
    expect(result.type).toBe('interaction');
    expect(result.significant).toBe(false);
  });

  it('keeps negative small deltas not significant (legacy signed comparison)', () => {
    const d = primedDetector();
    const result = d.detectChanges(state({ elementCount: 97, bodyHtml: '<div>w</div>' }));
    expect(result.type).toBe('interaction');
    expect(result.significant).toBe(false);
    expect(result.elementsRemoved).toBe(3);
    expect(result.elementsAdded).toBe(0);
  });

  it('classifies Δ=0 with changed body as layout / not significant', () => {
    const d = primedDetector();
    const result = d.detectChanges(state({ bodyHtml: '<div>restyled</div>' }));
    expect(result.type).toBe('layout');
    expect(result.significant).toBe(false);
    expect(result.description).toBe('Layout or style changes only');
  });

  it('compares against the most recent state, not the first one', () => {
    const d = primedDetector();
    d.detectChanges(state({ elementCount: 120, bodyHtml: '<div>a</div>' }));
    const result = d.detectChanges(state({ elementCount: 121, bodyHtml: '<div>b</div>' }));
    expect(result.type).toBe('interaction');
    expect(result.elementsAdded).toBe(1);
  });

  it('reset() makes the next call an initial load again', () => {
    const d = primedDetector();
    d.reset();
    const result = d.detectChanges(state({ elementCount: 7 }));
    expect(result.type).toBe('navigation');
    expect(result.description).toBe('Initial page load');
    expect(result.elementsAdded).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// decideSnapshot
// ---------------------------------------------------------------------------

function action(overrides: Partial<ActionV2> = {}): ActionV2 {
  return {
    type: 'click',
    step: 1,
    timestamp: '2026-01-01T00:00:00.000Z',
    redacted: false,
    ...overrides,
  };
}

function change(overrides: Partial<DomChangeDetails> = {}): DomChangeDetails {
  return {
    type: 'layout',
    significant: false,
    elementsAdded: 0,
    elementsRemoved: 0,
    urlChanged: false,
    titleChanged: false,
    description: 'Layout or style changes only',
    ...overrides,
  };
}

describe('decideSnapshot', () => {
  it('always captures the first snapshot', () => {
    const a = action();
    const result = decideSnapshot({
      action: a,
      actionIndex: 0,
      allActions: [a],
      change: change(),
      isFirstSnapshot: true,
    });
    expect(result.capture).toBe(true);
  });

  it('always captures navigation changes', () => {
    const a = action({ type: 'navigate' });
    const result = decideSnapshot({
      action: a,
      actionIndex: 3,
      allActions: [action(), action(), action(), a],
      change: change({ type: 'navigation', significant: true }),
      isFirstSnapshot: false,
    });
    expect(result.capture).toBe(true);
  });

  it('always captures significant changes even for fill actions', () => {
    const fillA = action({ type: 'fill', selector: '#name' });
    const fillB = action({ type: 'fill', selector: '#name' });
    const result = decideSnapshot({
      action: fillA,
      actionIndex: 0,
      allActions: [fillA, fillB],
      change: change({ type: 'content', significant: true }),
      isFirstSnapshot: false,
    });
    expect(result.capture).toBe(true);
  });

  it('debounces consecutive fills on the same selector: first skipped, last captured', () => {
    const fill1 = action({ type: 'fill', selector: '#email', value: 'a' });
    const fill2 = action({ type: 'fill', selector: '#email', value: 'ab' });
    const click = action({ type: 'click', selector: '#submit' });
    const all = [fill1, fill2, click];

    const first = decideSnapshot({
      action: fill1,
      actionIndex: 0,
      allActions: all,
      change: change(),
      isFirstSnapshot: false,
    });
    expect(first.capture).toBe(false);

    const last = decideSnapshot({
      action: fill2,
      actionIndex: 1,
      allActions: all,
      change: change(),
      isFirstSnapshot: false,
    });
    expect(last.capture).toBe(true);
  });

  it('captures both fills when they target different elements', () => {
    const fillA = action({ type: 'fill', selector: '#email' });
    const fillB = action({ type: 'fill', selector: '#password' });
    const all = [fillA, fillB];

    const first = decideSnapshot({
      action: fillA,
      actionIndex: 0,
      allActions: all,
      change: change(),
      isFirstSnapshot: false,
    });
    expect(first.capture).toBe(true);

    const second = decideSnapshot({
      action: fillB,
      actionIndex: 1,
      allActions: all,
      change: change(),
      isFirstSnapshot: false,
    });
    expect(second.capture).toBe(true);
  });

  it('captures a fill that is the last recorded action', () => {
    const fill = action({ type: 'fill', selector: '#q' });
    const result = decideSnapshot({
      action: fill,
      actionIndex: 0,
      allActions: [fill],
      change: change(),
      isFirstSnapshot: false,
    });
    expect(result.capture).toBe(true);
  });

  it('debounces fills matched via v2 target candidates when selector is absent', () => {
    const target = {
      candidates: [{ strategy: 'id' as const, value: 'email' }],
    };
    const fill1 = action({ type: 'fill', target });
    const fill2 = action({ type: 'fill', target });
    const all = [fill1, fill2];

    const first = decideSnapshot({
      action: fill1,
      actionIndex: 0,
      allActions: all,
      change: change(),
      isFirstSnapshot: false,
    });
    expect(first.capture).toBe(false);
  });

  it('skips non-fill actions with no significant change', () => {
    const a = action({ type: 'hover' });
    const result = decideSnapshot({
      action: a,
      actionIndex: 1,
      allActions: [action(), a],
      change: change({ type: 'none' }),
      isFirstSnapshot: false,
    });
    expect(result.capture).toBe(false);
    expect(result.reason).toContain('No significant change');
  });
});
