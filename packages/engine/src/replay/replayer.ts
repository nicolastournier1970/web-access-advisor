/**
 * Action replay against a live page — rewrite of the legacy `executeAction` /
 * `waitForActionSettlement` (packages/core/src/analyzer.ts).
 *
 * Deliberate behavioural changes vs. legacy:
 *  - Targets resolve through the ranked v2 candidate list (testid → id →
 *    role → text → css → nth-path) instead of one crude CSS selector; v1
 *    recordings fall back to a single `css` candidate built from `selector`.
 *  - Failures come back as structured outcomes ('executed' | 'skipped' |
 *    'failed') instead of being console-logged and silently swallowed — the
 *    caller decides what a failed step means for the replay.
 *  - Redacted fills are NEVER re-typed: recorded credentials only exist as
 *    the REDACTED_VALUE placeholder, and authentication is restored via the
 *    saved storageState.json, so a redacted fill is skipped by design.
 *
 * Everything is structurally typed against {@link ReplayPageActions} so unit
 * tests can drive the full logic with fake pages (no browser).
 */
import { REDACTED_VALUE, type ActionV2, type TargetCandidate } from '@waa/shared';

/** How long each locator candidate may take to produce a match (legacy: none). */
const DEFAULT_PER_CANDIDATE_TIMEOUT_MS = 2000;
/** Timeout for the resolved locator's interaction (click/fill/…), like legacy. */
const DEFAULT_ACTION_TIMEOUT_MS = 10_000;
/** Timeout for page.goto on navigate actions, like legacy. */
const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;
/**
 * Default ceiling for the post-navigate/click page-'load' wait. Replay used to
 * wait for `networkidle`, which telemetry/websocket/polling-heavy sites never
 * reach — so every navigate/click burned a full 15s. 'load' fires reliably and
 * this ceiling is a safety net, not the common cost.
 */
const DEFAULT_LOAD_WAIT_MS = 3000;
/** Hard cap on the configurable load wait. */
const LOAD_WAIT_MAX_MS = 15_000;
/** Default fixed "let the DOM/handlers react" pauses per action type (ms). */
const DEFAULT_SETTLE_DELAYS = { navigate: 500, click: 350, form: 250, default: 150 } as const;
/** Re-check interval while waiting for a candidate to match. */
const POLL_INTERVAL_MS = 100;

/**
 * Structural slice of a Playwright Locator used by the replayer. A real
 * `Locator` satisfies this; fakes only need the methods a test exercises.
 * `and` is optional so minimal fakes can omit it (text candidates then skip
 * their tag filter instead of failing).
 */
export interface ReplayLocator {
  count(): Promise<number>;
  first(): ReplayLocator;
  click(options?: { timeout?: number }): Promise<void>;
  fill(value: string, options?: { timeout?: number }): Promise<void>;
  selectOption(value: string, options?: { timeout?: number }): Promise<unknown>;
  hover(options?: { timeout?: number }): Promise<void>;
  /** Locator intersection (Playwright `Locator.and`). */
  and?(other: ReplayLocator): ReplayLocator;
}

/**
 * Structural slice of a Playwright Page used by the replayer. A real `Page`
 * satisfies it. `evaluate` takes a SCRIPT STRING (not a function) because
 * this package compiles without DOM lib types; Playwright evaluates the
 * string in page context. `waitForLoadState` is optional so fakes without
 * load-state semantics still work — settle() treats its absence as "settled".
 */
