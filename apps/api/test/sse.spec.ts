import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sseEventSchema } from '@waa/shared';
import type { SseEvent } from '@waa/shared';
import { createApp } from '../dist/app.factory.js';
import { SessionEventsService } from '../dist/events/session-events.service.js';
import { readSseMessages } from './sse-reader.js';

describe('GET /api/sessions/:id/events (SSE)', () => {
  let app: INestApplication;
  let events: SessionEventsService;
  let port: number;

  const published: SseEvent[] = [
    { type: 'session.status', status: 'recording' },
    { type: 'recording.navigated', url: 'https://example.com/', step: 1 },
    { type: 'session.status', status: 'recorded' },
  ];

  beforeAll(async () => {
    // The SSE endpoint 404s unknown sessions; register the test session ids
    // on disk (existence = session.json or recording.json in SNAPSHOTS_DIR).
    const snapshotsDir = await mkdtemp(path.join(os.tmpdir(), 'waa-sse-test-'));
    process.env.SNAPSHOTS_DIR = snapshotsDir; // read once by getEnv() at createApp
    for (const id of ['sess-replay', 'sess-live', 'sess-ring', 'sess-drop']) {
      await mkdir(path.join(snapshotsDir, id), { recursive: true });
      await writeFile(path.join(snapshotsDir, id, 'recording.json'), '{}');
    }

    app = await createApp({ logger: false });
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as AddressInfo).port;
    events = app.get(SessionEventsService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('replays buffered events as id/data messages with monotonic ids from 1', async () => {
    for (const event of published) events.publish('sess-replay', event);

    const messages = await readSseMessages({
      port,
      path: '/api/sessions/sess-replay/events',
      count: 3,
    });

    expect(messages.map((m) => m.id)).toEqual(['1', '2', '3']);
    messages.forEach((message, i) => {
      const event = sseEventSchema.parse(JSON.parse(message.data));
      expect(event).toEqual(published[i]);
    });
  });

  it('Last-Event-ID: 1 replays only events 2..3', async () => {
    const messages = await readSseMessages({
      port,
      path: '/api/sessions/sess-replay/events',
      lastEventId: '1',
      count: 2,
    });

    expect(messages.map((m) => m.id)).toEqual(['2', '3']);
    expect(JSON.parse(messages[1]!.data)).toEqual(published[2]);
  });

  it('delivers live events published after subscription', async () => {
    const message = await readSseMessages({
      port,
      path: '/api/sessions/sess-live/events',
      count: 1,
      onOpen: () => events.publish('sess-live', { type: 'session.status', status: 'analyzing' }),
    });

    expect(message[0]!.id).toBe('1');
    expect(JSON.parse(message[0]!.data)).toEqual({ type: 'session.status', status: 'analyzing' });
  });

  it('publish rejects events that fail sseEventSchema', () => {
    expect(() =>
      events.publish('sess-replay', { type: 'not-a-real-event' } as unknown as SseEvent),
    ).toThrow();
    // the invalid event must not have consumed an id or entered the buffer
    const id = events.publish('sess-replay', { type: 'session.status', status: 'analyzed' });
    expect(id).toBe(4);
  });

  it('keeps only the last 500 events in the ring buffer', async () => {
    for (let i = 0; i < 502; i++) {
      events.publish('sess-ring', { type: 'session.status', status: 'analyzing' });
    }
    const messages = await readSseMessages({
      port,
      path: '/api/sessions/sess-ring/events',
      count: 500,
    });
    expect(messages[0]!.id).toBe('3');
    expect(messages.at(-1)!.id).toBe('502');
  });

  it('dropSession completes open streams', async () => {
    await expect(
      readSseMessages({
        port,
        path: '/api/sessions/sess-drop/events',
        count: 1,
        onOpen: () => events.dropSession('sess-drop'),
      }),
    ).rejects.toThrow(/stream ended/);
  });
});
