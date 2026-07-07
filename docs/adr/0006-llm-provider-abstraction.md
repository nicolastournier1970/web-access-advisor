# ADR 0006: LLM provider abstraction

- **Status**: Accepted (2026-07-07)

## Context

v1 hardwired Google Gemini (`gemini-2.0-flash`) into the engine, and its proxy support **monkey-patched `globalThis.fetch`** around each API call — not concurrency-safe (it worked only because batches happened to run sequentially). Tests and CI had no way to run analysis without a live API key.

## Decision

- Define an `LlmProvider` interface in `@waa/core` (`llm/provider.ts`): `analyzeBatch(...)`, `consolidate(...)`, `name`.
- `GeminiProvider` implements it using a per-client undici `ProxyAgent`/`Agent` dispatcher (honouring `HTTPS_PROXY`), removing the global fetch patch.
- `StubProvider` returns canned, schema-valid responses for unit tests, e2e, and CI (`LLM_PROVIDER=stub`).
- The NestJS `llm` module selects the provider from validated env config and injects it into analysis.

## Consequences

- Analysis is testable offline and in CI; axe-only runs no longer require touching LLM code paths.
- Adding another provider (e.g. Claude, OpenAI) is a new class + env value, not an engine change.
- Prompt builders and HTML/axe slimming remain provider-neutral modules (`llm/prompts.ts`, `llm/slimming.ts`).
