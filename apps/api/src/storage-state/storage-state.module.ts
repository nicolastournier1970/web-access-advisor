import { Module } from '@nestjs/common';
import { SessionsModule } from '../sessions/sessions.module.js';
import { StorageStateController } from './storage-state.controller.js';

@Module({
  imports: [SessionsModule],
  controllers: [StorageStateController],
})
export class StorageStateModule {}
