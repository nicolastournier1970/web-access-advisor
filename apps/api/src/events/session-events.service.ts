/**
 * Per-session SSE fan-out (ADR 0003).
 *
 * Design: one channel per session holding
 *   - a plain ring buffer of the last 500 events with monotonic integer ids
 *     starting at 1 (Last-Event-ID replay source), and
 *   - an RxJS Subject for live subscribers.
 * `stream()` synchronously replays buffered events with id > lastEventId and
 * then hands over to the Subject — publish/subscribe both run on the same
 * tick, so no event can fall between replay and live subscription.
 *
 * Heartbeat: every 25 s each subscriber receives a named `ping` event
 * (`event: ping`, no `id:` field). Nest's @Sse API writes MessageEvent
 * fields (event/id/data/retry) and cannot emit raw `: comment` lines, so a
 * named event is the Nest-friendly equivalent: EventSource fires no
 * `onmessage` for unknown named events and, having no id, it never advances
 * the client's Last-Event-ID — it exists purely to keep proxies from idling
 * out the connection.
 */
import { Injectable } from '@nestjs/common';
import type { MessageEvent, OnModuleDestroy } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';
import { sseEventSchema } from '@waa/shared';
import type { SseEvent } from '@waa/shared';

export const RING_BUFFER_SIZE = 500;
export const HEARTBEAT_INTERVAL_MS = 25_000;

interface BufferedEvent {
  id: number;
  event: SseEvent;
}

interface SessionChannel {
  nextId: number;
  buffer: BufferedEvent[];
  live: Subject<BufferedEvent>;
}

function toMessage(buffered: BufferedEvent): MessageEvent {
  return { id: String(buffered.id), data: buffered.event };
}

@Injectable()
export class SessionEventsService implements OnModuleDestroy {
  private readonly channels = new Map<string, SessionChannel>();

  /**
   * Validate and publish an event to a session's stream. Invalid events throw
   * (ZodError) so producer bugs surface at the publish site instead of
   * emitting garbage to clients. Returns the assigned event id.
   */
  publish(sessionId: string, event: SseEvent): number {
    const parsed = sseEventSchema.parse(event);
    const channel = this.channel(sessionId);
    const buffered: BufferedEvent = { id: channel.nextId++, event: parsed };
    channel.buffer.push(buffered);
    if (channel.buffer.length > RING_BUFFER_SIZE) channel.buffer.shift();
    channel.live.next(buffered);
    return buffered.id;
  }

  /**
   * Observable for @Sse: replays buffered events with id > lastEventId, then
   * live events, plus the keep-alive ping. Completes when the session is
   * dropped; teardown (client disconnect) clears the heartbeat timer.
   */
  stream(sessionId: string, lastEventId?: number): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      const channel = this.channel(sessionId);
      const afterId = lastEventId ?? 0;
      for (const buffered of channel.buffer) {
        if (buffered.id > afterId) subscriber.next(toMessage(buffered));
      }
      const live = channel.live.subscribe({
        next: (buffered) => subscriber.next(toMessage(buffered)),
        error: (err: unknown) => subscriber.error(err),
        complete: () => subscriber.complete(),
      });
      const heartbeat = setInterval(() => {
        subscriber.next({ type: 'ping', data: 'ping' });
      }, HEARTBEAT_INTERVAL_MS);
      return () => {
        clearInterval(heartbeat);
        live.unsubscribe();
      };
    });
  }

  /**
   * Drop a session's channel: completes open streams and frees the buffer.
   * Call on session deletion only — republishing to a dropped session starts
   * a fresh channel with ids back at 1, which would confuse reconnecting
   * clients mid-lifecycle.
   */
  dropSession(sessionId: string): void {
    const channel = this.channels.get(sessionId);
    if (!channel) return;
    channel.live.complete();
    this.channels.delete(sessionId);
  }

  onModuleDestroy(): void {
    for (const sessionId of [...this.channels.keys()]) this.dropSession(sessionId);
  }

  private channel(sessionId: string): SessionChannel {
    let channel = this.channels.get(sessionId);
    if (!channel) {
      channel = { nextId: 1, buffer: [], live: new Subject<BufferedEvent>() };
      this.channels.set(sessionId, channel);
    }
    return channel;
  }
}
