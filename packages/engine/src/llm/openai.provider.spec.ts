import { describe, it, expect } from 'vitest';
import type { LlmBatchRequest } from '../engine-types.js';
import { OpenAiProvider } from './openai.provider.js';

const API_KEY = 'sk-openai-test-key';
const ANALYSIS_JSON = JSON.stringify({ summary: 'ok', components: [], recommendations: [], score: 80 });

function request(): LlmBatchRequest {
  return {
    batchId: 'b1',
    snapshots: [
      { step: 1, url: 'https://example.com/', html: '<main></main>', axeViolationsJson: '[]', domChangeDescription: 'load' },
    ],
    staticSectionMode: 'include',
  };
}

interface CapturedCall {
  url: string;
  init: RequestInit & { dispatcher?: unknown };
}

function fakeFetch(respond: () => Response, calls: CapturedCall[]): typeof fetch {
  return (async (url: unknown, init?: unknown) => {
    calls.push({ url: String(url), init: (init ?? {}) as CapturedCall['init'] });
    return respond();
  }) as unknown as typeof fetch;
}

function openaiBody(text: string, finishReason = 'stop'): string {
  return JSON.stringify({ choices: [{ message: { content: text }, finish_reason: finishReason }] });
}

describe('OpenAiProvider.analyzeBatch', () => {
  it('POSTs Chat Completions with Bearer auth, json_object, and max_completion_tokens', async () => {
    const calls: CapturedCall[] = [];
    const provider = new OpenAiProvider({
      apiKey: API_KEY,
      fetchImpl: fakeFetch(() => new Response(openaiBody(ANALYSIS_JSON), { status: 200 }), calls),
    });
    const analysis = await provider.analyzeBatch(request(), 5000);

    const call = calls[0]!;
    expect(call.url).toBe('https://api.openai.com/v1/chat/completions');
    expect((call.init.headers as Record<string, string>)['authorization']).toBe(`Bearer ${API_KEY}`);
    const body = JSON.parse(String(call.init.body));
    expect(body.model).toBe('gpt-4o');
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(typeof body.max_completion_tokens).toBe('number');
    expect(body.max_tokens).toBeUndefined();
    expect(body.temperature).toBeUndefined();
    expect(analysis.summary).toBe('ok');
  });

  it('honors a baseUrl override (Azure / gateway) with trailing slashes trimmed', async () => {
    const calls: CapturedCall[] = [];
    const provider = new OpenAiProvider({
      apiKey: API_KEY,
      baseUrl: 'https://gw.example.com/v1/',
      fetchImpl: fakeFetch(() => new Response(openaiBody(ANALYSIS_JSON), { status: 200 }), calls),
    });
    await provider.analyzeBatch(request(), 5000);
    expect(calls[0]!.url).toBe('https://gw.example.com/v1/chat/completions');
  });

  it('errors (truncation) when finish_reason is length', async () => {
    const provider = new OpenAiProvider({
      apiKey: API_KEY,
      fetchImpl: fakeFetch(() => new Response(openaiBody('{"summary":"cut', 'length'), { status: 200 }), []),
    });
    const err = await provider.analyzeBatch(request(), 5000).catch((e: unknown) => e as Error);
    expect((err as Error).message).toMatch(/truncated at the output-token cap/i);
  });

  it('requires a non-empty apiKey', () => {
    expect(() => new OpenAiProvider({ apiKey: '' })).toThrow(/apiKey/);
  });
});
