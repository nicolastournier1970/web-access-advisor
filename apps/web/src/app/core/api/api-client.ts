/**
 * The ONLY HTTP surface of the Angular app (docs/rewrite-plan.md §4).
 *
 * Implementation choice: a thin typed wrapper over `fetch` rather than
 * Angular's HttpClient — every call site is promise-based (signal stores),
 * no interceptors are needed, and a fake `fetch` makes the boundary trivially
 * unit-testable. Injected via the FETCH token so tests can swap it.
 *
 * Boundary rules (ADR 0004 + rewrite-plan client rule):
 *  - every 2xx response body is parsed with the matching @waa/shared schema;
 *  - every non-2xx body is parsed with `errorResponseSchema` and rethrown as
 *    a typed {@link ApiError};
 *  - `null`/`undefined` fields are stripped from request bodies before
 *    serializing (zod defaults absorb only ABSENT keys, not null).
 */
import { Injectable, InjectionToken, inject } from '@angular/core';
import { z } from 'zod';
import {
  analysisResultSchema,
  cancelReplayAuthResponseSchema,
  continueReplayAuthResponseSchema,
  deleteSessionResponseSchema,
  endAuthSegmentResponseSchema,
  errorResponseSchema,
  findStorageStateResponseSchema,
  listBrowsersResponseSchema,
  listSessionsResponseSchema,
  profileProbeRequestSchema,
  profileProbeResponseSchema,
  sessionSummarySchema,
  startAnalysisRequestSchema,
  startAnalysisResponseSchema,
  startAuthSegmentRequestSchema,
  startAuthSegmentResponseSchema,
  startRecordingRequestSchema,
  startRecordingResponseSchema,
  stopRecordingResponseSchema,
  storageStateStatusResponseSchema,
  settingsResponseSchema,
  updateSettingsRequestSchema,
  type AnalysisResult,
  type CancelReplayAuthResponse,
  type ContinueReplayAuthResponse,
  type DeleteSessionResponse,
  type EndAuthSegmentResponse,
  type ErrorResponse,
  type FindStorageStateResponse,
  type ListBrowsersResponse,
  type ListSessionsResponse,
  type ProfileProbeResponse,
  type SessionSummary,
  type StartAnalysisResponse,
  type StartAuthSegmentResponse,
  type StartRecordingResponse,
  type StopRecordingResponse,
  type StorageStateStatusResponse,
  type SettingsResponse,
} from '@waa/shared';

/** Request payloads are typed as schema INPUT (defaults applied server-side). */
export type StartRecordingRequestInput = z.input<typeof startRecordingRequestSchema>;
export type StartAuthSegmentRequestInput = z.input<typeof startAuthSegmentRequestSchema>;
export type ProfileProbeRequestInput = z.input<typeof profileProbeRequestSchema>;
export type StartAnalysisRequestInput = z.input<typeof startAnalysisRequestSchema>;
export type UpdateSettingsRequestInput = z.input<typeof updateSettingsRequestSchema>;

/** Injectable fetch so unit tests can provide a fake. */
export const FETCH = new InjectionToken<typeof fetch>('FETCH', {
  providedIn: 'root',
  factory: () => globalThis.fetch.bind(globalThis),
});

/** Typed error thrown for every non-2xx API response. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    /** Short error name from the envelope, e.g. "Not Found", "Conflict". */
    readonly errorName: string,
    message: string,
    /** zod issues for 400 validation failures. */
    readonly details?: ErrorResponse['details'],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Drop null/undefined values (top level — all request DTOs are flat). */
function stripNullish(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(body).filter(([, value]) => value !== null && value !== undefined),
  );
}

function toApiError(status: number, body: unknown): ApiError {
  const parsed = errorResponseSchema.safeParse(body);
  if (parsed.success) {
    const { error, message, details } = parsed.data;
    const text = Array.isArray(message) ? message.join('; ') : message;
    return new ApiError(status, error, text || error || `HTTP ${status}`, details);
  }
  return new ApiError(status, `HTTP ${status}`, typeof body === 'string' && body ? body : `HTTP ${status}`);
}

@Injectable({ providedIn: 'root' })
export class ApiClient {
  private readonly fetchImpl = inject(FETCH);

  // ---- Sessions ----

