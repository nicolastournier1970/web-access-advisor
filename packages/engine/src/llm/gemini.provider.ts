/**
 * Google Gemini LlmProvider on the shared HttpJsonLlmProvider base — one POST
 * per batch to the generateContent REST endpoint (raw undici, no SDK, no
 * globalThis.fetch monkey-patching; see docs/adr/0006). Only the Gemini-shaped
 * request/extraction/truncation differ from the base transport.
 */
import { defaultModelFor } from '@waa/shared';
import { HttpJsonLlmProvider, type HttpProviderRequest } from './http-provider.js';

/** Constructor options; `fetchImpl` exists for tests (no live network). */
export interface GeminiProviderOptions {
  /** Google AI Studio API key — never echoed into error messages. */
  apiKey: string;
  /** Model id appended to the REST path; defaults to gemini-flash-latest. */
  model?: string;
  /** Forward proxy URL; when set, requests go through an undici ProxyAgent. */
  proxyUrl?: string;
  /**
   * Gemini thinking-token budget. Default 0: current Flash models think
   * DYNAMICALLY by default (hundreds of thought tokens even on trivial
   * prompts — measured 2.2× slower), and this extraction-shaped analysis
   * doesn't need it. Raise (e.g. 1024) to buy deeper semantic hunting.
   */
  thinkingBudget?: number;
  /** Injected fetch for tests; defaults to undici's fetch. */
  fetchImpl?: typeof fetch;
}

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
// Rolling alias: always points at the current stable Flash model, so the
// provider keeps working when Google retires a pinned version (gemini-2.0-flash
// died this way in 2026 — every batch 404'd silently). Pin via the `model`
// option / GEMINI_MODEL env when reproducibility matters more than uptime.
const DEFAULT_MODEL = defaultModelFor('gemini') ?? 'gemini-flash-latest';

/** Minimal shape of a generateContent response — only what we read. */
interface GenerateContentResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
}

export class GeminiProvider extends HttpJsonLlmProvider {
  readonly name = 'gemini';

  private readonly model: string;
  private readonly thinkingBudget: number;

  constructor(opts: GeminiProviderOptions) {
    if (!opts.apiKey) throw new Error('GeminiProvider requires a non-empty apiKey.');
    super({
      apiKey: opts.apiKey,
      ...(opts.proxyUrl !== undefined ? { proxyUrl: opts.proxyUrl } : {}),
      ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
    });
    this.model = opts.model ?? DEFAULT_MODEL;
    this.thinkingBudget = opts.thinkingBudget ?? 0;
  }

  protected buildRequest(prompt: string): HttpProviderRequest {
    return {
      url: `${GEMINI_BASE_URL}/${this.model}:generateContent?key=${encodeURIComponent(this.apiKey)}`,
      headers: {},
      body: {
        contents: [{ parts: [{ text: prompt }] }],
        // responseMimeType makes the model emit pure JSON (no fences/prose).
        // 65536 output: a whole-session batch carries dozens of findings +
        // per-violation corrected code, AND thinking tokens count against
        // this cap — 32768 got clipped mid-JSON on real sessions.
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 65536,
          responseMimeType: 'application/json',
          thinkingConfig: { thinkingBudget: this.thinkingBudget },
        },
      },
    };
  }

  protected extractText(payload: unknown): string {
    const parts = (payload as GenerateContentResponse)?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) return '';
    return parts.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
  }

  protected override checkTruncation(payload: unknown): string | undefined {
    const finishReason = (payload as GenerateContentResponse).candidates?.[0]?.finishReason;
    if (finishReason === 'MAX_TOKENS') {
      return (
        'Gemini response was truncated at the output-token cap (finishReason MAX_TOKENS); ' +
        'lower GEMINI_THINKING_BUDGET or reduce the batch size.'
      );
    }
    return undefined;
  }
}
