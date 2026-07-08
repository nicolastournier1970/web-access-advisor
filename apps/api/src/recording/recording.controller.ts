/**
 * Recording lifecycle routes (DTOs: @waa/shared recording-api.schema.ts).
 *  POST /api/sessions                              — start (201)
 *  POST /api/sessions/:id/recording/stop
 *  POST /api/sessions/:id/recording/auth/start|end — login segments
 */
import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import {
  startAuthSegmentRequestSchema,
  startRecordingRequestSchema,
} from '@waa/shared';
import type {
  EndAuthSegmentResponse,
  StartAuthSegmentResponse,
  StartRecordingResponse,
  StopRecordingResponse,
} from '@waa/shared';
import { RecordingService } from './recording.service.js';

class StartRecordingDto extends createZodDto(startRecordingRequestSchema) {}
class StartAuthSegmentDto extends createZodDto(startAuthSegmentRequestSchema) {}

@Controller()
export class RecordingController {
  constructor(private readonly recording: RecordingService) {}

  @Post('sessions')
  start(@Body() body: StartRecordingDto): Promise<StartRecordingResponse> {
    return this.recording.start(body);
  }

  @Post('sessions/:id/recording/stop')
  @HttpCode(200)
  stop(@Param('id') id: string): Promise<StopRecordingResponse> {
    return this.recording.stop(id);
  }

  @Post('sessions/:id/recording/auth/start')
  @HttpCode(200)
  startAuthSegment(
    @Param('id') id: string,
    @Body() body: StartAuthSegmentDto,
  ): Promise<StartAuthSegmentResponse> {
    return this.recording.startAuthSegment(id, body);
  }

  @Post('sessions/:id/recording/auth/end')
  @HttpCode(200)
  endAuthSegment(@Param('id') id: string): Promise<EndAuthSegmentResponse> {
    return this.recording.endAuthSegment(id);
  }
}
