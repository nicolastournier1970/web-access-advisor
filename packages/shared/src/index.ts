/**
 * @waa/shared — single source of truth for Web Access Advisor contracts.
 *
 * Everything here is a zod schema plus its inferred type. Do not hand-write
 * parallel interfaces elsewhere; import from this package (see docs/adr/0004).
 */
export * from './recording/recording.schema.js';
export * from './manifest/manifest.schema.js';
export * from './analysis/analysis.schema.js';
export * from './llm/provider.schema.js';
export * from './api/sessions-api.schema.js';
export * from './api/recording-api.schema.js';
export * from './api/analysis-api.schema.js';
export * from './api/settings-api.schema.js';
export * from './api/browsers-api.schema.js';
export * from './api/storage-state-api.schema.js';
export * from './api/error-api.schema.js';
export * from './api/health-api.schema.js';
export * from './events/sse-events.schema.js';
export * from './config/auth-domains.schema.js';
