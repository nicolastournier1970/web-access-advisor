/**
 * Error envelope for all non-2xx responses. Matches what NestJS exception
 * filters (and nestjs-zod's ZodValidationException) emit, so the Angular
 * api-client can parse every error body at the boundary.
 */
import { z } from 'zod';

export const errorResponseSchema = z
  .object({
    statusCode: z.number().int(),
    /** Short error name, e.g. "Bad Request", "Not Found", "Conflict". */
    error: z.string().default(''),
    message: z.union([z.string(), z.array(z.string())]).default(''),
    /** zod issues for 400 validation failures. */
    details: z
      .array(
        z
          .object({
            path: z.array(z.union([z.string(), z.number()])).default([]),
            message: z.string().default(''),
            code: z.string().optional(),
          })
          .catchall(z.unknown()),
      )
      .optional(),
  })
  .catchall(z.unknown());
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
