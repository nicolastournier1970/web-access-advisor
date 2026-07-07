/**
 * Recording lifecycle DTOs.
 *  POST /api/sessions                       — start a recording
 *  POST /api/sessions/:id/recording/stop    — stop and persist
 *  POST /api/sessions/:id/recording/auth/start|end — mark a login segment
 *
 * Client note: optional/defaulted fields must be OMITTED when empty, not sent
 * as null — the API client strips null/undefined values before serializing.
 */
import { z } from 'zod';
import {
  actionV2Schema,
  authCheckpointReasonSchema,
  authCheckpointSchema,
  browserTypeSchema,
} from '../recording/recording.schema.js';
import { sessionStatusSchema } from './sessions-api.schema.js';

export { browserTypeSchema, type BrowserType } from '../recording/recording.schema.js';

export const startRecordingRequestSchema = z.object({
  /** http/https only — recording javascript:/file:/chrome: targets is forbidden. */
  url: z.url({ protocol: /^https?$/ }),
  browserType: browserTypeSchema.default('chromium'),
  /** Specific installed browser, e.g. "Microsoft Edge" — used for profile launch. */
  browserName: z.string().optional(),
  useProfile: z.boolean().default(false),
  name: z.string().max(200).optional(),
  /** Reuse a validated storage state saved by a previous session (by id). */
  reuseStorageStateFrom: z.string().optional(),
});
export type StartRecordingRequest = z.infer<typeof startRecordingRequestSchema>;

export const startRecordingResponseSchema = z.object({
  sessionId: z.string(),
  status: sessionStatusSchema,
  url: z.string(),
});
export type StartRecordingResponse = z.infer<typeof startRecordingResponseSchema>;

export const stopRecordingResponseSchema = z.object({
  sessionId: z.string(),
  status: sessionStatusSchema,
  actionCount: z.number().int().min(0),
  actions: z.array(actionV2Schema),
  authCheckpoints: z.array(authCheckpointSchema).default([]),
  storageStateSaved: z.boolean().default(false),
});
export type StopRecordingResponse = z.infer<typeof stopRecordingResponseSchema>;

export const startAuthSegmentRequestSchema = z.object({
  reason: authCheckpointReasonSchema.default('user-marked'),
  /**
   * Backdate the segment to start after this step — used when the user
   * confirms a `recording.auth_suspected` prompt and the triggering
   * navigation/actions must be retroactively folded into the segment.
   */
  fromStep: z.number().int().min(0).optional(),
});
export type StartAuthSegmentRequest = z.infer<typeof startAuthSegmentRequestSchema>;

export const startAuthSegmentResponseSchema = z.object({
  checkpointId: z.string(),
  /** Step after which this checkpoint sits (0 = before any recorded action). */
  afterStep: z.number().int().min(0),
  /** Number of already-recorded actions discarded by a retroactive start. */
  discardedActions: z.number().int().min(0).default(0),
});
export type StartAuthSegmentResponse = z.infer<typeof startAuthSegmentResponseSchema>;

export const endAuthSegmentResponseSchema = z.object({
  checkpointId: z.string(),
  storageStateSaved: z.boolean(),
  postLoginUrl: z.string().optional(),
});
export type EndAuthSegmentResponse = z.infer<typeof endAuthSegmentResponseSchema>;
