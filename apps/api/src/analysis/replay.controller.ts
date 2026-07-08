/**
 * Pause-for-login control routes (docs/rewrite-plan.md §6). There is no
 * standalone replay endpoint — these act on the replay embedded in the
 * running analysis (see @waa/shared analysis-api.schema.ts).
 */
import { Controller, HttpCode, Param, Post } from '@nestjs/common';
import type { CancelReplayAuthResponse, ContinueReplayAuthResponse } from '@waa/shared';
import { AnalysisService } from './analysis.service.js';

@Controller('sessions/:id/replay/auth')
export class ReplayController {
  constructor(private readonly analysis: AnalysisService) {}

  /** The user says "I've signed in" — validate the live page and resume. */
  @Post('continue')
  @HttpCode(200)
  async continue(@Param('id') id: string): Promise<ContinueReplayAuthResponse> {
    const worker = this.analysis.requireAnalysis(id);
    const outcome = await worker.control.continueAuth();
    return {
      sessionId: id,
      state: worker.lastAuthState,
      ...(outcome.ok ? {} : { reason: outcome.reason ?? 'validation-failed' }),
    };
  }

  /** Abort the paused replay; partial snapshots are kept. */
  @Post('cancel')
  @HttpCode(200)
  async cancel(@Param('id') id: string): Promise<CancelReplayAuthResponse> {
    const worker = this.analysis.requireAnalysis(id);
    await worker.control.cancelAuth();
    return { sessionId: id, state: worker.lastAuthState };
  }
}
