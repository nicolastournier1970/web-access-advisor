/**
 * GET /api/sessions/:id/events — the single realtime stream per session
 * (ADR 0003). Client commands are plain POSTs on other modules; this endpoint
 * only pushes server→client events typed by @waa/shared's sseEventSchema.
 */
import { Controller, Headers, Inject, NotFoundException, Param, Sse } from '@nestjs/common';
import type { MessageEvent } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { ApiTags } from '@nestjs/swagger';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { SessionEventsService } from './session-events.service.js';
import { ENV, type Env } from '../config/env.js';

@ApiTags('events')
@Controller('sessions')
export class EventsController {
  private readonly snapshotsRoot: string;

  constructor(
    private readonly events: SessionEventsService,
    @Inject(ENV) env: Env,
  ) {
    this.snapshotsRoot = path.resolve(env.SNAPSHOTS_DIR);
  }

  /**
   * EventSource reconnects send the last seen `id:` as the Last-Event-ID
   * header; events with id > Last-Event-ID are replayed from the ring buffer.
   *
   * Existence is checked against the disk-backed session store's layout
   * directly (not SessionStoreService) to keep EventsModule import-cycle-free:
   * SessionsModule already imports EventsModule for dropSession().
   */
  @Sse(':id/events')
  streamSessionEvents(
    @Param('id') sessionId: string,
    @Headers('last-event-id') lastEventId?: string,
  ): Observable<MessageEvent> {
    const dir = path.join(this.snapshotsRoot, sessionId);
    const known =
      existsSync(path.join(dir, 'session.json')) || existsSync(path.join(dir, 'recording.json'));
    if (!known) throw new NotFoundException(`Unknown session ${sessionId}`);
    const afterId =
      lastEventId !== undefined && /^\d+$/.test(lastEventId) ? Number(lastEventId) : undefined;
    return this.events.stream(sessionId, afterId);
  }
}
