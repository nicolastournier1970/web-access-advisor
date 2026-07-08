import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module.js';
import { SessionsController } from './sessions.controller.js';
import { SessionStoreService } from './session-store.service.js';
import { SessionWorkerRegistry } from './session-worker.registry.js';

@Module({
  imports: [EventsModule],
  controllers: [SessionsController],
  providers: [SessionStoreService, SessionWorkerRegistry],
  exports: [SessionStoreService, SessionWorkerRegistry],
})
export class SessionsModule {}
