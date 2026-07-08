/**
 * Saved-login (storageState) routes — metadata and behavioural validation
 * only; cookie/token values never leave the server (see @waa/shared
 * storage-state-api.schema.ts).
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import path from 'node:path';
import { createZodDto } from 'nestjs-zod';
import { findStorageStateQuerySchema, validateStorageStateRequestSchema } from '@waa/shared';
import type {
  FindStorageStateResponse,
  StorageStateStatusResponse,
  ValidateStorageStateResponse,
} from '@waa/shared';
import { ENGINE, type EngineFacade } from '../engine/engine.module.js';
import { ENV, type Env } from '../config/env.js';
import { SessionStoreService } from '../sessions/session-store.service.js';

class ValidateStorageStateDto extends createZodDto(validateStorageStateRequestSchema) {}
class FindStorageStateQueryDto extends createZodDto(findStorageStateQuerySchema) {}

@Controller()
export class StorageStateController {
  constructor(
    @Inject(ENGINE) private readonly engine: EngineFacade,
    @Inject(ENV) private readonly env: Env,
    private readonly store: SessionStoreService,
  ) {}

  @Get('sessions/:id/storage-state/status')
  async status(@Param('id') id: string): Promise<StorageStateStatusResponse> {
    if (!this.store.exists(id)) throw new NotFoundException(`Unknown session ${id}`);
    const result = await this.engine.getStorageStateStatus(this.storageStatePath(id));
    return { sessionId: id, ...result };
  }

  /** Behavioural probe: load the saved state, navigate, verify we're not walled. */
  @Post('sessions/:id/storage-state/validate')
  @HttpCode(200)
  async validate(
    @Param('id') id: string,
    @Body() body: ValidateStorageStateDto,
  ): Promise<ValidateStorageStateResponse> {
    const summary = await this.store.get(id);
    if (!summary) throw new NotFoundException(`Unknown session ${id}`);
    const authConfig = await this.engine.loadAuthDomainsConfig(
      path.resolve(this.env.AUTH_DOMAINS_CONFIG),
    );
    const result = await this.engine.validateStorageState({
      storageStatePath: this.storageStatePath(id),
      probeUrl: body.probeUrl ?? summary.url,
      ...(body.successSelector !== undefined ? { successSelector: body.successSelector } : {}),
      ...(body.timeoutMs !== undefined ? { timeoutMs: body.timeoutMs } : {}),
      isAuthUrl: (url: string) => this.engine.isAuthUrl(url, authConfig),
    });
    return {
      sessionId: id,
      ok: result.ok,
      elapsedMs: result.elapsedMs,
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
    };
  }

  /**
   * Sessions whose saved login covers the target's host, newest first.
   * Shallow match only (existence + host) — deep validation happens at reuse
   * time (POST /api/sessions with reuseStorageStateFrom).
   */
  @Get('storage-state/find')
  async find(@Query() query: FindStorageStateQueryDto): Promise<FindStorageStateResponse> {
    const targetHost = new URL(query.url).hostname.toLowerCase();
    const sessions = await this.store.list();
    const matches = sessions
      .filter((s) => s.hasStorageState)
      .filter((s) => {
        try {
          return new URL(s.url).hostname.toLowerCase() === targetHost;
        } catch {
          return false;
        }
      })
      .map((s) => ({
        sessionId: s.sessionId,
        url: s.url,
        savedAt: s.endTime ?? s.startTime,
        validated: false,
      }));
    return { matches };
  }

  private storageStatePath(id: string): string {
    return path.join(this.store.sessionDir(id), 'storageState.json');
  }
}
