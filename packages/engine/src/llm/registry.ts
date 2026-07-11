/**
 * Provider factory: one place that maps a provider choice + config to a
 * concrete LlmProvider (or null for 'none'). Collapses the resolveProvider
 * switches that were duplicated in apps/api and packages/cli. Missing-key
 * mistakes surface as a typed {@link LlmProviderConfigError} that callers map to
 * their own error type (HTTP 400 / CLI usage error).
 */
import type { LlmProviderChoice } from '@waa/shared';
import type { LlmProvider } from '../engine-types.js';
import { GeminiProvider } from './gemini.provider.js';
import { ClaudeProvider } from './claude.provider.js';
import { OpenAiProvider } from './openai.provider.js';
import { OllamaProvider } from './ollama.provider.js';
import { StubProvider } from './stub.provider.js';

/** Runtime config for building a provider; all optional (validated per provider). */
export interface LlmProviderConfig {
  apiKey?: string;
  model?: string;
  /** Corporate forward proxy (Gemini/Claude/OpenAI). */
  proxyUrl?: string;
  /** Base URL override (OpenAI-compatible gateway, Ollama host). */
  baseUrl?: string;
  /** Gemini thinking-token budget. */
  thinkingBudget?: number;
}

/** Thrown when a provider requires an API key that was not supplied. */
export class LlmProviderConfigError extends Error {
  constructor(
    message: string,
    readonly provider: LlmProviderChoice,
  ) {
    super(message);
    this.name = 'LlmProviderConfigError';
  }
}

function requireKey(config: LlmProviderConfig, provider: LlmProviderChoice): string {
  const key = config.apiKey;
  if (key === undefined || key === '') {
    throw new LlmProviderConfigError(`Provider "${provider}" requires an API key.`, provider);
  }
  return key;
}

/**
 * Build the provider for a choice, or null for 'none'. Throws
 * {@link LlmProviderConfigError} when a paid provider is missing its key.
 */
export function createLlmProvider(
  choice: LlmProviderChoice,
  config: LlmProviderConfig = {},
): LlmProvider | null {
  switch (choice) {
    case 'none':
      return null;
    case 'stub':
      return new StubProvider();
    case 'gemini':
      return new GeminiProvider({
        apiKey: requireKey(config, 'gemini'),
        ...(config.model !== undefined ? { model: config.model } : {}),
        ...(config.proxyUrl !== undefined ? { proxyUrl: config.proxyUrl } : {}),
        ...(config.thinkingBudget !== undefined ? { thinkingBudget: config.thinkingBudget } : {}),
      });
    case 'claude':
      return new ClaudeProvider({
        apiKey: requireKey(config, 'claude'),
        ...(config.model !== undefined ? { model: config.model } : {}),
        ...(config.proxyUrl !== undefined ? { proxyUrl: config.proxyUrl } : {}),
      });
    case 'openai':
      return new OpenAiProvider({
        apiKey: requireKey(config, 'openai'),
        ...(config.model !== undefined ? { model: config.model } : {}),
        ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
        ...(config.proxyUrl !== undefined ? { proxyUrl: config.proxyUrl } : {}),
      });
    case 'ollama':
      return new OllamaProvider({
        ...(config.model !== undefined ? { model: config.model } : {}),
        ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
      });
  }
}
