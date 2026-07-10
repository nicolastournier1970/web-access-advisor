/**
 * Unit tests for the replayer: candidate resolution order, structured action
 * outcomes, and settlement — all driven through fake pages (no browser).
 * The real-browser smoke test lives in src/snapshot/snapshotter.spec.ts.
 */
import { describe, expect, it } from 'vitest';
import { REDACTED_VALUE, type ActionV2, type TargetCandidate } from '@waa/shared';
import {
  executeAction,
  resolveTarget,
  settle,
  type ReplayLocator,
  type ReplayPageActions,
} from './replayer.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function fakeLocator(count: number, log: string[], label = 'loc'): ReplayLocator {
  const self: ReplayLocator = {
    count: async () => {
      log.push(`count:${label}`);
      return count;
    },
    first: () => fakeLocator(1, log, `${label}.first`),
    click: async () => {
      log.push(`click:${label}`);
    },
    fill: async (value) => {
      log.push(`fill:${label}:${value}`);
    },
    selectOption: async (value) => {
      log.push(`select:${label}:${value}`);
    },
    hover: async () => {
      log.push(`hover:${label}`);
    },
    and: (other) => {
      void other;
      log.push(`and:${label}`);
      return self;
    },
  };
  return self;
}

/** Locator whose count() rejects (invalid selector / page race). */
function throwingCountLocator(log: string[], label = 'boom'): ReplayLocator {
  return {
    ...fakeLocator(0, log, label),
    count: async () => {
      log.push(`count:${label}`);
      throw new Error('bad selector');
    },
  };
}

/**
 * Fake page: locators are looked up by a normalized query key so tests can
 * assert exactly which selector strings the replayer produced. Unknown keys
 * yield a never-matching locator.
 */
function fakePage(locators: Record<string, ReplayLocator>, log: string[]): ReplayPageActions {
  const lookup = (key: string): ReplayLocator => {
    log.push(key);
    return locators[key] ?? fakeLocator(0, log, `missing(${key})`);
  };
  return {
    goto: async (url, options) => {
      log.push(`goto:${url}:${options?.waitUntil ?? ''}:${options?.timeout ?? ''}`);
    },
    locator: (selector) => lookup(`locator:${selector}`),
    getByRole: (role, options) =>
      lookup(`role:${role}:${options?.name ?? ''}:${options?.exact ?? false}`),
    getByText: (text, options) => lookup(`text:${text}:${options?.exact ?? false}`),
    getByTestId: (testId) => lookup(`testid:${testId}`),
    keyboard: {
      press: async (key) => {
        log.push(`press:${key}`);
      },
    },
    evaluate: async (script) => {
      log.push(`evaluate:${script}`);
      return undefined;
    },
    url: () => 'https://example.test/',
  };
}

function action(partial: Partial<ActionV2> & { type: ActionV2['type'] }): ActionV2 {
  return { step: 1, timestamp: '2026-01-01T00:00:00.000Z', redacted: false, ...partial };
}

const FAST = { perCandidateTimeoutMs: 5 };

// ---------------------------------------------------------------------------
// resolveTarget
// ---------------------------------------------------------------------------

