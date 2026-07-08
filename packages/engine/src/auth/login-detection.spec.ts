import { describe, it, expect } from 'vitest';
import type { AuthDomainsConfig, FlowType } from '@waa/shared';
import { classifyFlowType, detectLoginWall, isAuthUrl } from './login-detection.js';

/** Config mirroring the repo's config/auth-domains.json merged over defaults. */
const cfg: AuthDomainsConfig = {
  authDomains: [
    'login.microsoftonline.com',
    'accounts.google.com',
    'okta.com',
    'auth0.com',
    'login.live.com',
    'auth.identity.gov.au',
    'sts.development.health.gov.au',
    'myid.gov.au',
  ],
  clientDomains: ['hbsp-test.powerappsportals.com'],
  authPathPatterns: [
    '/login',
    '/signin',
    '/sign-in',
    '/auth',
    '/oauth',
    '/sso',
    '/account/logon',
    '/unauthorized',
  ],
};

describe('isAuthUrl', () => {
  const cases: Array<[url: string, expected: boolean, why: string]> = [
    // IdP hostnames (substring, case-insensitive)
    ['https://login.microsoftonline.com/common/oauth2/v2.0/authorize', true, 'Microsoft IdP'],
    ['https://accounts.google.com/o/oauth2/v2/auth', true, 'Google IdP'],
    ['https://dev-1234.okta.com/app/sso', true, 'okta.com matches subdomained tenant'],
    ['https://AUTH.IDENTITY.GOV.AU/idp/start', true, 'gov.au IdP, uppercase host'],
    ['https://sts.development.health.gov.au/adfs/ls/', true, 'health.gov.au STS'],
    ['https://myid.gov.au/verify', true, 'myID'],
    // Path patterns (segment-aware)
    ['https://example.com/login', true, 'exact /login segment'],
    ['https://example.com/account/login', true, '/login as trailing segment'],
    ['https://example.com/login/callback', true, '/login as leading segment'],
    ['https://example.com/Sign-In', true, 'case-insensitive path'],
    ['https://example.com/account/logon', true, 'multi-segment pattern'],
    ['https://example.com/x/account/logon/y', true, 'multi-segment run mid-path'],
    ['https://hbsp-test.powerappsportals.com/Account/Logon?returnUrl=%2F', true, 'PowerApps logon'],
    ['https://example.com/unauthorized', true, 'unauthorized page'],
    // Segment-awareness negatives
    ['https://example.com/blogin', false, 'no partial-segment match'],
    ['https://example.com/loginpage', false, 'no prefix-segment match'],
    ['https://example.com/author', false, '/auth must not match /author'],
    ['https://example.com/oauthentic', false, '/oauth must not match /oauthentic'],
    ['https://example.com/account/logon-history/x', false, 'multi-segment must match whole segments'],
    // Plain pages
    ['https://hbsp-test.powerappsportals.com/dashboard', false, 'client app page'],
    ['https://example.com/', false, 'root path'],
    // Malformed input must not throw
    ['not a url at all', false, 'malformed URL'],
    ['', false, 'empty string'],
  ];

  it.each(cases)('%s -> %s (%s)', (url, expected) => {
    expect(isAuthUrl(url, cfg)).toBe(expected);
  });
});

