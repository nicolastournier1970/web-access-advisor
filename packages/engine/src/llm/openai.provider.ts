/**
 * OpenAI LlmProvider on the shared HttpJsonLlmProvider base — one POST per batch
 * to the Chat Completions API (raw undici, no openai SDK; see ADR 0006).
 *
 * JSON is forced with response_format json_object (NOT strict json_schema: the
 * open llmAnalysisSchema conflicts with the closed-schema requirement). The
 * prompt already contains the word "JSON" many times, satisfying json_object's
 * requirement. Uses max_completion_tokens and omits temperature so the body is
 * valid for both classic and reasoning models.
 */
import { defaultModelFor } from '@waa/shared';
import { HttpJsonLlmProvider, type HttpProviderRequest } from './http-provider.js';

export interface OpenAiProviderOptions {
  /** OpenAI API key (Bearer) — never echoed into error messages. */
  apiKey: string;
  /** Model id; defaults to the catalog default (gpt-4o). */
  model?: string;
  /** Base URL override (Azure OpenAI / compatible gateways); default the public API. */
  baseUrl?: string;
  /** Max completion tokens for the findings JSON. */
  maxTokens?: number;
  /** Forward proxy URL; when set, requests go through an undici ProxyAgent. */
  proxyUrl?: string;
  /** Injected fetch for tests; defaults to undici's fetch. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = defaultModelFor('openai') ?? 'gpt-4o';
const DEFAULT_MAX_TOKENS = 16384;

interface OpenAiResponse {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
}

export class OpenAiProvider extends HttpJsonLlmProvider {
  readonly name = 'openai';

  private readonly model: string;
  private readonly baseUrl: string;
  private readonly maxTokens: number;

  constructor(opts: OpenAiProviderOptions) {
    if (!opts.apiKey) throw new Error('OpenAiProvider requires a non-empty apiKey.');
    super({
      apiKey: opts.apiKey,
      ...(opts.proxyUrl !== undefined ? { proxyUrl: opts.proxyUrl } : {}),
      ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
    });
    this.model = opts.model ?? DEFAULT_MODEL;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  }

  protected override providerLabel(): string {
    return 'OpenAI';
  }

  protected buildRequest(prompt: string): HttpProviderRequest {
    return {
      url: `${this.baseUrl}/chat/completions`,
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: {
        model: this.model,
        max_completion_tokens: this.maxTokens,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: prompt }],
      },
    };
  }

  protected extractText(payload: unknown): string {
    return (payload as OpenAiResponse)?.choices?.[0]?.message?.content ?? '';
  }

  protected override checkTruncation(payload: unknown): string | undefined {
    if ((payload as OpenAiResponse)?.choices?.[0]?.finish_reason === 'length') {
      return (
        'OpenAI response was truncated at the output-token cap (finish_reason length); ' +
        'raise the model max tokens or reduce the batch size.'
      );
    }
    return undefined;
  }
}
