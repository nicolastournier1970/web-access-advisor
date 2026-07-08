/**
 * GET /api/health — liveness + build/provider info, shaped by
 * @waa/shared's healthResponseSchema.
 */
import { readFileSync } from 'node:fs';
import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { HealthResponse } from '@waa/shared';
import { ENV } from '../config/env.js';
import type { Env } from '../config/env.js';

/**
 * Version comes from apps/api/package.json. Both src/health/ and dist/health/
 * sit two levels below apps/api, so the relative URL is stable across builds.
 */
function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const VERSION = readPackageVersion();

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(@Inject(ENV) private readonly env: Env) {}

  @Get()
  @ApiOkResponse({ description: 'Service is up; body matches healthResponseSchema.' })
  getHealth(): HealthResponse {
    return {
      status: 'ok',
      version: VERSION,
      uptimeSeconds: Math.round(process.uptime() * 1000) / 1000,
      llmProvider: this.env.LLM_PROVIDER,
    };
  }
}
