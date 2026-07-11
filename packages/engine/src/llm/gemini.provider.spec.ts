import { describe, it, expect } from 'vitest';
import { ProxyAgent, type Dispatcher } from 'undici';
import { llmAnalysisSchema } from '@waa/shared';
import type { LlmBatchRequest } from '../engine-types.js';
import { GeminiProvider } from './gemini.provider.js';

const API_KEY = 'test-secret-key';

function request(): LlmBatchRequest {
  return {
    batchId: 'b1',
    snapshots: [
      {
        step: 1,
        url: 'https://example.com/',
        html: '<main></main>',
        axeViolationsJson: '[]',
        domChangeDescription: 'load',
      },
    ],
    staticSectionMode: 'include',
  };
}

/** Wraps candidate text in a minimal generateContent response body. */
function geminiBody(text: string): string {
  return JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] });
}

interface CapturedCall {
  url: string;
  init: RequestInit & { dispatcher?: Dispatcher };
}

/** fetch fake that records the call and returns the given Response. */
function fakeFetch(respond: () => Response, calls: CapturedCall[]): typeof fetch {
  return (async (url: unknown, init?: unknown) => {
    calls.push({ url: String(url), init: (init ?? {}) as CapturedCall['init'] });
    return respond();
  }) as unknown as typeof fetch;
}