export interface ReplayPageActions {
  goto(
    url: string,
    options?: { timeout?: number; waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit' },
  ): Promise<unknown>;
  locator(selector: string): ReplayLocator;
  getByRole(role: string, options?: { name?: string; exact?: boolean }): ReplayLocator;
  getByText(text: string, options?: { exact?: boolean }): ReplayLocator;
  getByTestId(testId: string): ReplayLocator;
  keyboard: { press(key: string): Promise<void> };
  evaluate(script: string): Promise<unknown>;
  url(): string;
  waitForLoadState?(
    state?: 'load' | 'domcontentloaded' | 'networkidle',
    options?: { timeout?: number },
  ): Promise<void>;
}

/** Result of {@link resolveTarget}; `locator: null` means nothing matched. */
export interface ResolvedTarget {
  locator: ReplayLocator | null;
  /** Strategy of the winning candidate; unset when nothing resolved. */
  strategyUsed?: TargetCandidate['strategy'];
  /** 'ambiguous' (multi-match, .first() used), 'no-candidates', 'no-candidate-resolved'. */
  detail?: string;
}

/** Structured outcome of one replayed action (replaces legacy silent catch). */
export interface ActionOutcome {
  outcome: 'executed' | 'skipped' | 'failed';
  /** Machine-readable reason ('redacted-credential', 'target-not-resolved', …) or error text. */
  detail?: string;
  /** Candidate strategy that located the element, for target-based actions. */
  resolvedBy?: TargetCandidate['strategy'];
}

/** Tunables for {@link executeAction}; every field has a legacy-equivalent default. */
export interface ExecuteActionOptions {
  /** Budget per locator candidate before the next one is tried (default 2000). */
  perCandidateTimeoutMs?: number;
  /** Timeout for the element interaction itself (default 10000). */
  actionTimeoutMs?: number;
  /** Timeout for page.goto (default 30000). */
  navigationTimeoutMs?: number;
}

/** Tunables for {@link settle}; tests inject tiny delays. */
export interface SettleOptions {
  /**
   * Ceiling for the post-navigate/click page-'load' wait (default 3000, capped
   * at 15000). The main replay-speed lever — lower for snappy sites, raise for
   * heavy SPAs.
   */
  loadWaitMs?: number;
  /** Multiplier on the default fixed per-action pauses (default 1). Ignored per-key when delaysMs sets that key. */
  pauseScale?: number;
  /** Override the fixed per-action-type waits (ms). */
  delaysMs?: Partial<Record<'navigate' | 'click' | 'form' | 'default', number>>;
  /** @deprecated back-compat alias for {@link loadWaitMs}. */
  networkIdleTimeoutMs?: number;
}

/**
 * Try `candidates` strictly in array order (the recorder emits them in
 * preference order: testid → id → role → text → css → nth-path) and return
 * the first that matches at least one element within its per-candidate
 * budget. Exactly one match wins cleanly; multiple matches win as `.first()`
 * with `detail: 'ambiguous'`. Candidates that error (invalid selector,
 * navigation race) are skipped. NEVER throws — `locator: null` is the only
 * failure signal.
 */
export async function resolveTarget(
  page: ReplayPageActions,
  candidates: TargetCandidate[],
  perCandidateTimeoutMs: number = DEFAULT_PER_CANDIDATE_TIMEOUT_MS,
): Promise<ResolvedTarget> {
  if (candidates.length === 0) {
    return { locator: null, detail: 'no-candidates' };
  }
  for (const candidate of candidates) {
    try {
      const locator = buildCandidateLocator(page, candidate);
      if (!locator) continue;
      const count = await countWithin(locator, perCandidateTimeoutMs);
      if (count === 1) {
        return { locator, strategyUsed: candidate.strategy };
      }
      if (count > 1) {
        return { locator: locator.first(), strategyUsed: candidate.strategy, detail: 'ambiguous' };
      }
    } catch {
      // Bad selector or the page changed underneath us — try the next candidate.
    }
  }
  return { locator: null, detail: 'no-candidate-resolved' };
}

/**
 * Replay one recorded action. Never throws: every path yields a structured
 * {@link ActionOutcome} and the caller decides whether a 'failed' step aborts
 * the replay. Notable semantics:
 *  - `fill` with `redacted` (or the literal REDACTED_VALUE) → 'skipped'
 *    ('redacted-credential'): credentials are never re-typed, saved storage
 *    state carries the authentication instead;
 *  - missing `target` falls back to a single css candidate from the legacy
 *    v1 `selector`; nothing to resolve at all → 'skipped' ('no-target');
 *  - a target that no candidate can locate → 'failed' ('target-not-resolved').
 */
export async function executeAction(
  page: ReplayPageActions,
  action: ActionV2,
  opts: ExecuteActionOptions = {},
): Promise<ActionOutcome> {
  const actionTimeoutMs = opts.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
  const navigationTimeoutMs = opts.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS;
  try {
    switch (action.type) {
      case 'navigate': {
        if (!action.url) return { outcome: 'skipped', detail: 'missing-url' };
        await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs });
        return { outcome: 'executed' };
      }
      case 'click':
        return await withResolvedTarget(page, action, opts, (locator) =>
          locator.click({ timeout: actionTimeoutMs }),
        );
      case 'fill': {
        if (action.redacted || action.value === REDACTED_VALUE) {
          return { outcome: 'skipped', detail: 'redacted-credential' };
        }
        const value = action.value ?? '';
        return await withResolvedTarget(page, action, opts, (locator) =>
          locator.fill(value, { timeout: actionTimeoutMs }),
        );
      }
      case 'select': {
        const value = action.value;
        if (value === undefined) return { outcome: 'skipped', detail: 'missing-value' };
        return await withResolvedTarget(page, action, opts, (locator) =>
          locator.selectOption(value, { timeout: actionTimeoutMs }),
        );
      }
      case 'hover':
        return await withResolvedTarget(page, action, opts, (locator) =>
          locator.hover({ timeout: actionTimeoutMs }),
        );
      case 'key': {
        if (!action.value) return { outcome: 'skipped', detail: 'missing-value' };
        await page.keyboard.press(action.value);
        return { outcome: 'executed' };
      }
      case 'scroll':
        await page.evaluate('window.scrollBy(0, 300)');
        return { outcome: 'executed' };
    }
    // Unreachable with schema-valid input; guards non-validated callers.
    return { outcome: 'skipped', detail: 'unknown-action-type' };
  } catch (error) {
    return { outcome: 'failed', detail: describeError(error) };
  }
}

