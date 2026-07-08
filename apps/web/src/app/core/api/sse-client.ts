/**
 * EventSource wrapper for GET /api/sessions/:id/events (ADR 0003).
 *
 * - Every message's `data` is parsed against @waa/shared `sseEventSchema`;
 *   invalid payloads are dropped with a console.warn (never thrown).
 * - Last-Event-ID resume is native EventSource behaviour: the browser sends
 *   the last seen `id:` field as the `Last-Event-ID` header on reconnect and
 *   the server replays the ring buffer — nothing to do here but not break it
 *   (i.e. reuse the same EventSource across transient errors).
 * - `connectionState` is a signal so zoneless components/stores react natively.
 */
import { Injectable, InjectionToken, inject, signal } from '@angular/core';
import { Subject } from 'rxjs';
import { sseEventSchema, type SseEvent } from '@waa/shared';

export type SseConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed';

/** Structural subset of EventSource used here — lets tests inject a fake. */
export interface EventSourceLike {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onerror: ((event: Event) => void) | null;
  readonly readyState: number;
  close(): void;
}

const READY_STATE_CLOSED = 2;

export const EVENT_SOURCE_FACTORY = new InjectionToken<(url: string) => EventSourceLike>(
  'EVENT_SOURCE_FACTORY',
  { providedIn: 'root', factory: () => (url: string) => new EventSource(url) },
);

@Injectable({ providedIn: 'root' })
export class SseClient {
  private readonly createEventSource = inject(EVENT_SOURCE_FACTORY);
  private source: EventSourceLike | null = null;

  private readonly state = signal<SseConnectionState>('closed');
  readonly connectionState = this.state.asReadonly();

  private readonly eventsSubject = new Subject<SseEvent>();
  /** Validated events; subscribe before connect() to not miss the first ones. */
  readonly events$ = this.eventsSubject.asObservable();

  connect(sessionId: string): void {
    this.disconnect();
    this.state.set('connecting');
    const source = this.createEventSource(
      `/api/sessions/${encodeURIComponent(sessionId)}/events`,
    );
    this.source = source;
    source.onopen = () => this.state.set('open');
    source.onerror = () => {
      // EventSource auto-reconnects (readyState back to CONNECTING) with the
      // Last-Event-ID header; it only gives up when readyState is CLOSED.
      this.state.set(source.readyState === READY_STATE_CLOSED ? 'closed' : 'reconnecting');
    };
    source.onmessage = (message) => this.handleMessage(message);
  }

  disconnect(): void {
    if (this.source) {
      this.source.onopen = null;
      this.source.onmessage = null;
      this.source.onerror = null;
      this.source.close();
      this.source = null;
    }
    this.state.set('closed');
  }

  private handleMessage(message: MessageEvent<string>): void {
    let raw: unknown;
    try {
      raw = JSON.parse(message.data);
    } catch {
      console.warn('[sse] dropped non-JSON event payload', message.data);
      return;
    }
    const parsed = sseEventSchema.safeParse(raw);
    if (!parsed.success) {
      console.warn('[sse] dropped event failing sseEventSchema', raw, parsed.error);
      return;
    }
    this.eventsSubject.next(parsed.data);
  }
}
