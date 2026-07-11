import { describe, it, expect } from 'vitest';
import type { LlmBatchRequest } from '../engine-types.js';
import { ClaudeProvider } from './claude.provider.js';

const API_KEY = 'sk-ant-test-key';
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

function claudeBody(text: string, stopReason = 'end_turn'): string {
  return JSON.stringify({ content: [{ type: 'text', text }], stop_reason: stopReason });
}

describe('ClaudeProvider.analyzeBatch', () => {
  it('POSTs the Messages API shape with x-api-key and no sampling params', async () => {
    const calls: CapturedCall[] = [];
    const provider = new ClaudeProvider({
      apiKey: API_KEY,
      fetchImpl: fakeFetch(() => new Response(claudeBody(ANALYSIS_JSON), { status: 200 }), calls),
    });
    const analysis = await provider.analyzeBatch(request(), 5000);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('https://api.anthropic.com/v1/messages');
    const headers = call.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe(API_KEY);
    expect(headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(String(call.init.body));
    expect(body.model).toBe('claude-opus-4-8');
    expect(typeof body.max_tokens).toBe('number');
    expect(body.messages[0]).toEqual({ role: 'user', content: expect.stringContaining('<main></main>') });
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
    expect(analysis.summary).toBe('ok');
    expect(call.init.dispatcher).toBeUndefined();
  });

  it('uses the configured model', async () => {
    const calls: CapturedCall[] = [];
    const provider = new ClaudeProvider({
      apiKey: API_KEY,
      model: 'claude-haiku-4-5',
      fetchImpl: fakeFetch(() => new Response(claudeBody(ANALYSIS_JSON), { status: 200 }), calls),
    });
    await provider.analyzeBatch(request(), 5000);
    expect(JSON.parse(String(calls[0]!.init.body)).model).toBe('claude-haiku-4-5');
  });

  it('errors (truncation) when stop_reason is max_tokens', async () => {
    const provider = new ClaudeProvider({
      apiKey: API_KEY,
      fetchImpl: fakeFetch(() => new Response(claudeBody('{"summary":"cut', 'max_tokens'), { status: 200 }), []),
    });
    const err = await provider.analyzeBatch(request(), 5000).catch((e: unknown) => e as Error);
    expect((err as Error).message).toMatch(/truncated at the output-token cap/i);
  });

  it('scrubs the key from HTTP error bodies and labels the provider', async () => {
    const provider = new ClaudeProvider({
      apiKey: API_KEY,
      fetchImpl: fakeFetch(() => new Response(`bad key ${API_KEY}`, { status: 401 }), []),
    });
    const err = await provider.analyzeBatch(request(), 5000).catch((e: unknown) => e as Error);
    expect((err as Error).message).toContain('Claude API request failed with HTTP 401');
    expect((err as Error).message).not.toContain(API_KEY);
  });

  it('requires a non-empty apiKey', () => {
    expect(() => new ClaudeProvider({ apiKey: '' })).toThrow(/apiKey/);
  });
});
