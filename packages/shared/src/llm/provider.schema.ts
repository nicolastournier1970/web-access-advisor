/**
 * LLM provider identity + a UI-consumable model/pricing catalog.
 *
 * The provider id list lived in three drifting places (apps/api env.ts,
 * analysis-api.schema.ts, cli args.ts); it is defined ONCE here so API
 * validation, the request contract, and the CLI flag stay in lockstep as
 * providers are added.
 *
 * The catalog carries per-model pricing so the Angular settings screen can
 * render dropdowns + a cost hint WITHOUT importing @waa/core (the engine is
 * forbidden in the browser bundle). Prices are USD per 1M tokens and are
 * indicative published list prices — a cost HINT, not billing.
 */
import { z } from 'zod';

/** Concrete providers that actually run an analysis. */
export const llmProviderIdSchema = z.enum(['gemini', 'claude', 'openai', 'ollama', 'stub']);
export type LlmProviderId = z.infer<typeof llmProviderIdSchema>;

/** Provider ids plus 'none' (disable AI, axe-only). Used by the request DTO + CLI. */
export const llmProviderChoiceSchema = z.enum([
  'gemini',
  'claude',
  'openai',
  'ollama',
  'stub',
  'none',
]);
export type LlmProviderChoice = z.infer<typeof llmProviderChoiceSchema>;

export interface LlmModelInfo {
  id: string;
  label: string;
  /** USD per 1M input tokens (indicative). */
  inputPerMtok: number;
  /** USD per 1M output tokens (indicative). */
  outputPerMtok: number;
  /** Pre-selected in the settings UI when the provider is first chosen. */
  default?: boolean;
}

export interface ProviderCatalogEntry {
  id: LlmProviderId;
  label: string;
  /** Whether the settings UI must collect an API key for this provider. */
  requiresApiKey: boolean;
  /** Whether the provider accepts a custom base URL (Ollama, self-hosted OpenAI). */
  supportsBaseUrl: boolean;
  models: LlmModelInfo[];
}

/**
 * Provider/model catalog for the settings UI. Pricing is indicative published
 * list price (USD / 1M tokens) at time of writing; the engine's default-model
 * constants intentionally reference the `default: true` entry here so there is
 * one source of truth.
 */
export const PROVIDER_CATALOG: readonly ProviderCatalogEntry[] = [
  {
    id: 'gemini',
    label: 'Google Gemini',
    requiresApiKey: true,
    supportsBaseUrl: false,
    models: [
      { id: 'gemini-flash-latest', label: 'Gemini Flash (latest)', inputPerMtok: 0.3, outputPerMtok: 2.5, default: true },
      { id: 'gemini-flash-lite-latest', label: 'Gemini Flash-Lite (latest)', inputPerMtok: 0.1, outputPerMtok: 0.4 },
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', inputPerMtok: 1.25, outputPerMtok: 10 },
    ],
  },
  {
    id: 'claude',
    label: 'Anthropic Claude',
    requiresApiKey: true,
    supportsBaseUrl: false,
    models: [
      { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', inputPerMtok: 5, outputPerMtok: 25, default: true },
      { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', inputPerMtok: 3, outputPerMtok: 15 },
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', inputPerMtok: 1, outputPerMtok: 5 },
      { id: 'claude-fable-5', label: 'Claude Fable 5', inputPerMtok: 10, outputPerMtok: 50 },
    ],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    requiresApiKey: true,
    supportsBaseUrl: true,
    models: [
      { id: 'gpt-4o', label: 'GPT-4o', inputPerMtok: 2.5, outputPerMtok: 10, default: true },
      { id: 'gpt-4o-mini', label: 'GPT-4o mini', inputPerMtok: 0.15, outputPerMtok: 0.6 },
      { id: 'gpt-4.1', label: 'GPT-4.1', inputPerMtok: 2, outputPerMtok: 8 },
    ],
  },
  {
    id: 'ollama',
    label: 'Local (Ollama)',
    requiresApiKey: false,
    supportsBaseUrl: true,
    models: [
      { id: 'llama3.1', label: 'Llama 3.1', inputPerMtok: 0, outputPerMtok: 0, default: true },
      { id: 'llama3.2', label: 'Llama 3.2', inputPerMtok: 0, outputPerMtok: 0 },
      { id: 'qwen2.5', label: 'Qwen 2.5', inputPerMtok: 0, outputPerMtok: 0 },
    ],
  },
];

/** The catalog entry for a provider id, or undefined for 'stub'/'none'. */
export function providerCatalogEntry(id: string): ProviderCatalogEntry | undefined {
  return PROVIDER_CATALOG.find((entry) => entry.id === id);
}

/** The `default: true` model id for a provider, or undefined. */
export function defaultModelFor(id: string): string | undefined {
  const entry = providerCatalogEntry(id);
  return entry?.models.find((m) => m.default)?.id ?? entry?.models[0]?.id;
}