describe('resolveTarget', () => {
  it('tries candidates in order and returns the first that matches', async () => {
    const log: string[] = [];
    const page = fakePage(
      {
        'locator:[data-testid="save"]': fakeLocator(0, log, 'testid'),
        'locator:#save-btn': fakeLocator(1, log, 'id'),
      },
      log,
    );
    const candidates: TargetCandidate[] = [
      { strategy: 'testid', attribute: 'data-testid', value: 'save' },
      { strategy: 'id', value: 'save-btn' },
    ];

    const resolved = await resolveTarget(page, candidates, 5);

    expect(resolved.strategyUsed).toBe('id');
    expect(resolved.locator).not.toBeNull();
    expect(resolved.detail).toBeUndefined();
    // testid selector was attempted before the id selector.
    expect(log.indexOf('locator:[data-testid="save"]')).toBeLessThan(log.indexOf('locator:#save-btn'));
  });

  it('stops at the first matching candidate without querying later ones', async () => {
    const log: string[] = [];
    const page = fakePage({ 'locator:[data-testid="save"]': fakeLocator(1, log, 'testid') }, log);
    const candidates: TargetCandidate[] = [
      { strategy: 'testid', attribute: 'data-testid', value: 'save' },
      { strategy: 'css', value: '.later' },
    ];

    const resolved = await resolveTarget(page, candidates, 5);

    expect(resolved.strategyUsed).toBe('testid');
    expect(log).not.toContain('locator:.later');
  });

  it('returns first() with detail ambiguous when several elements match', async () => {
    const log: string[] = [];
    const page = fakePage({ 'locator:.dup': fakeLocator(3, log, 'dup') }, log);

    const resolved = await resolveTarget(page, [{ strategy: 'css', value: '.dup' }], 5);

    expect(resolved.detail).toBe('ambiguous');
    expect(resolved.strategyUsed).toBe('css');
    await resolved.locator!.click();
    expect(log).toContain('click:dup.first');
  });

  it('returns locator null when no candidate matches, without throwing', async () => {
    const page = fakePage({}, []);
    const candidates: TargetCandidate[] = [
      { strategy: 'css', value: '.a' },
      { strategy: 'nth-path', value: 'div > p:nth-child(2)' },
    ];

    const resolved = await resolveTarget(page, candidates, 5);

    expect(resolved).toEqual({ locator: null, detail: 'no-candidate-resolved' });
  });

  it('returns no-candidates for an empty candidate list', async () => {
    const resolved = await resolveTarget(fakePage({}, []), [], 5);
    expect(resolved).toEqual({ locator: null, detail: 'no-candidates' });
  });

  it('skips a candidate whose count() throws and tries the next one', async () => {
    const log: string[] = [];
    const page = fakePage(
      {
        'locator:!!!': throwingCountLocator(log),
        'locator:#ok': fakeLocator(1, log, 'ok'),
      },
      log,
    );
    const candidates: TargetCandidate[] = [
      { strategy: 'css', value: '!!!' },
      { strategy: 'id', value: 'ok' },
    ];

    const resolved = await resolveTarget(page, candidates, 5);

    expect(resolved.strategyUsed).toBe('id');
  });

  it('escapes double quotes in testid attribute values', async () => {
    const log: string[] = [];
    const key = 'locator:[data-testid="a\\"b"]';
    const page = fakePage({ [key]: fakeLocator(1, log, 't') }, log);

    const resolved = await resolveTarget(
      page,
      [{ strategy: 'testid', attribute: 'data-testid', value: 'a"b' }],
      5,
    );

    expect(resolved.strategyUsed).toBe('testid');
    expect(log).toContain(key);
  });

  it('rejects hostile testid attribute names instead of building a selector', async () => {
    const log: string[] = [];
    const page = fakePage({}, log);

    const resolved = await resolveTarget(
      page,
      [{ strategy: 'testid', attribute: 'x]"><script', value: 'v' }],
      5,
    );

    expect(resolved.locator).toBeNull();
    expect(log.filter((entry) => entry.startsWith('locator:'))).toEqual([]);
  });

  it('CSS-escapes ids (colons, leading digits)', async () => {
    const log: string[] = [];
    const page = fakePage(
      {
        'locator:#foo\\:bar': fakeLocator(1, log, 'colon'),
        'locator:#\\31 a': fakeLocator(1, log, 'digit'),
      },
      log,
    );

    const colon = await resolveTarget(page, [{ strategy: 'id', value: 'foo:bar' }], 5);
    const digit = await resolveTarget(page, [{ strategy: 'id', value: '1a' }], 5);

    expect(colon.strategyUsed).toBe('id');
    expect(digit.strategyUsed).toBe('id');
  });

  it('resolves role candidates via getByRole with exact defaulting to false', async () => {
    const log: string[] = [];
    const page = fakePage({ 'role:button:Save:false': fakeLocator(1, log, 'role') }, log);

    const resolved = await resolveTarget(
      page,
      [{ strategy: 'role', role: 'button', name: 'Save' }],
      5,
    );

    expect(resolved.strategyUsed).toBe('role');
  });

  it('resolves text candidates exactly and intersects with the tag via and()', async () => {
    const log: string[] = [];
    const page = fakePage({ 'text:Save:true': fakeLocator(1, log, 'text') }, log);

    const resolved = await resolveTarget(
      page,
      [{ strategy: 'text', value: 'Save', tag: 'button' }],
      5,
    );

    expect(resolved.strategyUsed).toBe('text');
    expect(log).toContain('and:text');
    expect(log).toContain('locator:button');
  });

  it('resolves text candidates on locators without and() by skipping the tag filter', async () => {
    const log: string[] = [];
    const noAnd = fakeLocator(1, log, 'text');
    delete (noAnd as { and?: unknown }).and;
    const page = fakePage({ 'text:Save:true': noAnd }, log);

    const resolved = await resolveTarget(
      page,
      [{ strategy: 'text', value: 'Save', tag: 'button' }],
      5,
    );

    expect(resolved.strategyUsed).toBe('text');
  });
});

// ---------------------------------------------------------------------------
// executeAction
// ---------------------------------------------------------------------------

