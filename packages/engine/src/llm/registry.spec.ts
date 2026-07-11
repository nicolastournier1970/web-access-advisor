import { describe, it, expect } from 'vitest';
import { createLlmProvider, LlmProviderConfigError } from './registry.js';

describe('createLlmProvider', () => {
  it('returns null for "none"', () => {
    expect(createLlmProvider('none')).toBeNull();
  });

  it('builds each provider with its name, keyless ones without config', () => {
    expect(createLlmProvider('stub')!.name).toBe('stub');
    expect(createLlmProvider('ollama')!.name).toBe('ollama');
    expect(createLlmProvider('gemini', { apiKey: 'k' })!.name).toBe('gemini');
    expect(createLlmProvider('claude', { apiKey: 'k' })!.name).toBe('claude');
    expect(createLlmProvider('openai', { apiKey: 'k' })!.name).toBe('openai');
  });

  it('throws a typed LlmProviderConfigError when a paid provider has no key', () => {
    for (const provider of ['gemini', 'claude', 'openai'] as const) {
      const err = (() => {
        try {
          createLlmProvider(provider);
          return null;
        } catch (e) {
          return e;
        }
      })();
      expect(err).toBeInstanceOf(LlmProviderConfigError);
      expect((err as LlmProviderConfigError).provider).toBe(provider);
    }
  });
});
