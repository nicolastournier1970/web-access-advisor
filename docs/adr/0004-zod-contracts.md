# ADR 0004: Zod schemas in @waa/shared as the single source of truth

- **Status**: Accepted (2026-07-07)

## Context

v1 duplicated its data model between `src/types/index.ts` and `packages/core/src/types.ts`, and the two drifted (stale prop interfaces, `as any` smuggling of fields). The rewrite needs one contract definition consumed by three parties: NestJS request validation, the Angular client, and the engine's file formats. Candidates: Zod, TypeBox, or plain TypeScript interfaces.

## Decision

Define all contracts as **Zod (v4) schemas** in `packages/shared` (`@waa/shared`), which has zod as its only dependency. Consumers:

- **apps/api**: `nestjs-zod` `createZodDto` produces class DTOs for the global validation pipe and OpenAPI generation via `@nestjs/swagger`.
- **apps/web**: the API client and SSE client parse responses/events at the boundary, so malformed data fails loudly at the edge rather than deep in a component.
- **packages/core**: validates `recording.json` / `manifest.json` on load and enforces the v1→v2 upgrade path (ADR 0005).

## Rationale

- Runtime validation at every boundary plus inferred static types from one source kills the drift problem structurally.
- TypeBox's advantages (raw speed, native JSON Schema) are irrelevant at this scale; Zod's discriminated unions read naturally for the SSE envelope and auth-checkpoint states, and its ecosystem (nestjs-zod) covers the Nest integration.

## Consequences

- Plain interfaces are not written by hand anywhere; types are `z.infer<>` exports from `@waa/shared`.
- Schema changes are single-file changes reviewed once, and OpenAPI output (`docs/openapi.json`) tracks them automatically.
