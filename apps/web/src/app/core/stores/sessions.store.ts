/**
 * Signal store for the session list (GET /api/sessions).
 * Plain class methods over the injected ApiClient — unit-testable without DOM.
 */
import { Injectable, computed, inject, signal } from '@angular/core';
import type { SessionSummary } from '@waa/shared';
import { ApiClient, ApiError } from '../api/api-client';

@Injectable({ providedIn: 'root' })
export class SessionsStore {
  private readonly api = inject(ApiClient);

  private readonly sessionsState = signal<SessionSummary[]>([]);
  private readonly loadingState = signal(false);
  private readonly errorState = signal<string | null>(null);

  readonly sessions = this.sessionsState.asReadonly();
  readonly loading = this.loadingState.asReadonly();
  readonly error = this.errorState.asReadonly();

  /** Last 5 sessions, newest first (setup page "recent sessions"). */
  readonly recent = computed(() =>
    [...this.sessionsState()]
      .sort((a, b) => b.startTime.localeCompare(a.startTime))
      .slice(0, 5),
  );

  async refresh(): Promise<void> {
    this.loadingState.set(true);
    this.errorState.set(null);
    try {
      const { sessions } = await this.api.listSessions();
      this.sessionsState.set(
        [...sessions].sort((a, b) => b.startTime.localeCompare(a.startTime)),
      );
    } catch (error) {
      this.errorState.set(error instanceof ApiError ? error.message : 'Failed to load sessions');
    } finally {
      this.loadingState.set(false);
    }
  }

  /** Delete on the server, then drop from the list. Throws ApiError on failure. */
  async remove(sessionId: string): Promise<void> {
    await this.api.deleteSession(sessionId);
    this.sessionsState.update((sessions) =>
      sessions.filter((session) => session.sessionId !== sessionId),
    );
  }
}
