/**
 * Analysis lifecycle DTOs.
 *  POST /api/sessions/:id/analysis               — start (202, progress over SSE)
 *  GET  /api/sessions/:id/analysis               — final result
 *  POST /api/sessions/:id/replay/auth/continue   — user finished logging in
 *  POST /api/sessions/:id/replay/auth/cancel     — abort the paused replay
 *
 * There is deliberately NO standalone replay endpoint: replay only ever runs
 * as the first stage of an analysis. The auth continue/cancel routes act on
 * the replay embedded in the running analysis.
 */
import { z } from 'zod';
import { analysisPhaseSchema, staticSectionModeSchema } from '../analysis/analysis.schema.js';
import { llmProviderChoiceSchema } from '../llm/provider.schema.js';

export const startAnalysisRequestSchema = z.object({
  staticSectionMode: staticSectionModeSchema.default('separate'),
  captureScreenshots: z.boolean().default(true),
  /** Overrides the env/settings-selected provider; 'stub' is used by tests/CI, 'none' disables AI. */
  llmProvider: llmProviderChoiceSchema.optional(),
});
export type StartAnalysisRequest = z.infer<typeof startAnalysisRequestSchema>;

export const startAnalysisResponseSchema = z.object({
  sessionId: z.string(),
  analysisId: z.string(),
  status: z.literal('analyzing'),
  phase: analysisPhaseSchema,
});
export type StartAnalysisResponse = z.infer<typeof startAnalysisResponseSchema>;

/** Replay pause-for-login state, mirrored by the auth-checkpoint machine. */
export const replayAuthStateSchema = z.enum([
  'running',
  'auth_required',
  'validating',
  'resuming',
  'auth_failed',
  'cancelled',
  'timed_out',
]);
export type ReplayAuthState = z.infer<typeof replayAuthStateSchema>;

export const continueReplayAuthResponseSchema = z.object({
  sessionId: z.string(),
  state: replayAuthStateSchema,
  /** Present when validation failed and the replay stays paused. */
  reason: z.string().optional(),
});
export type ContinueReplayAuthResponse = z.infer<typeof continueReplayAuthResponseSchema>;

export const cancelReplayAuthResponseSchema = z.object({
  sessionId: z.string(),
  state: replayAuthStateSchema,
});
export type CancelReplayAuthResponse = z.infer<typeof cancelReplayAuthResponseSchema>;
