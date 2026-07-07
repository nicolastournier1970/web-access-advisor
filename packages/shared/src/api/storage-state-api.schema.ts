/**
 * Storage-state (saved login) DTOs.
 *  GET  /api/sessions/:id/storage-state/status    — shallow file/expiry check
 *  POST /api/sessions/:id/storage-state/validate  — behavioural probe
 *  GET  /api/storage-state/find?url=              — validated cross-session reuse
 *
 * Values (cookies/tokens) are never returned by any endpoint; these DTOs are
 * metadata only.
 */
import { z } from 'zod';

export const storageStateStatusResponseSchema = z.object({
  sessionId: z.string(),
  present: z.boolean(),
  /** Null when only session-cookies exist (no expiry recorded). */
  expired: z.boolean().nullable(),
  earliestExpiry: z.string().nullable(),
  message: z.string(),
});
export type StorageStateStatusResponse = z.infer<typeof storageStateStatusResponseSchema>;

export const validateStorageStateRequestSchema = z.object({
  probeUrl: z.url({ protocol: /^https?$/ }).optional(),
  successSelector: z.string().optional(),
  timeoutMs: z.number().int().positive().max(120_000).optional(),
});
export type ValidateStorageStateRequest = z.infer<typeof validateStorageStateRequestSchema>;

export const validateStorageStateResponseSchema = z.object({
  sessionId: z.string(),
  ok: z.boolean(),
  elapsedMs: z.number().optional(),
  reason: z.string().optional(),
  earliestExpiry: z.string().nullable().optional(),
});
export type ValidateStorageStateResponse = z.infer<typeof validateStorageStateResponseSchema>;

export const findStorageStateQuerySchema = z.object({
  url: z.url({ protocol: /^https?$/ }),
});
export type FindStorageStateQuery = z.infer<typeof findStorageStateQuerySchema>;

export const findStorageStateResponseSchema = z.object({
  /** Sessions whose saved login covers the target origin, newest first. */
  matches: z.array(
    z.object({
      sessionId: z.string(),
      url: z.string(),
      savedAt: z.string(),
      /** True when a behavioural probe confirmed the login is usable. */
      validated: z.boolean(),
    }),
  ),
});
export type FindStorageStateResponse = z.infer<typeof findStorageStateResponseSchema>;
