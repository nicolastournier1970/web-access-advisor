/**
 * Session listing, detail, deletion, and artefact serving.
 * Response shapes: @waa/shared sessions-api.schema.ts.
 */
import {
  ConflictException,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import type { DeleteSessionResponse, ListSessionsResponse, SessionSummary } from '@waa/shared';
import { SessionStoreService } from './session-store.service.js';
import { SessionWorkerRegistry } from './session-worker.registry.js';
import { SessionEventsService } from '../events/session-events.service.js';

/** The only step files that exist; anything else is 404, never a path lookup. */
const STEP_FILES: Record<string, string> = {
  'snapshot.html': 'text/html; charset=utf-8',
  'axe_results.json': 'application/json; charset=utf-8',
  'axe_context.json': 'application/json; charset=utf-8',
  'screenshot.png': 'image/png',
};

@Controller('sessions')
export class SessionsController {
  constructor(
    private readonly store: SessionStoreService,
    private readonly workers: SessionWorkerRegistry,
    private readonly events: SessionEventsService,
  ) {}

  @Get()
  async list(): Promise<ListSessionsResponse> {
    return { sessions: await this.store.list() };
  }

  @Get(':id')
  async get(@Param('id') id: string): Promise<SessionSummary> {
    const summary = await this.store.get(id);
    if (!summary) throw new NotFoundException(`Unknown session ${id}`);
    return summary;
  }

  @Delete(':id')
  async delete(@Param('id') id: string): Promise<DeleteSessionResponse> {
    if (this.workers.has(id)) {
      throw new ConflictException(`Session ${id} has a live worker; stop it first`);
    }
    const deleted = await this.store.delete(id);
    if (!deleted) throw new NotFoundException(`Unknown session ${id}`);
    this.events.dropSession(id);
    return { sessionId: id, deleted: true };
  }

  @Get(':id/recording')
  downloadRecording(@Param('id') id: string, @Res() res: Response): void {
    const file = path.join(this.store.sessionDir(id), 'recording.json');
    if (!existsSync(file)) throw new NotFoundException(`Session ${id} has no recording`);
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="${id}-recording.json"`);
    createReadStream(file).pipe(res);
  }

  @Get(':id/snapshots/:step/:file')
  serveSnapshotFile(
    @Param('id') id: string,
    @Param('step') step: string,
    @Param('file') file: string,
    @Res() res: Response,
  ): void {
    const contentType = STEP_FILES[file];
    const stepNum = Number(step);
    if (!contentType || !Number.isInteger(stepNum) || stepNum < 0) {
      throw new NotFoundException('Unknown snapshot file');
    }
    const stepDir = `step_${String(stepNum).padStart(3, '0')}`;
    const filePath = path.join(this.store.sessionDir(id), stepDir, file);
    if (!existsSync(filePath)) throw new NotFoundException('Snapshot file not found');
    res.setHeader('content-type', contentType);
    createReadStream(filePath).pipe(res);
  }
}
