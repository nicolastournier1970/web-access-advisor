import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { AnalysisController } from './analysis.controller.js';
import { AnalysisService } from './analysis.service.js';
import { ReplayController } from './replay.controller.js';

@Module({
  imports: [EventsModule, SessionsModule, SettingsModule],
  controllers: [AnalysisController, ReplayController],
  providers: [AnalysisService],
  exports: [AnalysisService],
})
export class AnalysisModule {}