describe('executeAction', () => {
  it('navigates with domcontentloaded and the navigation timeout', async () => {
    const log: string[] = [];
    const page = fakePage({}, log);

    const outcome = await executeAction(page, action({ type: 'navigate', url: 'https://a.test/' }), {
      navigationTimeoutMs: 1234,
    });

    expect(outcome).toEqual({ outcome: 'executed' });
    expect(log).toContain('goto:https://a.test/:domcontentloaded:1234');
  });

  it('skips a navigate without url', async () => {
    const outcome = await executeAction(fakePage({}, []), action({ type: 'navigate' }));
    expect(outcome).toEqual({ outcome: 'skipped', detail: 'missing-url' });
  });

  it('clicks through the resolved candidate and reports resolvedBy', async () => {
    const log: string[] = [];
    const page = fakePage({ 'locator:#btn': fakeLocator(1, log, 'btn') }, log);

    const outcome = await executeAction(
      page,
      action({ type: 'click', target: { candidates: [{ strategy: 'css', value: '#btn' }] } }),
      FAST,
    );

    expect(outcome).toEqual({ outcome: 'executed', resolvedBy: 'css' });
    expect(log).toContain('click:btn');
  });

  it('falls back to the legacy v1 selector when target is missing', async () => {
    const log: string[] = [];
    const page = fakePage({ 'locator:#legacy': fakeLocator(1, log, 'legacy') }, log);

    const outcome = await executeAction(page, action({ type: 'click', selector: '#legacy' }), FAST);

    expect(outcome).toEqual({ outcome: 'executed', resolvedBy: 'css' });
    expect(log).toContain('click:legacy');
  });

  it('skips a click with neither target nor selector', async () => {
    const outcome = await executeAction(fakePage({}, []), action({ type: 'click' }), FAST);
    expect(outcome).toEqual({ outcome: 'skipped', detail: 'no-target' });
  });

  it('fails with target-not-resolved when no candidate matches (does not throw)', async () => {
    const outcome = await executeAction(
      fakePage({}, []),
      action({ type: 'click', target: { candidates: [{ strategy: 'css', value: '#gone' }] } }),
      FAST,
    );
    expect(outcome).toEqual({ outcome: 'failed', detail: 'target-not-resolved' });
  });

  it('NEVER re-types redacted fills (credentials come from storage state)', async () => {
    const log: string[] = [];
    const page = fakePage({ 'locator:#pw': fakeLocator(1, log, 'pw') }, log);

    const outcome = await executeAction(
      page,
      action({
        type: 'fill',
        redacted: true,
        value: REDACTED_VALUE,
        target: { candidates: [{ strategy: 'css', value: '#pw' }] },
      }),
      FAST,
    );

    expect(outcome).toEqual({ outcome: 'skipped', detail: 'redacted-credential' });
    expect(log).toEqual([]); // the target is never even resolved
  });

  it('skips fills carrying the REDACTED_VALUE placeholder even if redacted is false', async () => {
    const outcome = await executeAction(
      fakePage({}, []),
      action({ type: 'fill', value: REDACTED_VALUE, selector: '#pw' }),
      FAST,
    );
    expect(outcome).toEqual({ outcome: 'skipped', detail: 'redacted-credential' });
  });

  it('fills plain values through the resolved locator', async () => {
    const log: string[] = [];
    const page = fakePage({ 'locator:#name': fakeLocator(1, log, 'name') }, log);

    const outcome = await executeAction(
      page,
      action({ type: 'fill', value: 'hello', selector: '#name' }),
      FAST,
    );

    expect(outcome).toEqual({ outcome: 'executed', resolvedBy: 'css' });
    expect(log).toContain('fill:name:hello');
  });

  it('fills an empty string when the recorded value is missing', async () => {
    const log: string[] = [];
    const page = fakePage({ 'locator:#name': fakeLocator(1, log, 'name') }, log);

    await executeAction(page, action({ type: 'fill', selector: '#name' }), FAST);

    expect(log).toContain('fill:name:');
  });

  it('selects the recorded option and skips selects without a value', async () => {
    const log: string[] = [];
    const page = fakePage({ 'locator:#country': fakeLocator(1, log, 'country') }, log);

    const executed = await executeAction(
      page,
      action({ type: 'select', value: 'FR', selector: '#country' }),
      FAST,
    );
    const skipped = await executeAction(page, action({ type: 'select', selector: '#country' }), FAST);

    expect(executed).toEqual({ outcome: 'executed', resolvedBy: 'css' });
    expect(log).toContain('select:country:FR');
    expect(skipped).toEqual({ outcome: 'skipped', detail: 'missing-value' });
  });

  it('presses keys and skips key actions without a value', async () => {
    const log: string[] = [];
    const page = fakePage({}, log);

    const executed = await executeAction(page, action({ type: 'key', value: 'Enter' }));
    const skipped = await executeAction(page, action({ type: 'key' }));

    expect(executed).toEqual({ outcome: 'executed' });
    expect(log).toContain('press:Enter');
    expect(skipped).toEqual({ outcome: 'skipped', detail: 'missing-value' });
  });

  it('scrolls via page.evaluate', async () => {
    const log: string[] = [];
    const outcome = await executeAction(fakePage({}, log), action({ type: 'scroll' }));

    expect(outcome).toEqual({ outcome: 'executed' });
    expect(log.some((entry) => entry.startsWith('evaluate:') && entry.includes('scrollBy'))).toBe(true);
  });

  it('hovers the resolved locator', async () => {
    const log: string[] = [];
    const page = fakePage({ 'locator:#menu': fakeLocator(1, log, 'menu') }, log);

    const outcome = await executeAction(page, action({ type: 'hover', selector: '#menu' }), FAST);

    expect(outcome).toEqual({ outcome: 'executed', resolvedBy: 'css' });
    expect(log).toContain('hover:menu');
  });

  it('reports interaction errors as failed with the error message', async () => {
    const log: string[] = [];
    const broken: ReplayLocator = {
      ...fakeLocator(1, log, 'broken'),
      click: async () => {
        throw new Error('element detached');
      },
    };
    const page = fakePage({ 'locator:#flaky': broken }, log);

    const outcome = await executeAction(page, action({ type: 'click', selector: '#flaky' }), FAST);

    expect(outcome.outcome).toBe('failed');
    expect(outcome.detail).toContain('element detached');
  });

  it('passes the ambiguous detail through on multi-match targets', async () => {
    const log: string[] = [];
    const page = fakePage({ 'locator:.rows': fakeLocator(4, log, 'rows') }, log);

    const outcome = await executeAction(page, action({ type: 'click', selector: '.rows' }), FAST);

    expect(outcome).toEqual({ outcome: 'executed', resolvedBy: 'css', detail: 'ambiguous' });
    expect(log).toContain('click:rows.first');
  });
});

