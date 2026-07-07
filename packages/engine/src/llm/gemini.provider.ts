/**
 * Google Gemini LlmProvider calling the generateContent REST endpoint
 * directly with undici — no @google/generative-ai SDK and no globalThis.fetch
 * monkey-patching (see docs/adr/0006). Proxy support is a per-client undici
 * ProxyAgent passed as the request dispatcher.
 */
import { ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';
import { llmAnalysisSchema, type ComponentIssue, type LlmAnalysis } from '@waa/shared';
import type { LlmBatchRequest, LlmProvider } from '../engine-types.js';
import { parseLlmJsonResponse } from './provider.js';
import { buildComponentAnalysisPrompt, buildConsolidationNote } from './prompts.js';

/** Constructor options; `fetchImpl` exists for tests (no live network). */
export interface GeminiProviderOptions {
  /** Google AI Studio API key — never echoed into error messages. */
  apiKey: string;
  /** Model id appended to the REST path; defaults to gemini-2.0-flash. */
  model?: string;
  /** Forward proxy URL; when set, requests go through an undici ProxyAgent. */
  proxyUrl?: string;
  /** Injected fetch for tests; defaults to undici's fetch. */
  fetchImpl?: typeof fetch;
}

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-2.0-flash';
/** Max response-body characters quoted in HTTP error messages. */
const ERROR_BODY_CHARS = 500;

type FetchInit = RequestInit & { dispatcher?: Dispatcher };

/** Minimal shape of a generateContent response — only what we read. */
interface GenerateContentResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
}

/** Concatenates candidates[0].content.parts[*].text; '' when absent. */
function extractCandidateText(payload: unknown): string {
  const response = payload as GenerateContentResponse;
  const parts = response?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .join('');
}

/**
 * Gemini REST provider. analyzeBatch performs one POST per batch with a
 * 0.1-temperature generationConfig and AbortSignal.timeout; consolidate is a
 * purely local merge (no network) mirroring the legacy consolidateBatchResults.
 */
export class GeminiProvider implements LlmProvider {
  readonly name = 'gemini';

  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly dispatcher?: Dispatcher;

  constructor(opts: GeminiProviderOptions) {
    if (!opts.apiKey) throw new Error('GeminiProvider requires a non-empty apiKey.');
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.fetchImpl = opts.fetchImpl ?? (undiciFetch as unknown as typeof fetch);
    if (opts.proxyUrl) this.dispatcher = new ProxyAgent(opts.proxyUrl);
  }

  /** Builds the batch prompt, calls generateContent, parses leniently. */
  async analyzeBatch(request: LlmBatchRequest, timeoutMs: number): Promise<LlmAnalysis> {
    const prompt = buildComponentAnalysisPrompt(request);
    const text = await this.generateContent(prompt, timeoutMs);
    return parseLlmJsonResponse(text);
  }

  /**
   * LOCAL merge of batch analyses (no network): concatenates components
   * deduplicating by componentName+selector (keeping the longest
   * explanation/correctedCode across duplicates), merges recommendations and
   * enhanced violations (by id), and recomputes the score as the mean of the
   * batch scores.
   */
  async consolidate(batches: LlmAnalysis[], sessionUrl: string): Promise<LlmAnalysis> {
    const componentsByKey = new Map<string, ComponentIssue>();
    for (const batch of batches) {
      for (const component of batch.components) {
        const key = `${component.componentName}::${component.selector ?? ''}`;
        const existing = componentsByKey.get(key);
        if (!existing) {
          componentsByKey.set(key, { ...component });
        } else {
          if (component.explanation.length > existing.explanation.length) {
            existing.explanation = component.explanation;
          }
          if (component.correctedCode.length > existing.correctedCode.length) {
            existing.correctedCode = component.correctedCode;
          }
        }
      }
    }

    const enhancedById = new Map<string, NonNullable<LlmAnalysis['enhancedAxeViolations']>[number]>();
    for (const batch of batches) {
      for (const violation of batch.enhancedAxeViolations ?? []) {
        if (!enhancedById.has(violation.id)) enhancedById.set(violation.id, violation);
      }
    }

    const recommendations = [...new Set(batches.flatMap((b) => b.recommendations))];
    const scores = batches.map((b) => b.score);
    const score =
      scores.length > 0 ? Math.round(scores.reduce((sum, s) => sum + s, 0) / scores.length) : 100;

    return llmAnalysisSchema.parse({
      summary: buildConsolidationNote(batches, sessionUrl),
      components: [...componentsByKey.values()],
      ...(enhancedById.size > 0 ? { enhancedAxeViolations: [...enhancedById.values()] } : {}),
      recommendations,
      score,
    });
  }

  /** One generateContent round-trip; returns the raw candidate text. */
  private async generateContent(prompt: string, timeoutMs: number): Promise<string> {
    const url = `${GEMINI_BASE_URL}/${this.model}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
    const init: FetchInit = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 8192 },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (this.dispatcher) init.dispatcher = this.dispatcher;

    let response: Response;
    try {
      response = await this.fetchImpl(url, init as RequestInit);
    } catch (error) {
      throw this.toTransportError(error, timeoutMs);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const detail = this.scrubKey(body.trim().slice(0, ERROR_BODY_CHARS));
      throw new Error(
        `Gemini API request failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error('Gemini API returned a non-JSON response body.');
    }

    const text = extractCandidateText(payload);
    if (text === '') {
      throw new Error(
        'Gemini API response contained no candidate text (response may have been blocked or empty).',
      );
    }
    return text;
  }

  /** Maps abort/network failures to descriptive, key-free Errors. */
  private toTransportError(error: unknown, timeoutMs: number): Error {
    const name = (error as { name?: string } | null)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      return new Error(`Gemini API request timed out after ${timeoutMs}ms.`);
    }
    const message = error instanceof Error ? error.message : String(error);
    return new Error(`Gemini API request failed: ${this.scrubKey(message)}`);
  }

  /** Removes any occurrence of the API key (raw or URL-encoded) from text. */
  private scrubKey(text: string): string {
    let scrubbed = text.split(this.apiKey).join('[redacted]');
    const encoded = encodeURIComponent(this.apiKey);
    if (encoded !== this.apiKey) scrubbed = scrubbed.split(encoded).join('[redacted]');
    return scrubbed;
  }
}
