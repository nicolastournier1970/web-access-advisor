import { Module } from '@nestjs/common';
import { EnvModule } from './config/env.js';
import { EventsModule } from './events/events.module.js';
import { HealthController } from './health/health.controller.js';

/**
 * Skeleton root module (rewrite Phase 3). Engine-dependent modules
 * (sessions, recording, replay, analysis, browsers, storage-state, llm)
 * are added once @waa/core lands; they import EventsModule's
 * SessionEventsService to publish and inject ENV for configuration.
 */
@Module({
  imports: [EnvModule, EventsModule],
  controllers: [HealthController],
})
export class AppModule {}
