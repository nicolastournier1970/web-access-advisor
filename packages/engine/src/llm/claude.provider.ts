/**
 * Anthropic Claude LlmProvider on the shared HttpJsonLlmProvider base — one POST
 * per batch to the Messages API (raw undici, no @anthropic-ai/sdk; see ADR 0006).
 *
 * JSON is forced by the prompt (buildComponentAnalysisPrompt hard-specifies the
 * contract and parseLlmJsonResponse tolerates fences/prose), NOT by
 * output_config.format: llmAnalysisSchema is intentionally open (optional
 * fields, .catch()/defaults, .catchall) and would be rejected by Claude's
 * closed structured-output schema requirement.
 */
import { defaultModelFor } from '@waa/shared';
import { HttpJsonLlmProvider, type HttpProviderRequest } from './http-provider.js';

export interface ClaudeProviderOptions {
  /** Anthropic API key (x-api-key) — never echoed into error messages. */
  apiKey: string;
  /** Model id; defaults to the catalog default (claude-opus-4-8). */
  model?: string;
  /** Max output tokens for the findings JSON. */
  maxTokens?: number;
  /** Forward proxy URL; when set, requests go through an undici ProxyAgent. */
  proxyUrl?: string;
  /** Injected fetch for tests; defaults to undici's fetch. */
  fetchImpl?: typeof fetch;
}

const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = defaultModelFor('claude') ?? 'claude-opus-4-8';
// Findings JSON for a whole session is bounded (dozens of items); 16384 leaves
// generous headroom. Non-streaming is fine — our own AbortSignal.timeout, not an
// SDK's, bounds the request, so the large-max_tokens streaming caveat is moot.
const DEFAULT_MAX_TOKENS = 16384;

interface ClaudeResponse {
  content?: Array<{ type?: string; text?: string }>;
  stop_reason?: string;
}

export class ClaudeProvider extends HttpJsonLlmProvider {
  readonly name = 'claude';

  private readonly model: string;
  private readonly maxTokens: number;

  constructor(opts: ClaudeProviderOptions) {
    if (!opts.apiKey) throw new Error('ClaudeProvider requires a non-empty apiKey.');
    super({
      apiKey: opts.apiKey,
      ...(opts.proxyUrl !== undefined ? { proxyUrl: opts.proxyUrl } : {}),
      ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
    });
    this.model = opts.model ?? DEFAULT_MODEL;
    this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  }

  protected override providerLabel(): string {
    return 'Claude';
  }

  protected buildRequest(prompt: string): HttpProviderRequest {
    return {
      url: CLAUDE_URL,
      headers: { 'x-api-key': this.apiKey, 'anthropic-version': ANTHROPIC_VERSION },
      // temperature is omitted: current Claude models reject sampling params (400).
      body: {
        model: this.model,
        max_tokens: this.maxTokens,
        messages: [{ role: 'user', content: prompt }],
      },
    };
  }

  protected extractText(payload: unknown): string {
    const content = (payload as ClaudeResponse)?.content;
    if (!Array.isArray(content)) return '';
    return content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('');
  }

  protected override checkTruncation(payload: unknown): string | undefined {
    if ((payload as ClaudeResponse)?.stop_reason === 'max_tokens') {
      return (
        'Claude response was truncated at the output-token cap (stop_reason max_tokens); ' +
        'raise the model max tokens or reduce the batch size.'
      );
    }
    return undefined;
  }
}
