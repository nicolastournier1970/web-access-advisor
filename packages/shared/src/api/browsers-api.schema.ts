/**
 * Browser detection DTOs.
 *  GET  /api/browsers                — installed browsers + profile availability
 *  POST /api/browsers/profile-probe  — can the profile actually be launched?
 */
import { z } from 'zod';
import { browserTypeSchema } from './recording-api.schema.js';

export const browserOptionSchema = z.object({
  type: browserTypeSchema,
  /** Display name, e.g. "Microsoft Edge", "Google Chrome", "Firefox". */
  name: z.string(),
  available: z.boolean(),
  profilePath: z.string().optional(),
  profileSupported: z.boolean().default(false),
});
export type BrowserOption = z.infer<typeof browserOptionSchema>;

export const listBrowsersResponseSchema = z.object({
  browsers: z.array(browserOptionSchema),
});
export type ListBrowsersResponse = z.infer<typeof listBrowsersResponseSchema>;

export const profileProbeRequestSchema = z.object({
  browserType: browserTypeSchema,
  browserName: z.string(),
});
export type ProfileProbeRequest = z.infer<typeof profileProbeRequestSchema>;

export const profileProbeStatusSchema = z.enum(['usable', 'locked', 'no_profile', 'error']);
export type ProfileProbeStatus = z.infer<typeof profileProbeStatusSchema>;

export const profileProbeResponseSchema = z.object({
  status: profileProbeStatusSchema,
  message: z.string(),
});
export type ProfileProbeResponse = z.infer<typeof profileProbeResponseSchema>;
