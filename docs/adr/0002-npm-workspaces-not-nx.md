# ADR 0002: Plain npm workspaces instead of Nx

- **Status**: Accepted (2026-07-07)

## Context

The rewrite needs a monorepo housing four projects: `apps/web` (Angular), `apps/api` (NestJS), `packages/core` (engine), `packages/shared` (contracts). Nx is the mainstream tool for Angular+Nest monorepos, offering generators, computation caching, `affected` builds, and enforced module boundaries.

## Decision

Use plain npm workspaces (the repo already uses them) with:

- `tsconfig.base.json` path aliases (`@waa/shared`, `@waa/core`) and TypeScript project references for build ordering.
- ESLint flat-config boundary rules: `apps/web` may import only `@waa/shared` (never `@waa/core` or Playwright); `packages/shared` depends on zod only; `packages/core` never imports HTTP frameworks.

## Rationale

- Solo developer, four projects: Nx's wins (caching, `affected`, generators) do not amortize; its costs (a tool to learn, Nx/Angular version lock-step, Windows daemon quirks) are pure overhead here.
- The chosen layout (`apps/*`, `packages/*`) is exactly what `nx init` adopts non-destructively, so Nx can be added later without restructuring.

## Consequences

- Build ordering is expressed via npm scripts + project references rather than a task graph; acceptable at this scale.
- No generators; new modules are created by hand following documented conventions (`docs/development.md`).