describe('GeminiProvider.analyzeBatch', () => {
  it('POSTs the documented REST shape to the default model without a dispatcher', async () => {
    const calls: CapturedCall[] = [];
    const analysisJson = JSON.stringify({ summary: 'ok', components: [], recommendations: [], score: 80 });
    const provider = new GeminiProvider({
      apiKey: API_KEY,
      fetchImpl: fakeFetch(() => new Response(geminiBody(analysisJson), { status: 200 }), calls),
    });

    const analysis = await provider.analyzeBatch(request(), 5000);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${API_KEY}`,
    );
    expect(call.init.method).toBe('POST');
    expect(call.init.dispatcher).toBeUndefined();
    expect(call.init.signal).toBeInstanceOf(AbortSignal);

    const body = JSON.parse(String(call.init.body));
    expect(body.generationConfig).toEqual({
      temperature: 0.1,
      maxOutputTokens: 65536,
      responseMimeType: 'application/json',
      thinkingConfig: { thinkingBudget: 0 }, // no thinking by default
    });
    expect(body.contents).toHaveLength(1);
    const promptText: string = body.contents[0].parts[0].text;
    expect(promptText).toMatch(/expert screen-reader accessibility auditor/i);
    expect(promptText).toContain('<main></main>');

    expect(analysis.summary).toBe('ok');
    expect(analysis.score).toBe(80);
    expect(llmAnalysisSchema.safeParse(analysis).success).toBe(true);
  });

  it('uses the configured model in the endpoint path', async () => {
    const calls: CapturedCall[] = [];
    const provider = new GeminiProvider({
      apiKey: API_KEY,
      model: 'gemini-2.5-pro',
      fetchImpl: fakeFetch(() => new Response(geminiBody('{"summary":"m","components":[],"recommendations":[],"score":1}'), { status: 200 }), calls),
    });
    await provider.analyzeBatch(request(), 5000);
    expect(calls[0]!.url).toContain('/models/gemini-2.5-pro:generateContent');
  });

  it('passes an undici ProxyAgent dispatcher when proxyUrl is set', async () => {
    const calls: CapturedCall[] = [];
    const provider = new GeminiProvider({
      apiKey: API_KEY,
      proxyUrl: 'http://proxy.corp.local:8080',
      fetchImpl: fakeFetch(() => new Response(geminiBody('{"summary":"p","components":[],"recommendations":[],"score":1}'), { status: 200 }), calls),
    });
    await provider.analyzeBatch(request(), 5000);
    expect(calls[0]!.init.dispatcher).toBeInstanceOf(ProxyAgent);
  });

  it('parses fenced JSON out of the candidate text', async () => {
    const fenced = '```json\n{"summary":"fenced","components":[],"recommendations":[],"score":9}\n```';
    const provider = new GeminiProvider({
      apiKey: API_KEY,
      fetchImpl: fakeFetch(() => new Response(geminiBody(fenced), { status: 200 }), []),
    });
    const analysis = await provider.analyzeBatch(request(), 5000);
    expect(analysis.summary).toBe('fenced');
    expect(analysis.score).toBe(9);
  });

  it('maps HTTP errors to descriptive messages with the key scrubbed', async () => {
    const provider = new GeminiProvider({
      apiKey: API_KEY,
      fetchImpl: fakeFetch(
        () =>
          new Response(`{"error":"invalid key ${API_KEY} rejected"}`, { status: 403 }),
        [],
      ),
    });
    const err = await provider.analyzeBatch(request(), 5000).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('HTTP 403');
    expect((err as Error).message).toContain('[redacted]');
    expect((err as Error).message).not.toContain(API_KEY);
  });

  it('maps the abort signal firing to a timeout error', async () => {
    const hangingFetch = ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      })) as unknown as typeof fetch;
    const provider = new GeminiProvider({ apiKey: API_KEY, fetchImpl: hangingFetch });

    const err = await provider.analyzeBatch(request(), 20).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/timed out after 20ms/);
    expect((err as Error).message).not.toContain(API_KEY);
  });

  it('scrubs the key from transport error messages', async () => {
    const failingFetch = (async () => {
      throw new Error(`connect ECONNREFUSED while sending key=${API_KEY}`);
    }) as unknown as typeof fetch;
    const provider = new GeminiProvider({ apiKey: API_KEY, fetchImpl: failingFetch });

    const err = await provider.analyzeBatch(request(), 5000).catch((e: unknown) => e as Error);
    expect((err as Error).message).toContain('[redacted]');
    expect((err as Error).message).not.toContain(API_KEY);
  });

  it('errors when the response carries no candidate text', async () => {
    const provider = new GeminiProvider({
      apiKey: API_KEY,
      fetchImpl: fakeFetch(() => new Response(JSON.stringify({ candidates: [] }), { status: 200 }), []),
    });
    const err = await provider.analyzeBatch(request(), 5000).catch((e: unknown) => e as Error);
    expect((err as Error).message).toMatch(/no candidate text/i);
  });

  it('errors when the response was truncated at the output cap (MAX_TOKENS)', async () => {
    const truncated = JSON.stringify({
      candidates: [
        { content: { parts: [{ text: '{"summary": "cut off mid-' }] }, finishReason: 'MAX_TOKENS' },
      ],
    });
    const provider = new GeminiProvider({
      apiKey: API_KEY,
      fetchImpl: fakeFetch(() => new Response(truncated, { status: 200 }), []),
    });
    const err = await provider.analyzeBatch(request(), 5000).catch((e: unknown) => e as Error);
    expect((err as Error).message).toMatch(/truncated at the output-token cap/i);
  });

  it('sends the configured thinking budget', async () => {
    const calls: CapturedCall[] = [];
    const analysisJson = JSON.stringify({ summary: 'ok', components: [], recommendations: [], score: 80 });
    const provider = new GeminiProvider({
      apiKey: API_KEY,
      thinkingBudget: 8192,
      fetchImpl: fakeFetch(() => new Response(geminiBody(analysisJson), { status: 200 }), calls),
    });
    await provider.analyzeBatch(request(), 5000);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 8192 });
  });

  it('requires a non-empty apiKey', () => {
    expect(() => new GeminiProvider({ apiKey: '' })).toThrow(/apiKey/);
  });
});

describe('GeminiProvider.consolidate', () => {
  it('merges locally without any network call, deduping by componentName+selector', async () => {
    const neverFetch = (async () => {
      throw new Error('consolidate must not touch the network');
    }) as unknown as typeof fetch;
    const provider = new GeminiProvider({ apiKey: API_KEY, fetchImpl: neverFetch });

    const component = {
      componentName: 'Form elements must have labels',
      issue: 'missing label',
      explanation: 'short',
      relevantHtml: '',
      correctedCode: '',
      codeChangeSummary: '',
      impact: 'serious',
      wcagRule: '4.1.2',
      selector: '#a',
    };
    const batch1 = llmAnalysisSchema.parse({
      summary: 'batch one',
      components: [component],
      recommendations: ['fix labels'],
      score: 40,
    });
    const batch2 = llmAnalysisSchema.parse({
      summary: 'batch two',
      components: [
        { ...component, explanation: 'a much longer explanation than before' },
        { ...component, selector: '#b' },
      ],
      recommendations: ['fix labels', 'add landmarks'],
      score: 60,
    });

    const merged = await provider.consolidate([batch1, batch2], 'https://example.com');

    expect(merged.components).toHaveLength(2); // #a deduped, #b kept
    const first = merged.components.find((c) => c.selector === '#a')!;
    expect(first.explanation).toBe('a much longer explanation than before');
    expect(merged.recommendations).toEqual(['fix labels', 'add landmarks']);
    expect(merged.score).toBe(50); // mean of 40 and 60
    expect(merged.summary).toContain('https://example.com');
    expect(llmAnalysisSchema.safeParse(merged).success).toBe(true);
  });
});
