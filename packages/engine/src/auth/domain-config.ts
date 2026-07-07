/**
 * Auth-domain configuration loading for @waa/core.
 *
 * Replaces the v1 engine's hardcoded client/IdP domain lists: the engine ships
 * generic defaults (well-known identity providers + generic login paths) and
 * merges a user-editable JSON file (config/auth-domains.json) over them, so
 * client-specific domains never live in code.
 */
import { readFile } from 'node:fs/promises';
import { authDomainsConfigSchema, type AuthDomainsConfig } from '@waa/shared';

/** Recursively freezes a value so the exported defaults cannot be mutated. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Built-in fallback configuration used when no config file exists. Contains
 * only generic, vendor-neutral identity-provider hostnames and login path
 * fragments — deliberately no client domains (those must come from the user's
 * config file). Deep-frozen: callers must copy before mutating.
 */
export const DEFAULT_AUTH_DOMAINS_CONFIG: AuthDomainsConfig = deepFreeze({
  authDomains: [
    'login.microsoftonline.com',
    'accounts.google.com',
    'okta.com',
    'auth0.com',
    'login.live.com',
  ],
  clientDomains: [],
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
});

/** Mutable deep copy of the frozen defaults. */
function cloneDefaults(): AuthDomainsConfig {
  return {
    authDomains: [...DEFAULT_AUTH_DOMAINS_CONFIG.authDomains],
    clientDomains: [...DEFAULT_AUTH_DOMAINS_CONFIG.clientDomains],
    authPathPatterns: [...DEFAULT_AUTH_DOMAINS_CONFIG.authPathPatterns],
  };
}

/**
 * Unions two pattern lists, deduplicating case-insensitively (first
 * occurrence's casing wins) and dropping empty/whitespace-only entries.
 */
function unionCaseInsensitive(base: readonly string[], extra: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...base, ...extra]) {
    const trimmed = raw.trim();
    const key = trimmed.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/** True when the error is a missing-file error (ENOENT/ENOTDIR). */
function isMissingFileError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Loads the auth-domains config file and merges it OVER the built-in defaults
 * (arrays unioned with case-insensitive dedupe — the file can only add
 * patterns, never remove the generic ones).
 *
 * Behaviour:
 *  - `filePath` omitted, or the file does not exist → returns a copy of
 *    {@link DEFAULT_AUTH_DOMAINS_CONFIG} (never throws for a missing file).
 *  - file exists but is invalid JSON or fails `authDomainsConfigSchema`
 *    validation → throws a descriptive Error (silent fallback would hide a
 *    user's typo and quietly drop their client domains).
 */
export async function loadAuthDomainsConfig(filePath?: string): Promise<AuthDomainsConfig> {
  if (!filePath) return cloneDefaults();

  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    if (isMissingFileError(err)) return cloneDefaults();
    throw new Error(`Failed to read auth domains config at ${filePath}: ${errorMessage(err)}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Auth domains config at ${filePath} is not valid JSON: ${errorMessage(err)}`);
  }

  const result = authDomainsConfigSchema.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(
      `Auth domains config at ${filePath} does not match the expected schema: ${issues}`,
    );
  }

  const loaded = result.data;
  const merged: AuthDomainsConfig = {
    authDomains: unionCaseInsensitive(DEFAULT_AUTH_DOMAINS_CONFIG.authDomains, loaded.authDomains),
    clientDomains: unionCaseInsensitive(
      DEFAULT_AUTH_DOMAINS_CONFIG.clientDomains,
      loaded.clientDomains,
    ),
    authPathPatterns: unionCaseInsensitive(
      DEFAULT_AUTH_DOMAINS_CONFIG.authPathPatterns,
      loaded.authPathPatterns,
    ),
  };
  if (loaded.$schema !== undefined) merged.$schema = loaded.$schema;
  if (loaded.comment !== undefined) merged.comment = loaded.comment;
  return merged;
}
