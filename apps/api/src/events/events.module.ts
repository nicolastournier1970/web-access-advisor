import { Module } from '@nestjs/common';
import { EventsController } from './events.controller.js';
import { SessionEventsService } from './session-events.service.js';

/**
 * SSE plumbing (ADR 0003). Exports SessionEventsService so the upcoming
 * engine-facing modules (sessions/recording/replay/analysis) can publish
 * their events into the per-session streams.
 */
@Module({
  controllers: [EventsController],
  providers: [SessionEventsService],
  exports: [SessionEventsService],
})
export class EventsModule {}
