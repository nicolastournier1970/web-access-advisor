/**
 * Runtime LLM settings DTOs.
 *  GET /api/settings   — current provider selection + per-provider status
 *  PUT /api/settings   — change the selection and/or a provider's key/model/baseUrl
 *
 * Security invariant: API keys are WRITE-ONLY. The GET response never carries a
 * key value — only a `hasKey` boolean per provider — so a compromised renderer
 * or a shoulder-surfer cannot read a stored key back out. This is enforced here
 * (the response schema has no key field) so it holds over both the HTTP API and
 * the Electron IPC bridge.
 */
import { z } from 'zod';
import { llmProviderIdSchema } from '../llm/provider.schema.js';

/** Per-provider status returned by GET — never includes the key itself. */
export const providerSettingsStatusSchema = z.object({
  /** True when an encrypted API key is stored for this provider. */
  hasKey: z.boolean(),
  /** Selected model id for this provider (unset → provider default). */
  model: z.string().optional(),
  /** Base URL override (OpenAI-compatible gateway, Ollama host). */
  baseUrl: z.string().optional(),
});
export type ProviderSettingsStatus = z.infer<typeof providerSettingsStatusSchema>;

export const settingsResponseSchema = z.object({
  /** The provider the next analysis uses unless the request overrides it. */
  selectedProvider: llmProviderIdSchema,
  /** Status keyed by provider id (gemini/claude/openai/ollama/stub). */
  providers: z.record(z.string(), providerSettingsStatusSchema),
});
export type SettingsResponse = z.infer<typeof settingsResponseSchema>;

export const updateSettingsRequestSchema = z
  .object({
    /** Change which provider is active. */
    selectedProvider: llmProviderIdSchema.optional(),
    /** The provider that `apiKey`/`model`/`baseUrl` below apply to. */
    provider: llmProviderIdSchema.optional(),
    /** Write-only: a new API key (encrypted at rest). '' clears the stored key. */
    apiKey: z.string().optional(),
    /** Selected model id for `provider`. */
    model: z.string().optional(),
    /** Base URL override for `provider`. */
    baseUrl: z.string().optional(),
  })
  .refine((d) => d.selectedProvider !== undefined || d.provider !== undefined, {
    message: 'Provide selectedProvider and/or a provider to update.',
  });
export type UpdateSettingsRequest = z.infer<typeof updateSettingsRequestSchema>;
