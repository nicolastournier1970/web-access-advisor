/**
 * Runtime LLM settings routes (DTOs: @waa/shared settings-api.schema.ts).
 *  GET /api/settings  — provider selection + per-provider status (never keys)
 *  PUT /api/settings  — change selection and/or a provider's key/model/baseUrl
 * PUT is disabled in the packaged app (Electron main owns writes via IPC).
 */
import { Body, Controller, Get, Put } from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import { updateSettingsRequestSchema } from '@waa/shared';
import type { SettingsResponse } from '@waa/shared';
import { SettingsService } from './settings.service.js';

class UpdateSettingsDto extends createZodDto(updateSettingsRequestSchema) {}

@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  async get(): Promise<SettingsResponse> {
    return this.settings.status();
  }

  @Put()
  async put(@Body() body: UpdateSettingsDto): Promise<SettingsResponse> {
    return this.settings.update(body);
  }
}
