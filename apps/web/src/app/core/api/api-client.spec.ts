import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError, FETCH } from './api-client';

type FetchArgs = { url: string; init: RequestInit | undefined };

function fakeResponse(status: number, body: unknown): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  } as Response;
}

function makeClient(responses: Array<{ status: number; body: unknown }>) {
  const calls: FetchArgs[] = [];
  let index = 0;
  const fetchFake = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses[Math.min(index++, responses.length - 1)];
    return fakeResponse(next.status, next.body);
  });
  TestBed.configureTestingModule({
    providers: [{ provide: FETCH, useValue: fetchFake as unknown as typeof fetch }],
  });
  return { client: TestBed.inject(ApiClient), calls };
}

describe('ApiClient', () => {
  it('parses a valid 2xx response with the @waa/shared schema', async () => {
    const { client, calls } = makeClient([
      {
        status: 200,
        body: {
          sessions: [
            {
              sessionId: 's1',
              url: 'https://example.com',
              status: 'recorded',
              startTime: '2026-07-08T10:00:00.000Z',
            },
          ],
        },
      },
    ]);
    const result = await client.listSessions();
    expect(calls[0].url).toBe('/api/sessions');
    expect(result.sessions).toHaveLength(1);
    // schema defaults are applied at the boundary
    expect(result.sessions[0].actionCount).toBe(0);
    expect(result.sessions[0].hasStorageState).toBe(false);
  });

  it('rejects a 2xx body that fails the schema', async () => {
    const { client } = makeClient([{ status: 200, body: { sessions: [{ nope: true }] } }]);
    await expect(client.listSessions()).rejects.toThrow();
  });

  it('parses non-2xx bodies with errorResponseSchema and throws a typed ApiError', async () => {
    const { client } = makeClient([
      {
        status: 409,
        body: {
          statusCode: 409,
          error: 'Conflict',
          message: 'Session s1 has a live worker; stop it first',
        },
      },
    ]);
    const error = await client.deleteSession('s1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).errorName).toBe('Conflict');
    expect((error as ApiError).message).toContain('live worker');
  });

  it('still throws ApiError when the error body is not the envelope', async () => {
    const { client } = makeClient([{ status: 502, body: 'Bad Gateway (proxy)' }]);
    const error = await client.listBrowsers().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(502);
  });

  it('strips null/undefined fields from request bodies before sending', async () => {
    const { client, calls } = makeClient([
      {
        status: 201,
        body: { sessionId: 's2', status: 'recording', url: 'https://example.com' },
      },
    ]);
    await client.startRecording({
      url: 'https://example.com',
      browserType: 'chromium',
      useProfile: false,
      browserName: undefined,
      name: null as unknown as undefined, // simulating a sloppy caller
      reuseStorageStateFrom: undefined,
    });
    const sent = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
    expect(sent).toEqual({
      url: 'https://example.com',
      browserType: 'chromium',
      useProfile: false,
    });
    expect('name' in sent).toBe(false);
    expect('browserName' in sent).toBe(false);
  });

  it('URL-encodes the findStorageState query and session ids in paths', async () => {
    const { client, calls } = makeClient([
      { status: 200, body: { matches: [] } },
      { status: 200, body: { sessionId: 'a b', deleted: true } },
    ]);
    await client.findStorageState('https://example.com/path?x=1');
    expect(calls[0].url).toBe(
      '/api/storage-state/find?url=https%3A%2F%2Fexample.com%2Fpath%3Fx%3D1',
    );
    await client.deleteSession('a b');
    expect(calls[1].url).toBe('/api/sessions/a%20b');
  });
});
