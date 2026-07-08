/**
 * GET /api/sessions/:id/events — the single realtime stream per session
 * (ADR 0003). Client commands are plain POSTs on other modules; this endpoint
 * only pushes server→client events typed by @waa/shared's sseEventSchema.
 */
import { Controller, Headers, Param, Sse } from '@nestjs/common';
import type { MessageEvent } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { ApiTags } from '@nestjs/swagger';
import { SessionEventsService } from './session-events.service.js';

@ApiTags('events')
@Controller('sessions')
export class EventsController {
  constructor(private readonly events: SessionEventsService) {}

  /**
   * EventSource reconnects send the last seen `id:` as the Last-Event-ID
   * header; events with id > Last-Event-ID are replayed from the ring buffer.
   */
  @Sse(':id/events')
  streamSessionEvents(
    @Param('id') sessionId: string,
    @Headers('last-event-id') lastEventId?: string,
  ): Observable<MessageEvent> {
    const afterId =
      lastEventId !== undefined && /^\d+$/.test(lastEventId) ? Number(lastEventId) : undefined;
    return this.events.stream(sessionId, afterId);
  }
}