  listSessions(): Promise<ListSessionsResponse> {
    return this.request(listSessionsResponseSchema, 'GET', '/sessions');
  }

  getSession(id: string): Promise<SessionSummary> {
    return this.request(sessionSummarySchema, 'GET', `/sessions/${encodeURIComponent(id)}`);
  }

  deleteSession(id: string): Promise<DeleteSessionResponse> {
    return this.request(deleteSessionResponseSchema, 'DELETE', `/sessions/${encodeURIComponent(id)}`);
  }

  // ---- Recording ----

  startRecording(body: StartRecordingRequestInput): Promise<StartRecordingResponse> {
    return this.request(startRecordingResponseSchema, 'POST', '/sessions', body);
  }

  stopRecording(id: string): Promise<StopRecordingResponse> {
    return this.request(
      stopRecordingResponseSchema,
      'POST',
      `/sessions/${encodeURIComponent(id)}/recording/stop`,
    );
  }

  startAuthSegment(
    id: string,
    body: StartAuthSegmentRequestInput = {},
  ): Promise<StartAuthSegmentResponse> {
    return this.request(
      startAuthSegmentResponseSchema,
      'POST',
      `/sessions/${encodeURIComponent(id)}/recording/auth/start`,
      body,
    );
  }

  endAuthSegment(id: string): Promise<EndAuthSegmentResponse> {
    return this.request(
      endAuthSegmentResponseSchema,
      'POST',
      `/sessions/${encodeURIComponent(id)}/recording/auth/end`,
    );
  }

  // ---- Analysis (POST is 202; progress streams over SSE) ----

  startAnalysis(id: string, body: StartAnalysisRequestInput = {}): Promise<StartAnalysisResponse> {
    return this.request(
      startAnalysisResponseSchema,
      'POST',
      `/sessions/${encodeURIComponent(id)}/analysis`,
      body,
    );
  }

  getAnalysis(id: string): Promise<AnalysisResult> {
    return this.request(analysisResultSchema, 'GET', `/sessions/${encodeURIComponent(id)}/analysis`);
  }

  // ---- Replay pause-for-login (acts on the replay embedded in the analysis) ----

  continueReplayAuth(id: string): Promise<ContinueReplayAuthResponse> {
    return this.request(
      continueReplayAuthResponseSchema,
      'POST',
      `/sessions/${encodeURIComponent(id)}/replay/auth/continue`,
    );
  }

  cancelReplayAuth(id: string): Promise<CancelReplayAuthResponse> {
    return this.request(
      cancelReplayAuthResponseSchema,
      'POST',
      `/sessions/${encodeURIComponent(id)}/replay/auth/cancel`,
    );
  }

  // ---- Browsers ----

  listBrowsers(): Promise<ListBrowsersResponse> {
    return this.request(listBrowsersResponseSchema, 'GET', '/browsers');
  }

  profileProbe(body: ProfileProbeRequestInput): Promise<ProfileProbeResponse> {
    return this.request(profileProbeResponseSchema, 'POST', '/browsers/profile-probe', body);
  }

  // ---- Storage state (saved logins) ----

  getStorageStateStatus(id: string): Promise<StorageStateStatusResponse> {
    return this.request(
      storageStateStatusResponseSchema,
      'GET',
      `/sessions/${encodeURIComponent(id)}/storage-state/status`,
    );
  }

  findStorageState(url: string): Promise<FindStorageStateResponse> {
    return this.request(
      findStorageStateResponseSchema,
      'GET',
      `/storage-state/find?url=${encodeURIComponent(url)}`,
    );
  }

  // ---- Settings (runtime LLM provider + keys) ----

  getSettings(): Promise<SettingsResponse> {
    return this.request(settingsResponseSchema, 'GET', '/settings');
  }

  updateSettings(body: UpdateSettingsRequestInput): Promise<SettingsResponse> {
    return this.request(settingsResponseSchema, 'PUT', '/settings', body);
  }

  // ---- Plumbing ----

  private async request<T>(
    schema: z.ZodType<T>,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(stripNullish(body));
    }
    const response = await this.fetchImpl(`/api${path}`, init);
    const text = await response.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (!response.ok) {
      throw toApiError(response.status, json ?? text);
    }
    return schema.parse(json);
  }
}
