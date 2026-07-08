/**
 * Browser/profile detection routes (DTOs: @waa/shared browsers-api.schema.ts).
 */
import { BadRequestException, Controller, Get, HttpCode, Inject, Post, Body } from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import { profileProbeRequestSchema } from '@waa/shared';
import type { ListBrowsersResponse, ProfileProbeResponse } from '@waa/shared';
import { ENGINE, type EngineFacade } from '../engine/engine.module.js';

class ProfileProbeDto extends createZodDto(profileProbeRequestSchema) {}

@Controller('browsers')
export class BrowsersController {
  constructor(@Inject(ENGINE) private readonly engine: EngineFacade) {}

  @Get()
  async list(): Promise<ListBrowsersResponse> {
    return { browsers: await this.engine.detectBrowsers() };
  }

  /** Can this profile actually be launched right now (or is it locked)? */
  @Post('profile-probe')
  @HttpCode(200)
  async probe(@Body() body: ProfileProbeDto): Promise<ProfileProbeResponse> {
    const browsers = await this.engine.detectBrowsers();
    const match = browsers.find((b) => b.name === body.browserName);
    if (!match) throw new BadRequestException(`Unknown browser "${body.browserName}"`);
    if (!match.profilePath) {
      return { status: 'no_profile', message: `${body.browserName} has no detectable profile` };
    }
    return this.engine.probeProfile({
      browserType: body.browserType,
      profilePath: match.profilePath,
    });
  }
}
