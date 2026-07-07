/**
 * Session listing/detail DTOs (GET /api/sessions, GET /api/sessions/:id).
 * The session index is disk-backed (snapshots/index.json) so it survives API
 * restarts; sessions that were live when the process died are `interrupted`.
 */
import { z } from 'zod';

export const sessionStatusSchema = z.enum([
  'recording',
  'recorded',
  'replaying',
  'awaiting-auth',
  'analyzing',
  'analyzed',
  'failed',
  'interrupted',
]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const sessionSummarySchema = z.object({
  sessionId: z.string(),
  name: z.string().optional(),
  url: z.string(),
  status: sessionStatusSchema,
  startTime: z.string(),
  endTime: z.string().optional(),
  actionCount: z.number().int().min(0).default(0),
  authCheckpointCount: z.number().int().min(0).default(0),
  hasStorageState: z.boolean().default(false),
  hasAnalysis: z.boolean().default(false),
  recordingFormatVersion: z.union([z.literal(1), z.literal(2)]).default(1),
  browserType: z.string().optional(),
  browserName: z.string().optional(),
  useProfile: z.boolean().optional(),
});
export type SessionSummary = z.infer<typeof sessionSummarySchema>;

export const listSessionsResponseSchema = z.object({
  sessions: z.array(sessionSummarySchema),
});
export type ListSessionsResponse = z.infer<typeof listSessionsResponseSchema>;

export const deleteSessionResponseSchema = z.object({
  sessionId: z.string(),
  deleted: z.boolean(),
});
export type DeleteSessionResponse = z.infer<typeof deleteSessionResponseSchema>;
