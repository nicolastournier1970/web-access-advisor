/**
 * Abstract base for every HTTP-JSON LlmProvider (Gemini/Claude/OpenAI/Ollama).
 *
 * It owns the entire undici round-trip that used to be hand-written inside
 * GeminiProvider: fetch + optional per-instance ProxyAgent dispatcher,
 * AbortSignal.timeout, `!response.ok` → key-scrubbed error, JSON parse,
 * truncation check, and text extraction — plus the analyzeBatch template
 * (buildComponentAnalysisPrompt → POST → parseLlmJsonResponse) and the shared
 * local consolidate. A concrete provider implements only three hooks:
 * {@link buildRequest}, {@link extractText}, and (optionally) {@link checkTruncation}.
 *
 * ADR 0006: raw undici, no vendor SDKs, no globalThis.fetch monkey-patching —
 * so one ProxyAgent handling covers every provider and the Electron bundle gains
 * zero dependencies.
 */
import { ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';
import type { LlmAnalysis } from '@waa/shared';
import type { LlmBatchRequest, LlmProvider } from '../engine-types.js';
import { parseLlmJsonResponse } from './provider.js';
import { buildComponentAnalysisPrompt } from './prompts.js';
import { consolidateAnalyses } from './consolidate.js';

/** Max response-body characters quoted in HTTP error messages. */
const ERROR_BODY_CHARS = 500;

/** What a concrete provider's buildRequest returns; `body` is JSON.stringify'd here. */
export interface HttpProviderRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface HttpJsonLlmProviderOptions {
  /** Auth key (scrubbed from all error text); '' / undefined for keyless providers. */
  apiKey?: string;
  /** Forward proxy URL; when set, non-loopback requests go through an undici ProxyAgent. */
  proxyUrl?: string;
  /** Injected fetch for tests; defaults to undici's fetch. */
  fetchImpl?: typeof fetch;
}

// @types/node ≥ 24 declares its own `dispatcher` on RequestInit via undici-types,
// nominally incompatible with the undici package's Dispatcher. Omit then re-add.
type FetchInit = Omit<RequestInit, 'dispatcher'> & { dispatcher?: Dispatcher };

export abstract class HttpJsonLlmProvider implements LlmProvider {
  abstract readonly name: string;

  /** '' for keyless providers (Ollama); used only for error scrubbing + auth. */
  protected readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly dispatcher?: Dispatcher;

  constructor(opts: HttpJsonLlmProviderOptions) {
    this.apiKey = opts.apiKey ?? '';
    this.fetchImpl = opts.fetchImpl ?? (undiciFetch as unknown as typeof fetch);
    if (opts.proxyUrl) this.dispatcher = new ProxyAgent(opts.proxyUrl);
  }

  // -- subclass hooks --------------------------------------------------------

  /**
   * Human-facing provider name for error messages (`name` stays lowercase
   * because it is persisted as `result.llmProvider`). Default: capitalized name.
   */
  protected providerLabel(): string {
    return this.name.charAt(0).toUpperCase() + this.name.slice(1);
  }

  /** Endpoint, headers, and JSON body for one batch prompt. */
  protected abstract buildRequest(prompt: string, timeoutMs: number): HttpProviderRequest;

  /** Pull the model's text answer out of the parsed response payload; '' if absent. */
  protected abstract extractText(payload: unknown): string;

  /**
   * Return a diagnostic message when the response was truncated at the output
   * cap (so the batch fails visibly instead of handing half-JSON to the parser);
   * undefined when the response is complete. Default: never truncated.
   */
  protected checkTruncation(_payload: unknown): string | undefined {
    return undefined;
  }

  // -- LlmProvider -----------------------------------------------------------

  async analyzeBatch(request: LlmBatchRequest, timeoutMs: number): Promise<LlmAnalysis> {
    const prompt = buildComponentAnalysisPrompt(request);
    const text = await this.postForText(prompt, timeoutMs);
    return parseLlmJsonResponse(text);
  }

  async consolidate(batches: LlmAnalysis[], sessionUrl: string): Promise<LlmAnalysis> {
    return consolidateAnalyses(batches, sessionUrl);
  }

  // -- transport -------------------------------------------------------------

  private async postForText(prompt: string, timeoutMs: number): Promise<string> {
    const { url, headers, body } = this.buildRequest(prompt, timeoutMs);
    const init: FetchInit = {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    };
    // Never route loopback (Ollama, self-hosted) through a corporate proxy.
    if (this.dispatcher && this.useProxyFor(url)) init.dispatcher = this.dispatcher;

    let response: Response;
    try {
      response = await this.fetchImpl(url, init as RequestInit);
    } catch (error) {
      throw this.toTransportError(error, timeoutMs);
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      const detail = this.scrub(bodyText.trim().slice(0, ERROR_BODY_CHARS));
      throw new Error(
        `${this.providerLabel()} API request failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`${this.providerLabel()} API returned a non-JSON response body.`);
    }

    const truncation = this.checkTruncation(payload);
    if (truncation !== undefined) throw new Error(truncation);

    const text = this.extractText(payload);
    if (text === '') {
      throw new Error(
        `${this.providerLabel()} API response contained no text (response may have been blocked or empty).`,
      );
    }
    return text;
  }

  /** True unless the URL host is loopback (localhost / 127.0.0.1 / ::1). */
  private useProxyFor(url: string): boolean {
    try {
      const host = new URL(url).hostname;
      return host !== 'localhost' && host !== '127.0.0.1' && host !== '::1';
    } catch {
      return true;
    }
  }

  /** Maps abort/network failures to descriptive, key-free Errors. */
  private toTransportError(error: unknown, timeoutMs: number): Error {
    const name = (error as { name?: string } | null)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      return new Error(`${this.providerLabel()} API request timed out after ${timeoutMs}ms.`);
    }
    const message = error instanceof Error ? error.message : String(error);
    return new Error(`${this.providerLabel()} API request failed: ${this.scrub(message)}`);
  }

  /** Removes the API key (raw or URL-encoded) from any text before it surfaces. */
  protected scrub(text: string): string {
    if (this.apiKey === '') return text;
    let scrubbed = text.split(this.apiKey).join('[redacted]');
    const encoded = encodeURIComponent(this.apiKey);
    if (encoded !== this.apiKey) scrubbed = scrubbed.split(encoded).join('[redacted]');
    return scrubbed;
  }
}
