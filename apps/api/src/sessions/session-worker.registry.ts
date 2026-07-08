/**
 * Live per-session workers: the running Playwright resources behind a session.
 * Replaces the v1 global recorder/analyzer singletons — each session owns its
 * worker, multiple sessions can run concurrently, and graceful shutdown
 * closes every live browser.
 *
 * NOTE: concurrent recordings are allowed, but two profile-based recordings
 * of the same browser profile will conflict at launch (profile lock) — that
 * failure surfaces from the engine, not here.
 */
import { ConflictException, Injectable } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import type { ReplayAuthState } from '@waa/shared';
import type { AnalyzeControl, RecorderHandle } from '@waa/core';

export type SessionWorker =
  | { kind: 'recording'; recorder: RecorderHandle }
  | { kind: 'analysis'; control: AnalyzeControl; lastAuthState: ReplayAuthState };

@Injectable()
export class SessionWorkerRegistry implements OnApplicationShutdown {
  private readonly workers = new Map<string, SessionWorker>();

  /** One live worker per session: starting a second one is a 409. */
  register(sessionId: string, worker: SessionWorker): void {
    if (this.workers.has(sessionId)) {
      throw new ConflictException(
        `Session ${sessionId} already has a live ${this.workers.get(sessionId)!.kind} worker`,
      );
    }
    this.workers.set(sessionId, worker);
  }

  get(sessionId: string): SessionWorker | undefined {
    return this.workers.get(sessionId);
  }

  has(sessionId: string): boolean {
    return this.workers.has(sessionId);
  }

  release(sessionId: string): void {
    this.workers.delete(sessionId);
  }

  /** Best-effort cleanup of every live browser on shutdown (Ctrl+C, SIGTERM). */
  async onApplicationShutdown(): Promise<void> {
    const live = [...this.workers.entries()];
    this.workers.clear();
    await Promise.allSettled(
      live.map(async ([, worker]) => {
        if (worker.kind === 'recording') await worker.recorder.dispose();
        else await worker.control.cancelAuth();
      }),
    );
  }
}
