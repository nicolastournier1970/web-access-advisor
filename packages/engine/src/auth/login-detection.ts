/**
 * Pure URL/flow classification helpers. All configuration is passed in (see
 * domain-config.ts) so these functions stay deterministic and unit-testable.
 *
 * Ported from the legacy engine's authDetection.ts / analyzer.determineFlowType
 * with two deliberate fixes:
 *  - path matching is segment-aware ('/login' no longer matches '/blogin');
 *  - a URL on the session's own host is always 'main_app', never
 *    'external_redirect' (the legacy code returned external_redirect for any
 *    host missing from its hardcoded list, including the app under test).
 */
import type { AuthDomainsConfig, FlowType } from '@waa/shared';

/** Parses a URL string; returns null instead of throwing on malformed input. */
function safeParseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** Lowercased, non-empty path segments of a pathname. */
function pathSegments(pathname: string): string[] {
  return pathname
    .toLowerCase()
    .split('/')
    .filter((segment) => segment.length > 0);
}

/**
 * True when `patternSegs` appears as a contiguous run of whole segments inside
 * `pathSegs` — '/login' matches '/login' and '/account/login' but not
 * '/blogin' or '/loginpage'.
 */
function containsSegmentRun(pathSegs: string[], patternSegs: string[]): boolean {
  if (patternSegs.length === 0 || patternSegs.length > pathSegs.length) return false;
  for (let start = 0; start + patternSegs.length <= pathSegs.length; start++) {
    let matched = true;
    for (let i = 0; i < patternSegs.length; i++) {
      if (pathSegs[start + i] !== patternSegs[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

/** Segment-aware, case-insensitive test of a path pattern list. */
function pathMatchesAnyPattern(pathname: string, patterns: readonly string[]): boolean {
  const segs = pathSegments(pathname);
  if (segs.length === 0) return false;
  return patterns.some((pattern) => containsSegmentRun(segs, pathSegments(pattern)));
}

/** Case-insensitive substring match of an auth-domain pattern on a hostname. */
function hostMatchesAuthDomain(hostname: string, domains: readonly string[]): boolean {
  return domains.some((domain) => {
    const needle = domain.trim().toLowerCase();
    return needle.length > 0 && hostname.includes(needle);
  });
}

/**
 * Client-domain match: exact hostname or a subdomain of it, www-insensitive.
 * Deliberately stricter than the substring match used for auth domains so a
 * client domain like 'app.com' cannot accidentally claim 'evilapp.com'.
 */
function hostMatchesClientDomain(hostname: string, domains: readonly string[]): boolean {
  const host = stripWww(hostname);
  return domains.some((domain) => {
    const target = stripWww(domain.trim().toLowerCase());
    return target.length > 0 && (host === target || host.endsWith(`.${target}`));
  });
}

function stripWww(hostname: string): string {
  return hostname.replace(/^www\./, '');
}

/**
 * Second-level labels that commonly sit directly under a two-letter ccTLD
 * (gov.au, co.uk, com.br, …). A pragmatic stand-in for the public-suffix list
 * so registrable-domain comparison works for the gov.au hosts this tool is
 * used against.
 */
const MULTI_PART_TLD_SLDS = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'mil', 'govt']);

/**
 * Approximate registrable (base) domain of a hostname: last two labels, or
 * last three when the TLD is a two-letter country code preceded by a common
 * public second-level label (e.g. 'sts.development.health.gov.au' →
 * 'health.gov.au'). IP literals and single-label hosts are returned verbatim.
 */
function registrableBase(hostname: string): string {
  const host = stripWww(hostname.toLowerCase());
  if (host.includes(':') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host;
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const tld = labels[labels.length - 1] ?? '';
  const sld = labels[labels.length - 2] ?? '';
  const take = tld.length === 2 && MULTI_PART_TLD_SLDS.has(sld) ? 3 : 2;
  return labels.slice(-take).join('.');
}

/** Same-site test: identical host (www-insensitive) or shared base domain. */
function isSameSite(hostA: string, hostB: string): boolean {
  const a = stripWww(hostA.toLowerCase());
  const b = stripWww(hostB.toLowerCase());
  if (a.length === 0 || b.length === 0) return false;
  return a === b || registrableBase(a) === registrableBase(b);
}

/** Path segments that mark a page as an error page rather than app content. */
const ERROR_PATH_PATTERNS = ['/error', '/404', '/500'] as const;

/**
 * True when the URL looks authentication-related: its hostname contains any
 * configured identity-provider domain (case-insensitive substring), or its
 * pathname contains any configured auth path pattern as whole segments.
 * Malformed URL strings return false (never throws).
 */
export function isAuthUrl(url: string, cfg: AuthDomainsConfig): boolean {
  const parsed = safeParseUrl(url);
  if (!parsed) return false;
  if (hostMatchesAuthDomain(parsed.hostname.toLowerCase(), cfg.authDomains)) return true;
  return pathMatchesAnyPattern(parsed.pathname, cfg.authPathPatterns);
}

/**
 * Classifies a navigated URL relative to the recording session's start URL.
 *
 * Precedence: auth_flow (isAuthUrl) → error_flow (/error, /404, /500 as whole
 * path segments — error pages are excluded from analysis even on the client's
 * own domain, matching legacy behaviour) → main_app (configured clientDomains
 * OR same site as `sessionUrl`, www-insensitive with registrable-base-domain
 * comparison) → external_redirect for genuinely different hosts only.
 *
 * A malformed `url` returns 'external_redirect'; a malformed `sessionUrl`
 * merely disables the same-site fallback.
 */
export function classifyFlowType(url: string, sessionUrl: string, cfg: AuthDomainsConfig): FlowType {
  const parsed = safeParseUrl(url);
  if (!parsed) return 'external_redirect';

  if (isAuthUrl(url, cfg)) return 'auth_flow';
  if (pathMatchesAnyPattern(parsed.pathname, ERROR_PATH_PATTERNS)) return 'error_flow';

  const host = parsed.hostname.toLowerCase();
  if (hostMatchesClientDomain(host, cfg.clientDomains)) return 'main_app';

  const session = safeParseUrl(sessionUrl);
  if (session && isSameSite(host, session.hostname)) return 'main_app';

  return 'external_redirect';
}

/** Signals gathered by the replayer before deciding whether replay hit a login wall. */
export interface LoginWallSignals {
  /** Current page URL after the action/navigation settled. */
  url: string;
  /** Whether a visible password input exists on the page. */
  hasPasswordField: boolean;
  /**
   * Whether the replayed action's target failed to resolve. `false` means the
   * target resolved fine (a password field is then just page furniture, e.g. a
   * login box in a site header); `undefined` means unknown and is treated as
   * corroborating evidence.
   */
  targetResolutionFailed?: boolean;
}

/** Outcome of {@link detectLoginWall}; `reason` is set only when a wall is detected. */
export interface LoginWallResult {
  isLoginWall: boolean;
  reason?: 'auth-domain-navigation' | 'login-wall-detected';
}

/**
 * Decides whether the replay has been intercepted by a login wall. Navigation
 * to an auth URL is conclusive on its own ('auth-domain-navigation'); a
 * password field only counts ('login-wall-detected') when target resolution
 * did not explicitly succeed — a resolvable target means the expected page is
 * still there and the password field is incidental.
 */
export function detectLoginWall(
  signals: LoginWallSignals,
  cfg: AuthDomainsConfig,
): LoginWallResult {
  if (isAuthUrl(signals.url, cfg)) {
    return { isLoginWall: true, reason: 'auth-domain-navigation' };
  }
  if (signals.hasPasswordField && signals.targetResolutionFailed !== false) {
    return { isLoginWall: true, reason: 'login-wall-detected' };
  }
  return { isLoginWall: false };
}
