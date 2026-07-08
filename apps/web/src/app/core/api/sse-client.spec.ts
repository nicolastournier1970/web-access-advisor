import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SseEvent } from '@waa/shared';
import { EVENT_SOURCE_FACTORY, SseClient, type EventSourceLike } from './sse-client';

class FakeEventSource implements EventSourceLike {
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = 0;
  closed = false;

  constructor(readonly url: string) {}

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  emitOpen(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }

  emitData(data: string): void {
    this.onmessage?.(new MessageEvent('message', { data }));
  }

  emitError(readyState: number): void {
    this.readyState = readyState;
    this.onerror?.(new Event('error'));
  }
}

function makeClient() {
  const sources: FakeEventSource[] = [];
  TestBed.configureTestingModule({
    providers: [
      {
        provide: EVENT_SOURCE_FACTORY,
        useValue: (url: string) => {
          const source = new FakeEventSource(url);
          sources.push(source);
          return source;
        },
      },
    ],
  });
  return { client: TestBed.inject(SseClient), sources };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SseClient', () => {
  it('connects to the session events URL and tracks connection state', () => {
    const { client, sources } = makeClient();
    expect(client.connectionState()).toBe('closed');
    client.connect('sess-1');
    expect(sources[0].url).toBe('/api/sessions/sess-1/events');
    expect(client.connectionState()).toBe('connecting');
    sources[0].emitOpen();
    expect(client.connectionState()).toBe('open');
    sources[0].emitError(0); // browser auto-reconnect (CONNECTING)
    expect(client.connectionState()).toBe('reconnecting');
    sources[0].emitError(2); // gave up (CLOSED)
    expect(client.connectionState()).toBe('closed');
  });

  it('emits events whose data parses against sseEventSchema', () => {
    const { client, sources } = makeClient();
    const received: SseEvent[] = [];
    client.events$.subscribe((event) => received.push(event));
    client.connect('sess-1');
    sources[0].emitData(JSON.stringify({ type: 'session.status', status: 'recording' }));
    expect(received).toEqual([{ type: 'session.status', status: 'recording' }]);
  });

  it('drops invalid events with a console.warn and keeps the stream alive', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { client, sources } = makeClient();
    const received: SseEvent[] = [];
    client.events$.subscribe((event) => received.push(event));
    client.connect('sess-1');
    sources[0].emitData('not-json{');
    sources[0].emitData(JSON.stringify({ type: 'recording.action' })); // missing fields
    sources[0].emitData(JSON.stringify({ type: 'unknown.event' }));
    expect(received).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(3);
    sources[0].emitData(JSON.stringify({ type: 'session.status', status: 'recorded' }));
    expect(received).toHaveLength(1);
  });

  it('disconnect closes the source; a new connect replaces the old one', () => {
    const { client, sources } = makeClient();
    client.connect('sess-1');
    client.disconnect();
    expect(sources[0].closed).toBe(true);
    expect(client.connectionState()).toBe('closed');
    client.connect('sess-2');
    expect(sources).toHaveLength(2);
    expect(sources[1].url).toBe('/api/sessions/sess-2/events');
  });
});
