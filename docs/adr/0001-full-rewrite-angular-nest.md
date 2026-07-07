# ADR 0001: Full rewrite on Angular + NestJS

- **Status**: Accepted (2026-07-07)
- **Deciders**: Nicolas Tournier

## Context

The v1 implementation (React 18 + Vite frontend, Express server, `packages/core` engine) accumulated structural debt that made incremental improvement more expensive than a rewrite:

- A ~1,400-line `App.tsx` god component with no routing, manual `setInterval` polling, and promise-bridged modals.
- Two competing API client layers (one entirely dead), ~15 dead files, and types duplicated between `src/types` and `packages/core`.
- A single global analyzer and recording-service singleton (effectively single-user), with all server state in memory (lost on restart).
- Security gaps around authentication: plaintext credential capture, unencrypted session state, and three overlapping, partially broken re-login mechanisms.

## Decision

Rewrite the application end to end, in the same repository, on branch `rewrite/angular-nest`:

- **Frontend**: Angular (latest stable; standalone components, signals, zoneless change detection, OnPush, typed forms) in `apps/web`.
- **Backend**: NestJS in `apps/api`. Nest mirrors Angular's module/DI/decorator architecture, giving one mental model across the stack.
- **Engine**: the Playwright recording/replay/analysis engine is refactored into a clean library `@waa/core` (`packages/core`) with no HTTP framework imports.
- **Contracts**: a new `@waa/shared` package (`packages/shared`) is the single source of truth for API/SSE/file-format schemas (see ADR 0004).

The legacy app keeps running from `src/` + `server/` during the rewrite and is removed at cutover **on the rewrite branch only** (confirmed 2026-07-08): the pre-deletion commit is tagged `v1-legacy` and `main` retains the full v1 app, so nothing is lost from history.

## Consequences

- Higher up-front cost than incremental refactoring, paid back by a coherent, documented, testable codebase.
- Angular CDK gives first-party accessibility primitives for the tool's own UI (see ADR 0007).
- On-disk session data (`./snapshots/`) remains compatible via a versioned recording format (see ADR 0005).