/**
 * Give the page time to react before state capture (port of the legacy
 * `waitForActionSettlement`): a fixed wait sized by action type (navigate
 * 1500 + domcontentloaded, click 1000, fill/select 750, others 500), then —
 * for navigate/click only — a page-'load' wait bounded at `loadWaitMs`
 * (default 3s). Best-effort by contract: every failure (including a page
 * without waitForLoadState) is swallowed and capture proceeds.
 */
export async function settle(
  page: ReplayPageActions,
  action: ActionV2,
  opts: SettleOptions = {},
): Promise<void> {
  const scale = opts.pauseScale ?? 1;
  const delays = {
    navigate: Math.round(DEFAULT_SETTLE_DELAYS.navigate * scale),
    click: Math.round(DEFAULT_SETTLE_DELAYS.click * scale),
    form: Math.round(DEFAULT_SETTLE_DELAYS.form * scale),
    default: Math.round(DEFAULT_SETTLE_DELAYS.default * scale),
    ...opts.delaysMs,
  };
  try {
    switch (action.type) {
      case 'navigate':
        await sleep(delays.navigate);
        break;
      case 'click':
        await sleep(delays.click);
        break;
      case 'fill':
      case 'select':
        await sleep(delays.form);
        break;
      default:
        await sleep(delays.default);
    }
    if (action.type === 'navigate' || action.type === 'click') {
      const bound = Math.min(
        opts.loadWaitMs ?? opts.networkIdleTimeoutMs ?? DEFAULT_LOAD_WAIT_MS,
        LOAD_WAIT_MAX_MS,
      );
      try {
        await page.waitForLoadState?.('load', { timeout: bound });
      } catch {
        // Slow (or never-loading) pages: capture what we have rather than hang.
      }
    }
  } catch {
    // Settlement is best-effort; the snapshot is captured regardless.
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Candidates for an action: v2 target list, else legacy v1 css fallback. */
function candidatesFor(action: ActionV2): TargetCandidate[] {
  if (action.target && action.target.candidates.length > 0) {
    return action.target.candidates;
  }
  if (action.selector) {
    return [{ strategy: 'css', value: action.selector }];
  }
  return [];
}

/** Resolve the action's target, then run `operate` on the winning locator. */
async function withResolvedTarget(
  page: ReplayPageActions,
  action: ActionV2,
  opts: ExecuteActionOptions,
  operate: (locator: ReplayLocator) => Promise<unknown>,
): Promise<ActionOutcome> {
  const candidates = candidatesFor(action);
  if (candidates.length === 0) {
    return { outcome: 'skipped', detail: 'no-target' };
  }
  const resolved = await resolveTarget(
    page,
    candidates,
    opts.perCandidateTimeoutMs ?? DEFAULT_PER_CANDIDATE_TIMEOUT_MS,
  );
  if (!resolved.locator) {
    return { outcome: 'failed', detail: 'target-not-resolved' };
  }
  await operate(resolved.locator);
  const outcome: ActionOutcome = { outcome: 'executed' };
  if (resolved.strategyUsed !== undefined) outcome.resolvedBy = resolved.strategyUsed;
  if (resolved.detail !== undefined) outcome.detail = resolved.detail;
  return outcome;
}

/** Map one candidate onto a locator; null skips candidates we refuse to build. */
function buildCandidateLocator(
  page: ReplayPageActions,
  candidate: TargetCandidate,
): ReplayLocator | null {
  switch (candidate.strategy) {
    case 'testid': {
      // Attribute names are recorder-controlled but validate anyway: a hostile
      // name would otherwise break out of the attribute selector.
      if (!/^[A-Za-z_][\w-]*$/.test(candidate.attribute)) return null;
      return page.locator(`[${candidate.attribute}="${escapeAttributeValue(candidate.value)}"]`);
    }
    case 'id':
      return page.locator(`#${cssEscape(candidate.value)}`);
    case 'role':
      return page.getByRole(candidate.role, {
        name: candidate.name,
        exact: candidate.exact ?? false,
      });
    case 'text': {
      const base = page.getByText(candidate.value, { exact: true });
      if (candidate.tag && typeof base.and === 'function') {
        return base.and(page.locator(candidate.tag));
      }
      return base;
    }
    case 'css':
    case 'nth-path':
      return page.locator(candidate.value);
  }
}

/**
 * Poll `locator.count()` until it is > 0 or `timeoutMs` elapses. Each count()
 * call is itself raced against the remaining budget so a hung page cannot
 * stall candidate resolution forever. Always makes at least one attempt, so
 * an instantly-matching candidate wins even with a zero budget.
 */
async function countWithin(locator: ReplayLocator, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    const remaining = Math.max(deadline - Date.now(), 1);
    const count = await raceWithTimeout(locator.count(), remaining);
    if (count !== null && count > 0) return count;
    if (count === null || Date.now() + POLL_INTERVAL_MS > deadline) return 0;
    await sleep(POLL_INTERVAL_MS);
  }
}

/** Resolve to null (instead of rejecting/hanging) when `ms` elapses first. */
async function raceWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Escape a string for use inside a double-quoted CSS attribute value. */
function escapeAttributeValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Port of the standard CSS.escape polyfill (Node has no global CSS): makes an
 * arbitrary recorded id safe inside `#…` selectors (leading digits, spaces,
 * colons, unicode…).
 */
function cssEscape(value: string): string {
  let result = '';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x0000) {
      result += '�';
    } else if (
      (code >= 0x0001 && code <= 0x001f) ||
      code === 0x007f ||
      (i === 0 && code >= 0x0030 && code <= 0x0039) ||
      (i === 1 && code >= 0x0030 && code <= 0x0039 && value.charCodeAt(0) === 0x002d)
    ) {
      result += `\\${code.toString(16)} `;
    } else if (i === 0 && value.length === 1 && code === 0x002d) {
      result += `\\${value.charAt(i)}`;
    } else if (
      code >= 0x0080 ||
      code === 0x002d ||
      code === 0x005f ||
      (code >= 0x0030 && code <= 0x0039) ||
      (code >= 0x0041 && code <= 0x005a) ||
      (code >= 0x0061 && code <= 0x007a)
    ) {
      result += value.charAt(i);
    } else {
      result += `\\${value.charAt(i)}`;
    }
  }
  return result;
}

/** Compact error text for ActionOutcome.detail (bounded, never throws). */
function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 300 ? `${message.slice(0, 297)}...` : message;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
