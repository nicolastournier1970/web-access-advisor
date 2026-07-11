/**
 * Environment contract for @waa/api (docs/rewrite-plan.md §5).
 *
 * process.env is parsed exactly once at bootstrap (`getEnv()` caches the
 * result); every other module injects the frozen `Env` object via the `ENV`
 * token provided by the global `EnvModule` and never reads process.env itself.
 */
import { Global, Module } from '@nestjs/common';
import { z } from 'zod';

export const envSchema = z
  .object({
    /**
     * 3002 — the canonical API port since the Phase 7 cutover freed it from
     * the legacy Express server (the web dev proxy targets it).
     */
    API_PORT: z.coerce.number().int().positive().default(3002),
    NODE_ENV: z.string().default('development'),
    GEMINI_API_KEY: z.string().optional(),
    /** Pins the Gemini model id; unset → the provider's rolling default (gemini-flash-latest). */
    GEMINI_MODEL: z.string().optional(),
    /**
     * When unset, derived from GEMINI_API_KEY in the transform below:
     * key present → 'gemini', otherwise → 'stub'.
     */
    LLM_PROVIDER: z.enum(['gemini', 'stub']).optional(),
    HTTPS_PROXY: z.string().optional(),
    SNAPSHOTS_DIR: z.string().default('./snapshots'),
    AUTH_DOMAINS_CONFIG: z.string().default('./config/auth-domains.json'),
    /**
     * z.stringbool accepts true/1/yes/on/y/enabled and false/0/no/off/n/disabled
     * (z.coerce.boolean would treat the string "false" as true). Headed by
     * default — recording in a visible browser is the product's point.
     */
    PLAYWRIGHT_HEADLESS: z.stringbool().default(false),
    /** Pause-for-login timeout during replay (ADR 0005); default 10 minutes. */
    REPLAY_AUTH_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
    /**
     * Per-action page-load settle ceiling during replay (ms). The main
     * replay-speed lever: lower it for snappy sites, raise it for heavy SPAs.
     * Default 3000 (replay used to wait up to 15s for network idle).
     */
    REPLAY_LOAD_WAIT_MS: z.coerce.number().int().nonnegative().default(3000),
    /** Multiplier on the fixed per-action settle pauses during replay (default 1). */
    REPLAY_PAUSE_SCALE: z.coerce.number().positive().default(1),
  })
  .transform((env) => {
    const provider: 'gemini' | 'stub' =
      env.LLM_PROVIDER ?? (env.GEMINI_API_KEY ? 'gemini' : 'stub');
    return { ...env, LLM_PROVIDER: provider };
  });

export type Env = z.infer<typeof envSchema>;

/**
 * Parse an environment map. Empty-string values are treated as unset so that
 * `set GEMINI_API_KEY=` on Windows (or a blank .env line) falls back to the
 * schema default instead of failing validation.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const withoutEmpty = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value !== ''),
  );
  return envSchema.parse(withoutEmpty);
}

let cached: Env | undefined;

/** Parse process.env once and cache; used by main.ts and the ENV provider. */
export function getEnv(): Env {
  cached ??= loadEnv();
  return cached;
}

/** Injection token: `@Inject(ENV) private readonly env: Env`. */
export const ENV = Symbol('WAA_ENV');

@Global()
@Module({
  providers: [{ provide: ENV, useFactory: getEnv }],
  exports: [ENV],
})
export class EnvModule {}
