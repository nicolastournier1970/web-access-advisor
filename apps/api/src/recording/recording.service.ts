/**
 * Recording lifecycle: owns the RecorderHandle via the worker registry and
 * maps engine RecorderEvents 1:1 onto the SSE union.
 */
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type {
  EndAuthSegmentResponse,
  StartAuthSegmentRequest,
  StartAuthSegmentResponse,
  StartRecordingRequest,
  StartRecordingResponse,
  StopRecordingResponse,
} from '@waa/shared';
import type { RecorderEvent } from '@waa/core';
import { ENGINE, type EngineFacade } from '../engine/engine.module.js';
import { ENV, type Env } from '../config/env.js';
import { SessionStoreService } from '../sessions/session-store.service.js';
import { SessionWorkerRegistry, type SessionWorker } from '../sessions/session-worker.registry.js';
import { SessionEventsService } from '../events/session-events.service.js';

@Injectable()
export class RecordingService {
  constructor(
    @Inject(ENGINE) private readonly engine: EngineFacade,
    @Inject(ENV) private readonly env: Env,
    private readonly store: SessionStoreService,
    private readonly workers: SessionWorkerRegistry,
    private readonly events: SessionEventsService,
  ) {}

  async start(request: StartRecordingRequest): Promise<StartRecordingResponse> {
    const sessionId = `session_${Date.now()}_${randomBytes(5).toString('hex')}`;
    const sessionDir = this.store.sessionDir(sessionId);

    let reuseStorageStatePath: string | undefined;
    if (request.reuseStorageStateFrom) {
      reuseStorageStatePath = await this.validateReusableState(
        request.reuseStorageStateFrom,
        request.url,
      );
    }

    const authConfig = await this.engine.loadAuthDomainsConfig(
      path.resolve(this.env.AUTH_DOMAINS_CONFIG),
    );

    await this.store.create({
      sessionId,
      ...(request.name !== undefined ? { name: request.name } : {}),
      url: request.url,
      status: 'recording',
      startTime: new Date().toISOString(),
      actionCount: 0,
      authCheckpointCount: 0,
      recordingFormatVersion: 2,
      browserType: request.browserType,
      ...(request.browserName !== undefined ? { browserName: request.browserName } : {}),
      useProfile: request.useProfile,
    });

    try {
      const recorder = await this.engine.createRecorder({
        sessionId,
        url: request.url,
        browserType: request.browserType,
        ...(request.browserName !== undefined ? { browserName: request.browserName } : {}),
        useProfile: request.useProfile,
        headless: this.env.PLAYWRIGHT_HEADLESS,
        sessionDir,
        ...(reuseStorageStatePath !== undefined ? { reuseStorageStatePath } : {}),
        authConfig,
        onEvent: (event) => this.onRecorderEvent(sessionId, event),
      });
      this.workers.register(sessionId, { kind: 'recording', recorder });
    } catch (err) {
      await this.store.patch(sessionId, { status: 'failed' });
      throw err;
    }

    this.events.publish(sessionId, { type: 'session.status', status: 'recording' });
    return { sessionId, status: 'recording', url: request.url };
  }

  async stop(sessionId: string): Promise<StopRecordingResponse> {
    const worker = this.requireRecording(sessionId);
    const recording = await worker.recorder.stop();
    this.workers.release(sessionId);
    await this.store.patch(sessionId, {
      status: 'recorded',
      actionCount: recording.actions.length,
      authCheckpointCount: recording.authCheckpoints.length,
      endTime: recording.endTime ?? new Date().toISOString(),
    });
    this.events.publish(sessionId, { type: 'session.status', status: 'recorded' });
    return {
      sessionId,
      status: 'recorded',
      actionCount: recording.actions.length,
      actions: recording.actions,
      authCheckpoints: recording.authCheckpoints,
      storageStateSaved: this.store.exists(sessionId)
        ? (await this.store.get(sessionId))?.hasStorageState === true
        : false,
    };
  }

  async startAuthSegment(
    sessionId: string,
    request: StartAuthSegmentRequest,
  ): Promise<StartAuthSegmentResponse> {
    const worker = this.requireRecording(sessionId);
    const result = await worker.recorder.startAuthSegment(request.reason, request.fromStep);
    return {
      checkpointId: result.checkpoint.id,
      afterStep: result.checkpoint.afterStep,
      discardedActions: result.discardedActions,
    };
  }

  async endAuthSegment(sessionId: string): Promise<EndAuthSegmentResponse> {
    const worker = this.requireRecording(sessionId);
    const result = await worker.recorder.endAuthSegment();
    return {
      checkpointId: result.checkpoint.id,
      storageStateSaved: result.storageStateSaved,
      ...(result.postLoginUrl !== undefined ? { postLoginUrl: result.postLoginUrl } : {}),
    };
  }

  private onRecorderEvent(sessionId: string, event: RecorderEvent): void {
    switch (event.type) {
      case 'action':
        this.events.publish(sessionId, {
          type: 'recording.action',
          action: event.action,
          actionCount: event.actionCount,
        });
        return;
      case 'navigated':
        this.events.publish(sessionId, {
          type: 'recording.navigated',
          url: event.url,
          ...(event.step !== undefined ? { step: event.step } : {}),
        });
        return;
      case 'auth-suspected':
        this.events.publish(sessionId, {
          type: 'recording.auth_suspected',
          reason: event.reason,
          url: event.url,
          suspectedAtStep: event.suspectedAtStep,
        });
        return;
      case 'auth-segment':
        this.events.publish(sessionId, {
          type: 'recording.auth_segment',
          state: event.state,
          checkpointId: event.checkpoint.id,
        });
        return;
      case 'closed':
        // User closed the browser window mid-recording: stop and persist what
        // we have rather than losing the session.
        if (event.reason === 'browser-closed') {
          void this.stop(sessionId).catch(async () => {
            this.workers.release(sessionId);
            await this.store.patch(sessionId, { status: 'interrupted' });
            this.events.publish(sessionId, { type: 'session.status', status: 'interrupted' });
          });
        }
        return;
    }
  }

  /** Deep-validate a previous session's saved login before seeding a new one. */
  private async validateReusableState(fromSessionId: string, targetUrl: string): Promise<string> {
    const source = await this.store.get(fromSessionId);
    if (!source) throw new NotFoundException(`Unknown session ${fromSessionId}`);
    if (!source.hasStorageState) {
      throw new BadRequestException(`Session ${fromSessionId} has no saved login state`);
    }
    const storageStatePath = path.join(this.store.sessionDir(fromSessionId), 'storageState.json');
    const authConfig = await this.engine.loadAuthDomainsConfig(
      path.resolve(this.env.AUTH_DOMAINS_CONFIG),
    );
    const verdict = await this.engine.validateStorageState({
      storageStatePath,
      probeUrl: targetUrl,
      isAuthUrl: (url: string) => this.engine.isAuthUrl(url, authConfig),
    });
    if (!verdict.ok) {
      throw new ConflictException(
        `Saved login from ${fromSessionId} failed validation: ${verdict.reason ?? 'unknown'}`,
      );
    }
    return storageStatePath;
  }

  private requireRecording(sessionId: string): Extract<SessionWorker, { kind: 'recording' }> {
    const worker = this.workers.get(sessionId);
    if (!worker || worker.kind !== 'recording') {
      throw new ConflictException(`Session ${sessionId} has no live recording`);
    }
    return worker;
  }
}
