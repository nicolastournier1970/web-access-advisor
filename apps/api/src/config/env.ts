/**
 * Environment contract for @waa/api (docs/rewrite-plan.md §5).
 *
 * process.env is parsed exactly once at bootstrap (`getEnv()` caches the
 * result); every other module injects the frozen `Env` object via the `ENV`
 * token provided by the global `EnvModule` and never reads process.env itself.
 */
import { Global, Module } from '@nestjs/common';
import { z } from 'zod';
import { chromiumChannelSchema, llmProviderIdSchema, type LlmProviderId } from '@waa/shared';

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
    /** Gemini thinking-token budget; unset → the provider's default (0 = no thinking). */
    GEMINI_THINKING_BUDGET: z.coerce.number().int().nonnegative().optional(),
    /** Anthropic Claude API key; presence can auto-select the 'claude' provider. */
    CLAUDE_API_KEY: z.string().optional(),
    /** Pins the Claude model id; unset → the catalog default (claude-opus-4-8). */
    CLAUDE_MODEL: z.string().optional(),
    /** OpenAI API key; presence can auto-select the 'openai' provider. */
    OPENAI_API_KEY: z.string().optional(),
    /** Pins the OpenAI model id; unset → the catalog default (gpt-4o). */
    OPENAI_MODEL: z.string().optional(),
    /** OpenAI-compatible base URL override (Azure/gateways); unset → the public API. */
    OPENAI_BASE_URL: z.string().optional(),
    /** Ollama server base URL; unset → the provider default (http://localhost:11434). */
    OLLAMA_BASE_URL: z.string().optional(),
    /** Pins the Ollama model id; unset → the catalog default (llama3.1). */
    OLLAMA_MODEL: z.string().optional(),
    /**
     * When unset, derived in the transform below from whichever provider key is
     * present (precedence: claude → openai → gemini → stub). Ollama is never
     * auto-selected (its reachability can't be cheaply probed at boot).
     */
    LLM_PROVIDER: llmProviderIdSchema.optional(),
    /**
     * Drive a system-installed Chromium (msedge/chrome) via Playwright channel
     * instead of the bundled binary. Set by the packaged Electron app (which
     * ships no bundled browser); unset in dev → bundled Chromium.
     */
    WAA_BROWSER_CHANNEL: chromiumChannelSchema.optional(),
    /**
     * Writable per-user data directory injected by the packaged Electron app
     * (Electron's userData). When set, the settings vault lives here and the
     * API's settings PUT is disabled (Electron main owns writes via IPC). Unset
     * in dev → the vault falls back to ~/.waa.
     */
    WAA_USERDATA_DIR: z.string().optional(),
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
    const derived: LlmProviderId = env.CLAUDE_API_KEY
      ? 'claude'
      : env.OPENAI_API_KEY
        ? 'openai'
        : env.GEMINI_API_KEY
          ? 'gemini'
          : 'stub';
    const provider: LlmProviderId = env.LLM_PROVIDER ?? derived;
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
