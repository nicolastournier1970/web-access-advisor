/** GET /api/health */
import { z } from 'zod';

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  version: z.string().optional(),
  uptimeSeconds: z.number().optional(),
  llmProvider: z.string().optional(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;
