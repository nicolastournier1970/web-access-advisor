/**
 * Local Ollama LlmProvider on the shared HttpJsonLlmProvider base — one POST per
 * batch to a locally-running Ollama server's /api/chat (no API key). The base
 * class automatically skips any configured proxy for the loopback host.
 *
 * `format: 'json'` asks Ollama to emit JSON; `options.num_ctx` widens the model
 * context so the multi-snapshot prompt isn't silently truncated (many local
 * models default to a small window). parseLlmJsonResponse is still the safety net.
 */
import { defaultModelFor } from '@waa/shared';
import { HttpJsonLlmProvider, type HttpProviderRequest } from './http-provider.js';

export interface OllamaProviderOptions {
  /** Model id (must be pulled locally, e.g. `ollama pull llama3.1`). */
  model?: string;
  /** Server base URL; defaults to http://localhost:11434. */
  baseUrl?: string;
  /** Context window (tokens) requested via options.num_ctx. */
  numCtx?: number;
  /** Forward proxy URL (ignored for loopback hosts by the base). */
  proxyUrl?: string;
  /** Injected fetch for tests; defaults to undici's fetch. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = 'http://localhost:11434';
const DEFAULT_MODEL = defaultModelFor('ollama') ?? 'llama3.1';
const DEFAULT_NUM_CTX = 32768;

interface OllamaResponse {
  message?: { content?: string };
  done_reason?: string;
}

export class OllamaProvider extends HttpJsonLlmProvider {
  readonly name = 'ollama';

  private readonly model: string;
  private readonly baseUrl: string;
  private readonly numCtx: number;

  constructor(opts: OllamaProviderOptions = {}) {
    super({
      ...(opts.proxyUrl !== undefined ? { proxyUrl: opts.proxyUrl } : {}),
      ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
    });
    this.model = opts.model ?? DEFAULT_MODEL;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.numCtx = opts.numCtx ?? DEFAULT_NUM_CTX;
  }

  protected override providerLabel(): string {
    return 'Ollama';
  }

  protected buildRequest(prompt: string): HttpProviderRequest {
    return {
      url: `${this.baseUrl}/api/chat`,
      headers: {},
      body: {
        model: this.model,
        stream: false,
        format: 'json',
        options: { num_ctx: this.numCtx, temperature: 0.1 },
        messages: [{ role: 'user', content: prompt }],
      },
    };
  }

  protected extractText(payload: unknown): string {
    return (payload as OllamaResponse)?.message?.content ?? '';
  }

  protected override checkTruncation(payload: unknown): string | undefined {
    if ((payload as OllamaResponse)?.done_reason === 'length') {
      return (
        'Ollama response was truncated at the context/output limit (done_reason length); ' +
        'use a model with a larger context window or reduce the batch size.'
      );
    }
    return undefined;
  }
}