describe('classifyFlowType', () => {
  const sessionUrl = 'https://hbsp-test.powerappsportals.com/portal/home';

  const cases: Array<[url: string, expected: FlowType, why: string]> = [
    // Auth flows win first
    ['https://auth.identity.gov.au/authorize?client_id=x', 'auth_flow', 'gov.au IdP'],
    ['https://login.microsoftonline.com/common/oauth2/authorize', 'auth_flow', 'Microsoft IdP'],
    ['https://hbsp-test.powerappsportals.com/signin', 'auth_flow', 'auth path on client domain'],
    // Error pages (excluded from analysis even on the client domain)
    ['https://somewhere.example.net/error', 'error_flow', 'error page on unknown host'],
    ['https://hbsp-test.powerappsportals.com/404', 'error_flow', '404 on client domain'],
    ['https://hbsp-test.powerappsportals.com/error/details', 'error_flow', 'error segment'],
    // Main app: configured client domain
    ['https://hbsp-test.powerappsportals.com/dashboard', 'main_app', 'client domain'],
    ['https://www.hbsp-test.powerappsportals.com/dashboard', 'main_app', 'www-insensitive client'],
    // CRITICAL FIX: unknown domain equal to the session host is main_app
    ['https://hbsp-test.powerappsportals.com/reports/42', 'main_app', 'same host as session'],
    // Genuinely different hosts
    ['https://cdn.thirdparty.net/asset.js', 'external_redirect', 'unrelated host'],
    ['https://example.com/pricing', 'external_redirect', 'different site'],
    // Malformed URL
    ['%%%not-a-url', 'external_redirect', 'malformed URL'],
  ];

  it.each(cases)('%s -> %s (%s)', (url, expected) => {
    expect(classifyFlowType(url, sessionUrl, cfg)).toBe(expected);
  });

  it('classifies same-host pages as main_app even with empty clientDomains (legacy fix)', () => {
    const bare: AuthDomainsConfig = { authDomains: [], clientDomains: [], authPathPatterns: [] };
    expect(
      classifyFlowType(
        'https://myapp.internal.example.org/reports',
        'https://myapp.internal.example.org/home',
        bare,
      ),
    ).toBe('main_app');
  });

  it('treats www vs apex of the session host as the same site', () => {
    const bare: AuthDomainsConfig = { authDomains: [], clientDomains: [], authPathPatterns: [] };
    expect(classifyFlowType('https://www.example.com/page', 'https://example.com/', bare)).toBe(
      'main_app',
    );
    expect(classifyFlowType('https://example.com/page', 'https://www.example.com/', bare)).toBe(
      'main_app',
    );
  });

  it('treats sibling subdomains sharing a registrable base as the same site', () => {
    const bare: AuthDomainsConfig = { authDomains: [], clientDomains: [], authPathPatterns: [] };
    expect(
      classifyFlowType('https://api.example.com/data', 'https://app.example.com/', bare),
    ).toBe('main_app');
    // gov.au: base domain is three labels, so health.gov.au subdomains group together...
    expect(
      classifyFlowType('https://portal.health.gov.au/claims', 'https://my.health.gov.au/', bare),
    ).toBe('main_app');
    // ...but a different gov.au agency is a different site.
    expect(
      classifyFlowType('https://services.gov.au/somepage', 'https://my.health.gov.au/', bare),
    ).toBe('external_redirect');
  });

  it('falls back to external_redirect when the session URL is malformed', () => {
    const bare: AuthDomainsConfig = { authDomains: [], clientDomains: [], authPathPatterns: [] };
    expect(classifyFlowType('https://example.com/page', 'garbage', bare)).toBe(
      'external_redirect',
    );
  });
});

describe('detectLoginWall', () => {
  it('flags navigation to an auth URL regardless of other signals', () => {
    expect(
      detectLoginWall(
        { url: 'https://login.microsoftonline.com/common', hasPasswordField: false },
        cfg,
      ),
    ).toEqual({ isLoginWall: true, reason: 'auth-domain-navigation' });
    expect(
      detectLoginWall(
        {
          url: 'https://hbsp-test.powerappsportals.com/signin',
          hasPasswordField: true,
          targetResolutionFailed: false,
        },
        cfg,
      ),
    ).toEqual({ isLoginWall: true, reason: 'auth-domain-navigation' });
  });

  it('flags a password field when target resolution failed', () => {
    expect(
      detectLoginWall(
        {
          url: 'https://hbsp-test.powerappsportals.com/dashboard',
          hasPasswordField: true,
          targetResolutionFailed: true,
        },
        cfg,
      ),
    ).toEqual({ isLoginWall: true, reason: 'login-wall-detected' });
  });

  it('does not flag a password field when target resolution outcome is unknown', () => {
    // Semantics changed after a parity false-positive: only an explicit
    // failed-resolution signal corroborates the password field. Unknown
    // (e.g. after a navigation) must not pause the replay.
    expect(
      detectLoginWall(
        { url: 'https://hbsp-test.powerappsportals.com/dashboard', hasPasswordField: true },
        cfg,
      ),
    ).toEqual({ isLoginWall: false });
  });

  it('does not flag a password field when the target resolved fine', () => {
    expect(
      detectLoginWall(
        {
          url: 'https://hbsp-test.powerappsportals.com/dashboard',
          hasPasswordField: true,
          targetResolutionFailed: false,
        },
        cfg,
      ),
    ).toEqual({ isLoginWall: false });
  });

  it('does not flag a password field after a successful navigation (no resolution signal)', () => {
    // Regression: a11y test fixtures legitimately contain password inputs;
    // navigations resolve no target, so the signal is absent — that must NOT
    // corroborate a login wall (parity sessions against waa_test/ paused here).
    expect(
      detectLoginWall(
        { url: 'http://127.0.0.1:5500/waa_test/page1.html', hasPasswordField: true },
        cfg,
      ),
    ).toEqual({ isLoginWall: false });
  });

  it('does not flag an ordinary page with no password field', () => {
    expect(
      detectLoginWall(
        {
          url: 'https://hbsp-test.powerappsportals.com/dashboard',
          hasPasswordField: false,
          targetResolutionFailed: true,
        },
        cfg,
      ),
    ).toEqual({ isLoginWall: false });
  });

  it('does not throw on malformed URLs and still honours the password signal', () => {
    expect(
      detectLoginWall({ url: '::::', hasPasswordField: true, targetResolutionFailed: true }, cfg),
    ).toEqual({
      isLoginWall: true,
      reason: 'login-wall-detected',
    });
    expect(detectLoginWall({ url: '::::', hasPasswordField: false }, cfg)).toEqual({
      isLoginWall: false,
    });
  });
});
