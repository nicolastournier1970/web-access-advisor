/**
 * Schema for config/auth-domains.json — the user-editable domain patterns that
 * classify navigation as authentication-related. Replaces the client-specific
 * domain lists that v1 hardcoded inside the engine.
 */
import { z } from 'zod';

export const authDomainsConfigSchema = z.object({
  $schema: z.string().optional(),
  comment: z.string().optional(),
  /** Hostname substrings treated as identity providers (matched case-insensitively). */
  authDomains: z.array(z.string()).default([]),
  /** Hostnames of the application under test (classified main_app, never external_redirect). */
  clientDomains: z.array(z.string()).default([]),
  /** URL path fragments that indicate a login page on any domain. */
  authPathPatterns: z.array(z.string()).default([]),
});
export type AuthDomainsConfig = z.infer<typeof authDomainsConfigSchema>;