// ---------------------------------------------------------------------------
// settle
// ---------------------------------------------------------------------------

const TINY_DELAYS = { delaysMs: { navigate: 1, click: 1, form: 1, default: 1 } };

function settlePage(log: string[], failLoadState = false): ReplayPageActions {
  return {
    ...fakePage({}, log),
    waitForLoadState: async (state, options) => {
      log.push(`wls:${state ?? 'load'}:${options?.timeout ?? ''}`);
      if (failLoadState) throw new Error('load state timeout');
    },
  };
}

describe('settle', () => {
  it("waits for a bounded page 'load' after navigate (never networkidle)", async () => {
    const log: string[] = [];
    await settle(settlePage(log), action({ type: 'navigate', url: 'https://a.test/' }), TINY_DELAYS);

    // Default ceiling 3s; 'load' is used, never the hang-prone 'networkidle'.
    expect(log).toContain('wls:load:3000');
    expect(log.some((entry) => entry.startsWith('wls:networkidle'))).toBe(false);
    expect(log.some((entry) => entry.startsWith('wls:domcontentloaded'))).toBe(false);
  });

  it('honours loadWaitMs and caps it at 15s', async () => {
    const short: string[] = [];
    await settle(settlePage(short), action({ type: 'click' }), { ...TINY_DELAYS, loadWaitMs: 1000 });
    expect(short).toContain('wls:load:1000');

    const capped: string[] = [];
    await settle(settlePage(capped), action({ type: 'click' }), {
      ...TINY_DELAYS,
      loadWaitMs: 60_000,
    });
    expect(capped).toContain('wls:load:15000');

    // Legacy alias still works.
    const alias: string[] = [];
    await settle(settlePage(alias), action({ type: 'click' }), {
      ...TINY_DELAYS,
      networkIdleTimeoutMs: 2000,
    });
    expect(alias).toContain('wls:load:2000');
  });

  it('does not wait for page load after form actions', async () => {
    const log: string[] = [];
    await settle(settlePage(log), action({ type: 'fill', value: 'x' }), TINY_DELAYS);
    await settle(settlePage(log), action({ type: 'key', value: 'Tab' }), TINY_DELAYS);

    expect(log.filter((entry) => entry.startsWith('wls:'))).toEqual([]);
  });

  it('swallows every load-state failure', async () => {
    const log: string[] = [];
    await expect(
      settle(settlePage(log, true), action({ type: 'navigate', url: 'https://a.test/' }), TINY_DELAYS),
    ).resolves.toBeUndefined();
  });

  it('works on pages without waitForLoadState', async () => {
    await expect(
      settle(fakePage({}, []), action({ type: 'click' }), TINY_DELAYS),
    ).resolves.toBeUndefined();
  });
});
