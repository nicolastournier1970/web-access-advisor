import { describe, it, expect } from 'vitest';
import type { LlmBatchRequest } from '../engine-types.js';
import { OllamaProvider } from './ollama.provider.js';

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

function ollamaBody(text: string, doneReason = 'stop'): string {
  return JSON.stringify({ message: { content: text }, done_reason: doneReason });
}

describe('OllamaProvider.analyzeBatch', () => {
  it('POSTs /api/chat with format json, num_ctx, stream false, and no auth header', async () => {
    const calls: CapturedCall[] = [];
    const provider = new OllamaProvider({
      fetchImpl: fakeFetch(() => new Response(ollamaBody(ANALYSIS_JSON), { status: 200 }), calls),
    });
    const analysis = await provider.analyzeBatch(request(), 5000);

    const call = calls[0]!;
    expect(call.url).toBe('http://localhost:11434/api/chat');
    expect((call.init.headers as Record<string, string>)['authorization']).toBeUndefined();
    const body = JSON.parse(String(call.init.body));
    expect(body.model).toBe('llama3.1');
    expect(body.stream).toBe(false);
    expect(body.format).toBe('json');
    expect(typeof body.options.num_ctx).toBe('number');
    expect(analysis.summary).toBe('ok');
  });

  it('does NOT route a loopback host through a configured proxy', async () => {
    const calls: CapturedCall[] = [];
    const provider = new OllamaProvider({
      proxyUrl: 'http://corp-proxy:8080',
      fetchImpl: fakeFetch(() => new Response(ollamaBody(ANALYSIS_JSON), { status: 200 }), calls),
    });
    await provider.analyzeBatch(request(), 5000);
    // Loopback → base class skips the proxy dispatcher.
    expect(calls[0]!.init.dispatcher).toBeUndefined();
  });

  it('honors a custom baseUrl', async () => {
    const calls: CapturedCall[] = [];
    const provider = new OllamaProvider({
      baseUrl: 'http://ollama.internal:11434/',
      fetchImpl: fakeFetch(() => new Response(ollamaBody(ANALYSIS_JSON), { status: 200 }), calls),
    });
    await provider.analyzeBatch(request(), 5000);
    expect(calls[0]!.url).toBe('http://ollama.internal:11434/api/chat');
  });
});
