/**
 * Pure DOM-change classification + snapshot gating policy.
 *
 * Ported verbatim (in behavior) from the legacy private `DOMChangeDetector`
 * class and `shouldCaptureSnapshot` method in packages/core/src/analyzer.ts.
 * This module never touches Playwright: the caller (the snapshotter, a later
 * wave) evaluates the page and hands us a plain {@link PageState}.
 */
import type { ActionV2, DomChangeType } from '@waa/shared';

/**
 * Minimal page observation the detector compares between steps. Produced by
 * the caller via `page.evaluate` (url/title/`querySelectorAll('*').length`/
 * `document.body.innerHTML`) — this module only diffs the values.
 */
export interface PageState {
  url: string;
  title: string;
  elementCount: number;
  bodyHtml: string;
}

/**
 * Classified diff between two consecutive {@link PageState}s.
 *
 * Field semantics (legacy-preserved): `elementsAdded = max(0, Δ)` and
 * `elementsRemoved = max(0, -Δ)` where Δ is the signed element-count delta —
 * only one of the two is ever non-zero. The legacy `elementsModified` field
 * (a 0/1 flag) was dropped; `type !== 'none'` carries the same information.
 */
export interface DomChangeDetails {
  type: DomChangeType;
  significant: boolean;
  elementsAdded: number;
  elementsRemoved: number;
  urlChanged: boolean;
  titleChanged: boolean;
  description: string;
}

/**
 * Stateful classifier: each `detectChanges` call diffs against the previous
 * call's state. Create one instance per replay run (state is never shared
 * across sessions); call {@link DomChangeDetector.reset} to reuse an instance.
 *
 * Classification rules (exact legacy thresholds, checked in this order):
 *  1. first call            → navigation / significant ("Initial page load")
 *  2. url changed           → navigation / significant
 *  3. identical bodyHtml    → none / not significant
 *  4. |Δ| > 10 or title chg → content / significant
 *  5. |Δ| > 0               → interaction / significant only when Δ > 2
 *                             (signed — large removals stay not-significant,
 *                             a legacy quirk preserved deliberately)
 *  6. otherwise             → layout / not significant
 */
export class DomChangeDetector {
  private previousState: PageState | null = null;

  /**
   * Classify the change from the previously observed state to `current`, then
   * store `current` for the next comparison.
   */
  detectChanges(current: PageState): DomChangeDetails {
    if (!this.previousState) {
      this.previousState = current;
      return {
        type: 'navigation',
        significant: true,
        elementsAdded: current.elementCount,
        elementsRemoved: 0,
        urlChanged: false,
        titleChanged: false,
        description: 'Initial page load',
      };
    }

    const urlChanged = this.previousState.url !== current.url;
    const titleChanged = this.previousState.title !== current.title;
    const elementCountDiff = current.elementCount - this.previousState.elementCount;
    const bodyChanged = this.previousState.bodyHtml !== current.bodyHtml;

    let type: DomChangeType;
    let significant = false;
    let description = '';

    if (urlChanged) {
      type = 'navigation';
      significant = true;
      description = 'Navigation to new page';
    } else if (!bodyChanged) {
      type = 'none';
      description = 'No DOM changes detected';
    } else if (Math.abs(elementCountDiff) > 10 || titleChanged) {
      type = 'content';
      significant = true;
      description = `Significant content change (${elementCountDiff > 0 ? '+' : ''}${elementCountDiff} elements)`;
    } else if (Math.abs(elementCountDiff) > 0) {
      type = 'interaction';
      significant = elementCountDiff > 2;
      description = `Interactive change (${elementCountDiff > 0 ? '+' : ''}${elementCountDiff} elements)`;
    } else {
      type = 'layout';
      significant = false;
      description = 'Layout or style changes only';
    }

    const details: DomChangeDetails = {
      type,
      significant,
      elementsAdded: Math.max(0, elementCountDiff),
      elementsRemoved: Math.max(0, -elementCountDiff),
      urlChanged,
      titleChanged,
      description,
    };

    this.previousState = current;
    return details;
  }

  /** Forget the stored state; the next `detectChanges` is an "initial load" again. */
  reset(): void {
    this.previousState = null;
  }
}

/** Inputs for {@link decideSnapshot}. */
export interface SnapshotDecisionParams {
  /** The action that was just replayed. */
  action: ActionV2;
  /** Index of `action` inside `allActions` (used for the fill look-ahead). */
  actionIndex: number;
  /** Full replay action list, needed to look ahead past `actionIndex`. */
  allActions: ActionV2[];
  /** Classified DOM diff produced after executing `action`. */
  change: DomChangeDetails;
  /** True when no snapshot has been captured yet in this replay. */
  isFirstSnapshot: boolean;
}

/** Outcome of the snapshot gate; `reason` is human-readable (manifest/skip logs). */
export interface SnapshotDecision {
  capture: boolean;
  reason: string;
}

/**
 * Stable identity for a fill's target so consecutive fills on the same field
 * can be debounced. Prefers the legacy CSS `selector` mirror, falls back to
 * the first v2 locator candidate. Two fills with neither selector nor target
 * compare equal — mirroring the legacy `undefined === undefined` behavior.
 */
function fillTargetKey(action: ActionV2): string {
  if (action.selector) return `css:${action.selector}`;
  if (action.target && action.target.candidates.length > 0) {
    return `cand:${JSON.stringify(action.target.candidates[0])}`;
  }
  return 'unknown';
}

/**
 * Snapshot gating policy, ported from the legacy `shouldCaptureSnapshot`:
 *  - always capture the first snapshot, any navigation, and any significant
 *    DOM change;
 *  - for `fill` actions, debounce form typing by looking ahead: skip when a
 *    LATER consecutive fill targets the same element, capture the final fill
 *    in the run (a non-fill action or a fill on a different element ends the
 *    run, as does the end of the action list);
 *  - everything else is skipped (the change was already not significant).
 */
export function decideSnapshot(params: SnapshotDecisionParams): SnapshotDecision {
  const { action, actionIndex, allActions, change, isFirstSnapshot } = params;

  if (isFirstSnapshot) {
    return { capture: true, reason: 'First snapshot of the replay' };
  }

  if (change.type === 'navigation') {
    return { capture: true, reason: 'Navigation change' };
  }

  if (change.significant) {
    return { capture: true, reason: `Significant DOM change: ${change.description}` };
  }

  if (action.type === 'fill') {
    const key = fillTargetKey(action);
    for (let i = actionIndex + 1; i < allActions.length; i++) {
      const next = allActions[i]!;
      if (next.type === 'fill' && fillTargetKey(next) === key) {
        return {
          capture: false,
          reason: 'Debounced fill: a later fill targets the same element',
        };
      }
      if (next.type !== 'fill') {
        return { capture: true, reason: 'Final fill state before a non-fill action' };
      }
      // next is a fill on a different element → current fill run is final.
      return { capture: true, reason: 'Final fill state (next fill targets another element)' };
    }
    return { capture: true, reason: 'Final fill state (end of recorded actions)' };
  }

  return { capture: false, reason: `No significant change: ${change.description}` };
}
