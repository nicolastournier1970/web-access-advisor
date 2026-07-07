import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_AUTH_DOMAINS_CONFIG, loadAuthDomainsConfig } from './domain-config.js';

/** Mirrors the shape of the repo's config/auth-domains.json. */
const REPO_STYLE_CONFIG = {
  $schema: './auth-domains.schema.json',
  comment: 'test fixture',
  authDomains: [
    'auth.identity.gov.au',
    'sts.development.health.gov.au',
    'myid.gov.au',
    'login.microsoftonline.com',
    'login.live.com',
    'accounts.google.com',
    'okta.com',
    'auth0.com',
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

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'waa-auth-config-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeConfig(name: string, content: string): Promise<string> {
  const filePath = path.join(dir, name);
  await writeFile(filePath, content, 'utf8');
  return filePath;
}

describe('DEFAULT_AUTH_DOMAINS_CONFIG', () => {
  it('contains the generic IdP domains and no client domains', () => {
    expect(DEFAULT_AUTH_DOMAINS_CONFIG.authDomains).toEqual(
      expect.arrayContaining([
        'login.microsoftonline.com',
        'accounts.google.com',
        'okta.com',
        'auth0.com',
        'login.live.com',
      ]),
    );
    expect(DEFAULT_AUTH_DOMAINS_CONFIG.clientDomains).toEqual([]);
  });

  it('contains the generic auth path patterns', () => {
    expect(DEFAULT_AUTH_DOMAINS_CONFIG.authPathPatterns).toEqual(
      expect.arrayContaining([
        '/login',
        '/signin',
        '/sign-in',
        '/auth',
        '/oauth',
        '/sso',
        '/account/logon',
        '/unauthorized',
      ]),
    );
  });

  it('is frozen against accidental mutation', () => {
    expect(Object.isFrozen(DEFAULT_AUTH_DOMAINS_CONFIG)).toBe(true);
    expect(Object.isFrozen(DEFAULT_AUTH_DOMAINS_CONFIG.authDomains)).toBe(true);
    expect(() => DEFAULT_AUTH_DOMAINS_CONFIG.authDomains.push('evil.com')).toThrow();
  });
});

describe('loadAuthDomainsConfig', () => {
  it('returns a mutable copy of the defaults when no path is given', async () => {
    const cfg = await loadAuthDomainsConfig();
    expect(cfg).toEqual({
      authDomains: [...DEFAULT_AUTH_DOMAINS_CONFIG.authDomains],
      clientDomains: [],
      authPathPatterns: [...DEFAULT_AUTH_DOMAINS_CONFIG.authPathPatterns],
    });
    cfg.authDomains.push('mutable.example');
    expect(DEFAULT_AUTH_DOMAINS_CONFIG.authDomains).not.toContain('mutable.example');
  });

  it('returns the defaults when the file does not exist (no throw)', async () => {
    const cfg = await loadAuthDomainsConfig(path.join(dir, 'does-not-exist.json'));
    expect(cfg.authDomains).toEqual([...DEFAULT_AUTH_DOMAINS_CONFIG.authDomains]);
    expect(cfg.clientDomains).toEqual([]);
  });

  it('merges a repo-style config over the defaults with union semantics', async () => {
    const file = await writeConfig('repo.json', JSON.stringify(REPO_STYLE_CONFIG));
    const cfg = await loadAuthDomainsConfig(file);

    // gov.au additions present alongside the generic defaults.
    expect(cfg.authDomains).toEqual(
      expect.arrayContaining([
        'auth.identity.gov.au',
        'sts.development.health.gov.au',
        'myid.gov.au',
        'login.microsoftonline.com',
        'okta.com',
      ]),
    );
    // Overlapping entries are deduplicated, not doubled.
    expect(cfg.authDomains.filter((d) => d === 'login.microsoftonline.com')).toHaveLength(1);
    expect(cfg.clientDomains).toEqual(['hbsp-test.powerappsportals.com']);
    // Identical path patterns collapse to the default set.
    expect(cfg.authPathPatterns.filter((p) => p === '/login')).toHaveLength(1);
  });

  it('dedupes case-insensitively, keeping the first casing seen', async () => {
    const file = await writeConfig(
      'case.json',
      JSON.stringify({
        authDomains: ['LOGIN.MICROSOFTONLINE.COM', 'Example-IdP.com'],
        clientDomains: [],
        authPathPatterns: ['/LOGIN', '/portal-entry'],
      }),
    );
    const cfg = await loadAuthDomainsConfig(file);
    const msEntries = cfg.authDomains.filter(
      (d) => d.toLowerCase() === 'login.microsoftonline.com',
    );
    expect(msEntries).toEqual(['login.microsoftonline.com']);
    expect(cfg.authDomains).toContain('Example-IdP.com');
    expect(cfg.authPathPatterns.filter((p) => p.toLowerCase() === '/login')).toEqual(['/login']);
    expect(cfg.authPathPatterns).toContain('/portal-entry');
  });

  it('applies schema defaults for omitted array fields', async () => {
    const file = await writeConfig('partial.json', JSON.stringify({ authDomains: ['idp.example'] }));
    const cfg = await loadAuthDomainsConfig(file);
    expect(cfg.authDomains).toContain('idp.example');
    expect(cfg.clientDomains).toEqual([]);
    expect(cfg.authPathPatterns).toEqual([...DEFAULT_AUTH_DOMAINS_CONFIG.authPathPatterns]);
  });

  it('throws a descriptive error for invalid JSON', async () => {
    const file = await writeConfig('broken.json', '{ "authDomains": [ oops');
    await expect(loadAuthDomainsConfig(file)).rejects.toThrow(/not valid JSON/i);
  });

  it('throws a descriptive error when the shape fails schema validation', async () => {
    const file = await writeConfig(
      'bad-shape.json',
      JSON.stringify({ authDomains: 'not-an-array' }),
    );
    await expect(loadAuthDomainsConfig(file)).rejects.toThrow(/expected schema.*authDomains/is);
  });
});
