import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { RecordingController } from './recording.controller.js';
import { RecordingService } from './recording.service.js';

@Module({
  imports: [EventsModule, SessionsModule],
  controllers: [RecordingController],
  providers: [RecordingService],
})
export class RecordingModule {}
