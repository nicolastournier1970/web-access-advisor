import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../dist/config/env.js';

describe('env schema', () => {
  it('applies documented defaults on an empty environment', () => {
    expect(loadEnv({})).toMatchObject({
      API_PORT: 3002, // legacy Express server keeps 3002 until cutover
      NODE_ENV: 'development',
      LLM_PROVIDER: 'stub',
      SNAPSHOTS_DIR: './snapshots',
      AUTH_DOMAINS_CONFIG: './config/auth-domains.json',
      PLAYWRIGHT_HEADLESS: false,
      REPLAY_AUTH_TIMEOUT_MS: 600_000,
    });
  });

  it('derives LLM_PROVIDER=gemini when GEMINI_API_KEY is present', () => {
    expect(loadEnv({ GEMINI_API_KEY: 'k' }).LLM_PROVIDER).toBe('gemini');
  });

  it('explicit LLM_PROVIDER beats the key-derived default', () => {
    expect(loadEnv({ GEMINI_API_KEY: 'k', LLM_PROVIDER: 'stub' }).LLM_PROVIDER).toBe('stub');
  });

  it('derives the provider by key precedence: claude > openai > gemini', () => {
    expect(loadEnv({ CLAUDE_API_KEY: 'c', GEMINI_API_KEY: 'g' }).LLM_PROVIDER).toBe('claude');
    expect(loadEnv({ OPENAI_API_KEY: 'o', GEMINI_API_KEY: 'g' }).LLM_PROVIDER).toBe('openai');
    expect(loadEnv({ GEMINI_API_KEY: 'g' }).LLM_PROVIDER).toBe('gemini');
    expect(loadEnv({}).LLM_PROVIDER).toBe('stub');
  });

  it('coerces numeric and boolean strings', () => {
    const env = loadEnv({
      API_PORT: '4005',
      PLAYWRIGHT_HEADLESS: 'true',
      REPLAY_AUTH_TIMEOUT_MS: '1000',
    });
    expect(env.API_PORT).toBe(4005);
    expect(env.PLAYWRIGHT_HEADLESS).toBe(true);
    expect(env.REPLAY_AUTH_TIMEOUT_MS).toBe(1000);
    // the z.coerce.boolean trap: the string "false" must mean false
    expect(loadEnv({ PLAYWRIGHT_HEADLESS: 'false' }).PLAYWRIGHT_HEADLESS).toBe(false);
    expect(loadEnv({ PLAYWRIGHT_HEADLESS: '0' }).PLAYWRIGHT_HEADLESS).toBe(false);
  });

  it('treats empty-string values as unset', () => {
    const env = loadEnv({ GEMINI_API_KEY: '', API_PORT: '', PLAYWRIGHT_HEADLESS: '' });
    expect(env.API_PORT).toBe(3002);
    expect(env.LLM_PROVIDER).toBe('stub');
    expect(env.PLAYWRIGHT_HEADLESS).toBe(false);
  });

  it('rejects invalid values loudly at bootstrap', () => {
    expect(() => loadEnv({ API_PORT: 'not-a-port' })).toThrow();
    expect(() => loadEnv({ LLM_PROVIDER: 'not-a-provider' })).toThrow();
    expect(() => loadEnv({ PLAYWRIGHT_HEADLESS: 'maybe' })).toThrow();
  });
});
