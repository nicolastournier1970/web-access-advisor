/**
 * SSE event catalog for GET /api/sessions/:id/events.
 *
 * Wire format: each SSE message's `id:` field carries a per-session monotonic
 * integer (used for Last-Event-ID replay against the server's ring buffer) and
 * its `data:` field is a JSON object matching `sseEventSchema`. The Angular
 * SseClient parses every message against this union at the boundary.
 */
import { z } from 'zod';
import { actionV2Schema } from '../recording/recording.schema.js';
import { analysisPhaseSchema } from '../analysis/analysis.schema.js';
import { replayAuthStateSchema } from '../api/analysis-api.schema.js';
import { sessionStatusSchema } from '../api/sessions-api.schema.js';

export const sseEventSchema = z.discriminatedUnion('type', [
  // ---- Recording ----
  z.object({
    type: z.literal('recording.action'),
    action: actionV2Schema,
    actionCount: z.number().int().min(0),
  }),
  z.object({
    type: z.literal('recording.navigated'),
    url: z.string(),
    step: z.number().int().optional(),
  }),
  /** The recorder suspects an unmarked login (auth domain / password field). */
  z.object({
    type: z.literal('recording.auth_suspected'),
    reason: z.enum(['auth-domain-navigation', 'password-field']),
    url: z.string(),
    /** Step of the triggering action — lets the UI start a segment retroactively. */
    suspectedAtStep: z.number().int().min(0),
  }),
  z.object({
    type: z.literal('recording.auth_segment'),
    state: z.enum(['started', 'ended']),
    checkpointId: z.string(),
  }),
  /**
   * Trust-critical degradation notice: the recording proceeds but WITHOUT the
   * user's saved logins (profile locked/missing, or saved login unreadable).
   * Silent fallback was the v1 failure class this event exists to kill.
   */
  z.object({
    type: z.literal('recording.warning'),
    message: z.string(),
    reason: z.enum(['profile-unavailable', 'storage-state-unavailable']),
  }),

  // ---- Analysis / replay progress ----
  z.object({
    type: z.literal('analysis.progress'),
    phase: analysisPhaseSchema,
    message: z.string(),
    currentStep: z.number().int().optional(),
    totalSteps: z.number().int().optional(),
    snapshotCount: z.number().int().optional(),
    batchCurrent: z.number().int().optional(),
    batchTotal: z.number().int().optional(),
  }),
  z.object({
    type: z.literal('analysis.complete'),
    analysisId: z.string(),
    snapshotCount: z.number().int(),
    warnings: z.array(z.string()).default([]),
  }),
  z.object({
    type: z.literal('analysis.error'),
    message: z.string(),
  }),

  // ---- Replay pause-for-login ----
  z.object({
    type: z.literal('replay.auth_required'),
    checkpointId: z.string().optional(),
    reason: z.enum(['recorded-checkpoint', 'auth-domain-navigation', 'login-wall-detected']),
    /** Always known: the recorded checkpoint URL or the live page URL at pause time. */
    loginUrl: z.string(),
    pausedAtStep: z.number().int(),
    timeoutAt: z.string(),
  }),
  z.object({ type: z.literal('replay.auth_validating') }),
  z.object({
    type: z.literal('replay.auth_resolved'),
    resumedAtStep: z.number().int(),
    storageStateSaved: z.boolean(),
  }),
  z.object({
    type: z.literal('replay.auth_failed'),
    reason: z.string(),
  }),
  z.object({
    type: z.literal('replay.auth_state'),
    state: replayAuthStateSchema,
  }),

  // ---- Session lifecycle ----
  z.object({
    type: z.literal('session.status'),
    status: sessionStatusSchema,
  }),
]);
export type SseEvent = z.infer<typeof sseEventSchema>;
export type SseEventType = SseEvent['type'];
