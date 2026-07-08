/**
 * Analysis lifecycle: starts the engine's replay+analysis run, holds its
 * AnalyzeControl in the worker registry (pause-for-login continue/cancel act
 * on it), maps engine events 1:1 onto the SSE union, and persists results.
 * One analysis per session at a time; analysisId === sessionId.
 */
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { analysisResultSchema } from '@waa/shared';
import type { AnalysisResult, StartAnalysisRequest, StartAnalysisResponse } from '@waa/shared';
import type { AnalyzeEvent, LlmProvider } from '@waa/core';
import { ENGINE, type EngineFacade } from '../engine/engine.module.js';
import { ENV, type Env } from '../config/env.js';
import { SessionStoreService } from '../sessions/session-store.service.js';
import { SessionWorkerRegistry, type SessionWorker } from '../sessions/session-worker.registry.js';
import { SessionEventsService } from '../events/session-events.service.js';

@Injectable()
export class AnalysisService {
  constructor(
    @Inject(ENGINE) private readonly engine: EngineFacade,
    @Inject(ENV) private readonly env: Env,
    private readonly store: SessionStoreService,
    private readonly workers: SessionWorkerRegistry,
    private readonly events: SessionEventsService,
  ) {}

  async start(sessionId: string, request: StartAnalysisRequest): Promise<StartAnalysisResponse> {
    const summary = await this.store.get(sessionId);
    if (!summary) throw new NotFoundException(`Unknown session ${sessionId}`);
    if (this.workers.has(sessionId)) {
      throw new ConflictException(`Session ${sessionId} already has a live worker`);
    }

    const sessionDir = this.store.sessionDir(sessionId);
    const recordingPath = path.join(sessionDir, 'recording.json');
    if (!existsSync(recordingPath)) {
      throw new ConflictException(`Session ${sessionId} has no recording to analyze`);
    }

    const recording = await this.engine.loadRecordingFile(recordingPath);
    const authConfig = await this.engine.loadAuthDomainsConfig(
      path.resolve(this.env.AUTH_DOMAINS_CONFIG),
    );
    const llmProvider = this.resolveProvider(request.llmProvider);

    const control = this.engine.runAnalysis({
      sessionId,
      sessionDir,
      recording,
      browserType: summary.browserType === 'firefox' ? 'firefox' : 'chromium',
      ...(summary.browserName !== undefined ? { browserName: summary.browserName } : {}),
      useProfile: summary.useProfile ?? false,
      headless: this.env.PLAYWRIGHT_HEADLESS,
      captureScreenshots: request.captureScreenshots,
      staticSectionMode: request.staticSectionMode,
      llmProvider,
      llmBatchTimeoutMs: 300_000,
      authConfig,
      authPauseTimeoutMs: this.env.REPLAY_AUTH_TIMEOUT_MS,
      onEvent: (event) => this.onAnalyzeEvent(sessionId, event),
    });

    this.workers.register(sessionId, { kind: 'analysis', control, lastAuthState: 'running' });
    await this.store.patch(sessionId, { status: 'analyzing' });
    this.events.publish(sessionId, { type: 'session.status', status: 'analyzing' });

    // Fire and forget: progress streams over SSE; the result settles the store.
    void control.result.then(async (result) => {
      this.workers.release(sessionId);
      await this.store.patch(sessionId, { status: result.success ? 'analyzed' : 'failed' });
      if (result.success) {
        this.events.publish(sessionId, {
          type: 'analysis.complete',
          analysisId: sessionId,
          snapshotCount: result.snapshotCount,
          warnings: result.warnings ?? [],
        });
      } else {
        this.events.publish(sessionId, {
          type: 'analysis.error',
          message: result.error ?? 'Analysis failed',
        });
      }
      this.events.publish(sessionId, {
        type: 'session.status',
        status: result.success ? 'analyzed' : 'failed',
      });
    });

    return { sessionId, analysisId: sessionId, status: 'analyzing', phase: 'replaying-actions' };
  }

  async getResult(sessionId: string): Promise<AnalysisResult> {
    const file = path.join(this.store.sessionDir(sessionId), 'analysis.json');
    if (!existsSync(file)) throw new NotFoundException(`Session ${sessionId} has no analysis`);
    return analysisResultSchema.parse(JSON.parse(await readFile(file, 'utf-8')));
  }

  requireAnalysis(sessionId: string): Extract<SessionWorker, { kind: 'analysis' }> {
    const worker = this.workers.get(sessionId);
    if (!worker || worker.kind !== 'analysis') {
      throw new ConflictException(`Session ${sessionId} has no live analysis`);
    }
    return worker;
  }

  private resolveProvider(requested: StartAnalysisRequest['llmProvider']): LlmProvider | null {
    const choice = requested ?? this.env.LLM_PROVIDER;
    switch (choice) {
      case 'none':
        return null;
      case 'stub':
        return new this.engine.StubProvider();
      case 'gemini': {
        if (!this.env.GEMINI_API_KEY) {
          throw new BadRequestException('GEMINI_API_KEY is not configured; use llmProvider "stub" or "none"');
        }
        return new this.engine.GeminiProvider({
          apiKey: this.env.GEMINI_API_KEY,
          ...(this.env.HTTPS_PROXY !== undefined ? { proxyUrl: this.env.HTTPS_PROXY } : {}),
        });
      }
    }
  }

  private onAnalyzeEvent(sessionId: string, event: AnalyzeEvent): void {
    switch (event.type) {
      case 'progress':
        this.events.publish(sessionId, {
          type: 'analysis.progress',
          phase: event.phase,
          message: event.message,
          ...(event.currentStep !== undefined ? { currentStep: event.currentStep } : {}),
          ...(event.totalSteps !== undefined ? { totalSteps: event.totalSteps } : {}),
          ...(event.snapshotCount !== undefined ? { snapshotCount: event.snapshotCount } : {}),
          ...(event.batchCurrent !== undefined ? { batchCurrent: event.batchCurrent } : {}),
          ...(event.batchTotal !== undefined ? { batchTotal: event.batchTotal } : {}),
        });
        return;
      case 'auth-required':
        void this.store.patch(sessionId, { status: 'awaiting-auth' });
        this.events.publish(sessionId, { type: 'session.status', status: 'awaiting-auth' });
        this.events.publish(sessionId, {
          type: 'replay.auth_required',
          ...(event.checkpointId !== undefined ? { checkpointId: event.checkpointId } : {}),
          reason: event.reason,
          loginUrl: event.loginUrl,
          pausedAtStep: event.pausedAtStep,
          timeoutAt: event.timeoutAt,
        });
        return;
      case 'auth-validating':
        this.events.publish(sessionId, { type: 'replay.auth_validating' });
        return;
      case 'auth-resolved':
        void this.store.patch(sessionId, { status: 'analyzing' });
        this.events.publish(sessionId, { type: 'session.status', status: 'analyzing' });
        this.events.publish(sessionId, {
          type: 'replay.auth_resolved',
          resumedAtStep: event.resumedAtStep,
          storageStateSaved: event.storageStateSaved,
        });
        return;
      case 'auth-failed':
        this.events.publish(sessionId, { type: 'replay.auth_failed', reason: event.reason });
        return;
      case 'auth-state': {
        const worker = this.workers.get(sessionId);
        if (worker?.kind === 'analysis') worker.lastAuthState = event.state;
        this.events.publish(sessionId, { type: 'replay.auth_state', state: event.state });
        return;
      }
    }
  }
}
