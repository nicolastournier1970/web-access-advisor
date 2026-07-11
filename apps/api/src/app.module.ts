import { Module } from '@nestjs/common';
import { EnvModule } from './config/env.js';
import { EngineModule } from './engine/engine.module.js';
import { EventsModule } from './events/events.module.js';
import { HealthController } from './health/health.controller.js';
import { SessionsModule } from './sessions/sessions.module.js';
import { RecordingModule } from './recording/recording.module.js';
import { AnalysisModule } from './analysis/analysis.module.js';
import { BrowsersModule } from './browsers/browsers.module.js';
import { StorageStateModule } from './storage-state/storage-state.module.js';
import { SettingsModule } from './settings/settings.module.js';

@Module({
  imports: [
    EnvModule,
    EngineModule,
    EventsModule,
    SessionsModule,
    RecordingModule,
    AnalysisModule,
    BrowsersModule,
    StorageStateModule,
    SettingsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
