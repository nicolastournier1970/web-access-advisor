/**
 * Analysis routes (DTOs: @waa/shared analysis-api.schema.ts).
 *  POST /api/sessions/:id/analysis — 202; progress streams over SSE
 *  GET  /api/sessions/:id/analysis — persisted result
 */
import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import { startAnalysisRequestSchema } from '@waa/shared';
import type { AnalysisResult, StartAnalysisResponse } from '@waa/shared';
import { AnalysisService } from './analysis.service.js';

class StartAnalysisDto extends createZodDto(startAnalysisRequestSchema) {}

@Controller('sessions/:id/analysis')
export class AnalysisController {
  constructor(private readonly analysis: AnalysisService) {}

  @Post()
  @HttpCode(202)
  start(@Param('id') id: string, @Body() body: StartAnalysisDto): Promise<StartAnalysisResponse> {
    return this.analysis.start(id, body);
  }

  @Get()
  getResult(@Param('id') id: string): Promise<AnalysisResult> {
    return this.analysis.getResult(id);
  }
}
